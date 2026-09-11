/**
 * The chat↔agent bridge: one Agent per QQ chat, inbound message pipeline
 * (policy → parse → media → STT → quote/forward expansion → followup),
 * outbound delivery driven by session events (assistant/message, turn/end),
 * typing indicator, per-chat send ordering, and chat→session mapping
 * persistence for restart resume. Ported from the Hermes OneBotAdapter
 * gateway-interaction half onto the dsh headless-runner agent pattern.
 * @module dsh-onebot/bridge
 */

import type { Agent, AgentRegistry, AgentSetup, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { OneBotConnection, OneBotEvent } from './connection.js'
import type { MediaStore } from './media.js'
import { extForInboundName } from './media.js'
import type { Transcriber } from './stt.js'
import { transcriptLabel } from './stt.js'
import type { OneBotSegment, MediaRef } from './cq.js'
import { cqUnescape, detectMention, parseMessage, segmentText } from './cq.js'
import type { ChatId, UserRole } from './chat.js'
import {
  buildChatId, buildGroupMessagePrefix, classifyUserRole, dmAllowed, groupAllowed,
  RESTRICTED_PREFIX, sanitizeNickname, sessionIdForChat, splitChatId,
} from './chat.js'
import type { AccessPolicyConfig } from './chat.js'
import { renderTextImage } from './t2i/index.js'
import { buildPlatformPrompt } from './prompt.js'
import { registerTools } from './tools.js'
import { tryHandleCommand as routeCommand, type CommandContext } from './commands.js'
import { relayHostCards as relayCards, type CardRelayContext } from './card-relay.js'
import { OutboundPipeline } from './outbound.js'
import type { OutboundSegment, SendOptions } from './outbound.js'

/** Resolved runtime configuration for the bridge. */
export interface BridgeConfig {
  botQQ: string
  ignoreSelf: boolean
  splitLength: number
  requireMention: boolean
  interimMessages: boolean
  /** Per-interim auto-recall delay (ms) from each interim's send completion
   * while the turn is still running (QQ recall window ~2 min); absent → 90s.
   * At turn/end the remaining originals are recalled immediately regardless. */
  interimRecallMs?: number
  sendErrorNotice: boolean
  /** B7: per-chat per-minute sliding-window cap for normal (non-command)
   * messages; absent → 30, 0 disables. */
  rateLimitPerMinute?: number
  restrictedMemberPrefix: boolean
  sensitivePatterns: readonly string[]
  mediaDir: string
  maxImageBytes: number
  maxVoiceBytes: number
  maxFileBytes: number
  textImageThreshold: number
  cardFooter: string
  fontFiles: readonly string[]
  fontFamilies: readonly string[]
  agentPreset: string
  workspacePath: string
  /** Max inbound file bytes fetched via QQ direct link / base64 (0 = no cap). */
  maxInboundFileBytes: number
}

/** Agent-preset service (dsh-agent-presets): joins agents to a preset composition. */
export interface AgentPresetsLike {
  /** The preset id a new session gets when none is named (deployment default). */
  readonly defaultId: string
  /** Resolve one preset by id (undefined = default); throws when no root supplies it. */
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: unknown, id?: string): Promise<{ id: string }>
}

/** Durable session persistence (dsh-session-persistence): cold-read what a session recorded. */
export interface SessionPersistenceLike {
  inspect(id: SessionId, signal?: AbortSignal): Promise<{
    meta: { agentPreset?: string }
    events: readonly { type?: string; data?: { agentPreset?: string } }[]
  }>
}

/** The preset id a session's own record names: newest logged selection, else the creation header. */
export function resolveRecordedPreset(
  inspection: { meta: { agentPreset?: string }; events: readonly { type?: string; data?: { agentPreset?: string } }[] },
): string | undefined {
  const events = inspection.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
      return event.data.agentPreset
    }
  }
  return inspection.meta.agentPreset
}

/** Workspace registry (dsh-workspace): durable workspace membership. */
export interface WorkspaceLike {
  id: string
  path: string
  sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<void>
}

/** Workspace registry (dsh-workspace): durable workspace membership. */
export interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  create(path: string, title?: string): Promise<WorkspaceLike>
  list(): WorkspaceLike[]
}

/** Default model service (dsh-agent-default-model): read/save the default selection. */
export interface AgentDefaultModelLike {
  currentSelection(): ModelSelection | undefined
  saveSelection(next: ModelSelection): Promise<void>
}

/** Services the bridge needs (subset of the plugin Context). */
export interface BridgeDeps {
  ctx: Context
  connection: OneBotConnection
  /** The dsh data home (default <home>/.dsh); used to enumerate agent presets. */
  dshHome?: string | undefined
  media: MediaStore
  transcriber: Transcriber
  agents: AgentRegistry
  sessions: SessionStore
  agentPresets: AgentPresetsLike
  /** Host command runtime: forwards /plan so QQ reaches the native plan command.
   * `signal` is REQUIRED by the host implementation (it reads `signal.aborted`
   * unconditionally) — pass a fresh never-aborted one. */
  commands?: { execute(agent: unknown, line: string, signal: AbortSignal): Promise<{ kind?: string; text?: string; result?: { kind?: string; text?: string } }> } | undefined
  /** Durable persistence for cold-reading a session's recorded preset; absent = config/default fallback. */
  sessionPersistence: SessionPersistenceLike | undefined
  workspaceRegistry: WorkspaceRegistryLike
  agentDefaultModel: AgentDefaultModelLike | undefined
  defaultModel: (() => ModelSelection | undefined) | undefined
  config: BridgeConfig
  policy: AccessPolicyConfig
  /** Log line callback (level, message). */
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
}

/** One live per-chat agent. */
interface ChatAgent {
  chatId: ChatId
  sessionId: SessionId
  agent: Agent
  dispose(): Promise<void>
  /** Per-chat send chain (preserves outbound order). */
  queue: Promise<unknown>
  /** Buffered last-step text when interimMessages is off. */
  pendingFinal: string
  /** Loop merge (interimMessages on): text deferred one step, awaiting the
   * next assistant/message to prove it interim — the last one is the final. */
  loopPending: string | null
  /** Sent interim messages awaiting turn/end summary (text kept for the recap
   * t2i card). `sentAt` drives the per-message auto-recall scheduled after
   * each interim's send completes. */
  loopBuffer: Array<{ id: string; text: string; sentAt: number }>
  /** Per-interim 90s (config interimRecallMs) auto-recall timers, keyed by
   * message id; cleared when turn/end recalls the originals immediately. */
  recallTimers: Map<string, ReturnType<typeof setTimeout>>
  /** Interim message ids already auto-revoked by their 90s timer during a long
   * turn — skipped by the turn/end immediate recall (already gone from QQ). */
  recalledInterimIds: Set<string>
  /** Last assistant message id already handled — duplicate session events
   * (streaming/usage re-emits of the same message) must not re-send it. */
  lastHandledMessageId: string | undefined
  /** Whether a turn is currently generating. */
  busy: boolean
  /** B7: dispatch timestamps of normal (non-command) messages inside the
   * current 60s sliding window (rateLimitPerMinute). */
  dispatchTimes: number[]
  /** B7: when the last rate-limit notice was sent (at most one per window). */
  rateLimitNoticeAt: number | undefined
  typingTimer: ReturnType<typeof setInterval> | undefined
  lastNickname: string
  /** Roles of dispatched turns not yet opened (FIFO, consumed at turn/start). */
  pendingTurnRoles: UserRole[]
  /** Role of the currently running turn; stays 'member' (fail-closed) until a
   * turn/start assigns the head of pendingTurnRoles. */
  activeTurnRole: UserRole
  /** The last user message text actually fed to the agent (for /retry). */
  lastFollowup: string | undefined
  /** Mutable per-agent model selection (installModelSelection-bound); the
   * /model command swaps `.current` for the next step. */
  selectionRef: ModelSelectionRef | undefined
}

/** The mapping file name inside the media dir. */
const MAPPING_FILE = 'chat-sessions.json'
/** The retired-session-id file name inside the media dir (append-only). */
const RETIRED_FILE = 'retired-sessions.json'
/** Spacing between recall delete_msg calls (NapCat recallMsg is slow; bursting
 * them pushes borderline-late recalls over the server timeout). */
const RECALL_SPACING_MS = 60

/**
 * Bridge between OneBot events and dsh agents. Create via the constructor and
 * call start() from the plugin's effect; call stop() on disposal.
 */
export class ChatBridge {
  private readonly deps: BridgeDeps
  /** Outbound pipeline (D1-PR2): the same-name bridge methods below delegate here. */
  private readonly outbound: OutboundPipeline
  private readonly chats = new Map<ChatId, ChatAgent>()
  private readonly bySession = new Map<string, ChatId>()
  /** Session-feed listener disposers (freed on stop, so plugin reload/HMR cannot accumulate duplicates). */
  private sessionEventOff: (() => void) | undefined
  private sessionFlushOff: (() => void) | undefined
  /** Per-chat workspace override set by /workspace (survives /new resets,
   * so the next agent for the chat is created under the new directory). */
  private readonly chatWorkspacePaths = new Map<ChatId, string>()
  /** Per-chat agent-preset override set by /preset (survives /new resets). */
  private readonly chatPresetOverrides = new Map<ChatId, string>()
  /** Per-chat outbound-mode override set by /mode (true=interim, false=instant);
   * undefined defers to the global config. */
  private readonly chatInterimOverrides = new Map<ChatId, boolean>()
  /** Per-chat FIFO of model final replies parked while disconnected; drained
   * oldest-first on reconnect (M1-B6). */
  private readonly pendingSends = new Map<ChatId, Array<{ text: string; sentAt: number }>>()
  /** Per-chat goal set by /goal (reminds the model of the objective each turn). */
  private readonly chatGoals = new Map<ChatId, string>()
  /** Per-chat most recent inbound image path (for /ocr), survives /new resets. */
  private readonly chatLastImagePaths = new Map<ChatId, string>()
  /** C6a: most recent inbound image ref per chat, registered before command
   * routing so /ocr can resolve it lazily when the message carried a command. */
  private readonly chatPendingImageRefs = new Map<ChatId, MediaRef>()
  /** Plugin version + git commit, read once for /ver. */
  private pluginVersion: string | undefined
  private pluginCommit: string | undefined
  private stopping = false
  private mappingSaveTimer: ReturnType<typeof setTimeout> | undefined
  /** Resolves once the on-disk chat mapping has been loaded. */
  private mappingLoaded: Promise<void> = Promise.resolve()
  /** Session ids whose persisted logs are unusable; creates must avoid them. */
  private readonly brokenSessions = new Set<string>()
  /** Session ids retired across restarts (durable copy of brokenSessions). */
  private retiredSessionIds = new Set<string>()

  constructor(deps: BridgeDeps) {
    this.deps = deps
    this.outbound = new OutboundPipeline({
      getChat: chatId => this.chats.get(chatId),
      connected: () => this.deps.connection.connected,
      selfId: () => this.deps.connection.selfId,
      call: (action, params) => this.deps.connection.call(action, params),
      isStopping: () => this.stopping,
      log: (level, message) => this.deps.log(level, message),
      config: deps.config,
    })
  }

  /** Start listening: wire connection handlers and the session event feed. */
  start(): void {
    const { connection, ctx } = this.deps
    connection.selfId = this.deps.config.botQQ
    this.sessionEventOff = ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.onSessionEvent(session, event)
    })
    this.sessionFlushOff = ctx.on('session/flush', (session: Session) => {
      void this.onSessionFlush(session)
    })
    connection.onStatus = (connected: boolean) => {
      this.deps.log(connected ? 'info' : 'warn', 'OneBot ' + (connected ? 'connected' : 'disconnected'))
      if (connected) this.outbound.drainPendingSends()
    }
    this.mappingLoaded = this.ready().then(async () => {
      await this.loadRetired()
      await this.loadMapping()
    }).then(() => {
      if (this.stopping) return
      this.deps.log('info', 'bridge ready (' + this.chats.size + ' resumed chat(s))')
    })
  }

  /** Stop everything: dispose agents, save mapping, cancel timers. */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.sessionEventOff !== undefined) {
      this.sessionEventOff()
      this.sessionEventOff = undefined
    }
    if (this.sessionFlushOff !== undefined) {
      this.sessionFlushOff()
      this.sessionFlushOff = undefined
    }
    if (this.mappingSaveTimer !== undefined) {
      clearTimeout(this.mappingSaveTimer)
      this.mappingSaveTimer = undefined
    }
    await this.saveMapping()
    for (const chat of this.chats.values()) {
      this.stopTyping(chat)
      this.clearInterimTimers(chat)
      try {
        await chat.dispose()
      } catch (error) {
        this.deps.log('warn', 'agent dispose failed: ' + String(error))
      }
    }
    this.chats.clear()
    this.bySession.clear()
  }

  /** Map an agent session id back to its chat (for model tools). */
  chatForSession(sessionId: string): ChatId | undefined {
    return this.bySession.get(sessionId)
  }

  /** Whether a caller backing an agent session may perform file edits. QQ chats
   * require the currently running turn's initiator to be an admin (role frozen
   * from the dispatch queue at turn/start); non-QQ sessions (Web and other
   * channels) are trusted by default (A1 scoping). Unknown states fail closed
   * as member. */
  canEditFiles(sessionId: string): boolean {
    const chatId = this.bySession.get(sessionId)
    if (chatId === undefined) return true
    return this.chats.get(chatId)?.activeTurnRole === 'admin'
  }

  /**
   * Outbound media fence roots for one agent session's current turn (M1-A3b):
   * the plugin media dir always, plus the chat's workspace directory when the
   * running turn's initiator is an admin. The role reuses the M1-A2 turn-level
   * semantics (canEditFiles: frozen at turn/start, fail-closed member); a
   * session with no known chat stays mediaDir-only even though canEditFiles
   * would trust it — the media gate itself fails closed. Roots are
   * realpath-normalized here; the MediaStore fence re-checks containment
   * (the double check is harmless).
   */
  async mediaSendRoots(sessionId: string | undefined): Promise<{ roots: string[]; isTurnAdmin: boolean }> {
    const isTurnAdmin = sessionId !== undefined && this.canEditFiles(sessionId)
    const chatId = sessionId !== undefined ? this.bySession.get(sessionId) : undefined
    const candidates = [this.deps.config.mediaDir]
    if (chatId !== undefined && isTurnAdmin) candidates.push(this.effectiveCwd(chatId))
    const roots: string[] = []
    for (const root of candidates) {
      try {
        roots.push(await realpath(root))
      } catch {
        roots.push(root) // missing root: kept as-is; the fence skips it (cannot contain anything)
      }
    }
    return { roots, isTurnAdmin }
  }

  /** Whether the connection is usable for sends. */
  get connected(): boolean {
    return this.deps.connection.connected
  }

  /**
   * Send plain text to a chat with the full outbound pipeline (forward
   * blocks, Markdown strip, sentence splitting).
   * @param chatId - target chat.
   * @param text - model-produced text.
   * @param options - optional reply target.
   * @returns the sent message ids.
   */
  sendToChat(chatId: ChatId, text: string, options: SendOptions = {}): Promise<string[]> {
    return this.outbound.sendToChat(chatId, text, options)
  }

  /**
   * Send raw OneBot segments (used by the media tools).
   * @param chatId - target chat.
   * @param segments - outbound segments.
   * @returns the sent message id.
   */
  sendSegments(chatId: ChatId, segments: OutboundSegment[]): Promise<string | undefined> {
    return this.outbound.sendSegments(chatId, segments)
  }

  /**
   * Wait for the loader's complete application (model selection, settings,
   * persistence) before reading the default model — the same gate the
   * headless runner uses, so the pinned selection is never a half-loaded
   * default.
   */
  private async ready(): Promise<void> {
    try {
      const loader = this.deps.ctx.get('loader') as { await(): Promise<void> } | undefined
      await loader?.await()
    } catch (error) {
      this.deps.log('debug', 'loader.await failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  // ------------------------------------------------------------ inbound

  /**
   * Inbound OneBot message event → agent turn. All policy and media work is
   * contained: a failure here logs and drops the message, never the host.
   */
  async handleInbound(event: OneBotEvent): Promise<void> {
    if (this.stopping) return
    try {
      await this.processInbound(event)
    } catch (error) {
      this.deps.log('error', 'inbound handling failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  private async processInbound(event: OneBotEvent): Promise<void> {
    const messageType = event.message_type
    if (messageType !== 'private' && messageType !== 'group') return
    const userId = String(event.user_id ?? '')
    if (userId === '') return
    if (this.deps.config.ignoreSelf && this.deps.connection.selfId !== '' && userId === this.deps.connection.selfId) {
      return
    }
    const groupId = messageType === 'group' ? String(event.group_id ?? '') : ''
    const policy = this.deps.policy
    if (messageType === 'private') {
      if (!dmAllowed(userId, policy)) {
        this.deps.log('debug', 'ignoring DM from non-allowed user ' + userId)
        return
      }
    } else {
      if (!groupAllowed(groupId, policy)) {
        this.deps.log('debug', 'ignoring group message from non-allowed group ' + groupId)
        return
      }
    }

    const segments = Array.isArray(event.message) ? event.message as OneBotSegment[] : undefined
    const raw = typeof event.raw_message === 'string' ? event.raw_message : String(event.message ?? '')
    const parsed = parseMessage(segments, raw)
    const mentioned = detectMention(segments, raw, this.deps.connection.selfId, this.deps.config.botQQ)
    if (messageType === 'group' && this.deps.config.requireMention && !mentioned) {
      this.deps.log('debug', 'ignoring unmentioned group message in ' + groupId)
      return
    }

    const sender = event.sender ?? {}
    // Single choke point: whatever the sender controls must stay single-line
    // and bounded before it feeds the prefix and lastNickname (M1-A7).
    const nickname = sanitizeNickname(typeof sender.card === 'string' && sender.card !== ''
      ? sender.card
      : typeof sender.nickname === 'string' && sender.nickname !== ''
        ? sender.nickname
        : userId)
    const chatId = buildChatId(messageType === 'private' ? 'private' : 'group', messageType === 'private' ? userId : groupId)

    // A new user message starts a fresh reply cycle: drop any unmerged loop
    // residue from the previous cycle so interims never merge across turns.
    const priorChat = this.chats.get(chatId)
    if (priorChat !== undefined) {
      priorChat.loopBuffer = []
      priorChat.loopPending = null
    }

    // Fire-and-forget temp cleanup on each inbound.
    void this.deps.media.cleanupExpired()

    // C6a: route slash commands BEFORE any media/quote I/O — a message that
    // happens to carry media must not pay for downloads or get_msg calls just
    // to be consumed as a command (admin-only; unknown /-words still fall
    // through to the model). The most recent inbound image is registered from
    // parsed.media up front so /ocr still sees it (resolved lazily there).
    for (const ref of parsed.media) {
      if (ref.kind === 'image') this.chatPendingImageRefs.set(chatId, ref)
    }
    if (await this.tryHandleCommand(chatId, parsed.text, userId)) {
      return
    }

    const body = await this.buildBody(parsed.text, parsed.media, chatId)

    let quote = ''
    if (parsed.replyId !== undefined) {
      quote = await this.expandQuote(parsed.replyId)
    }
    let forward = ''
    if (parsed.forwardId !== undefined) {
      forward = await this.expandForward(parsed.forwardId)
    }

    const isAdmin = classifyUserRole(userId, policy.adminUsers) === 'admin'
    if (this.rateLimited(chatId)) return

    let final = body
    if (quote !== '') final = quote + '\n' + final
    if (forward !== '') final = forward + '\n' + final
    if (messageType === 'group') {
      final = buildGroupMessagePrefix(nickname, userId, mentioned) + final
      if (!isAdmin && this.deps.config.restrictedMemberPrefix) {
        final = RESTRICTED_PREFIX + final
      }
    }
    final = final.trim()
    if (final === '') return

    await this.dispatchFollowup(chatId, final, isAdmin ? 'admin' : 'member', nickname)
  }

  /** B7: sliding-window inbound rate limit for normal (non-command) messages.
   * Commands consumed by tryHandleCommand never reach this. Returns true when
   * the message must be dropped; at most one notice is sent per window. */
  private rateLimited(chatId: ChatId): boolean {
    const limit = this.deps.config.rateLimitPerMinute ?? 30
    if (limit <= 0) return false
    const chat = this.chats.get(chatId)
    if (chat === undefined) return false
    const now = Date.now()
    chat.dispatchTimes = chat.dispatchTimes.filter(t => now - t < 60_000)
    if (chat.dispatchTimes.length < limit) {
      chat.dispatchTimes.push(now)
      return false
    }
    if (chat.rateLimitNoticeAt === undefined || now - chat.rateLimitNoticeAt >= 60_000) {
      chat.rateLimitNoticeAt = now
      void this.sendToChat(chatId, '⏳ 消息太频繁，请稍后再试。').catch(() => undefined)
    }
    return true
  }

  /** Feed one user message into a chat's agent (create on demand). Records
   * the base text for /retry, queues the initiator's turn role, and applies
   * per-chat /goal + /plan prefixes. */
  private async dispatchFollowup(chatId: ChatId, text: string, role: UserRole, nickname?: string): Promise<void> {
    const final = this.prefixTurn(chatId, text)
    const fallback = this.chats.get(chatId)?.lastNickname ?? ''
    const chat = await this.ensureChat(chatId, nickname ?? fallback)
    if (nickname !== undefined && nickname !== '') chat.lastNickname = nickname
    chat.lastFollowup = text
    // Queue this turn's initiator role; the host's turn/start freezes it as
    // the running turn's role (M1-A2). Push and followup happen synchronously,
    // so the role cannot interleave with another dispatch.
    chat.pendingTurnRoles.push(role)
    this.deps.log('info', 'followup from ' + chatId + ': ' + final.slice(0, 120))
    // Plugin-originated user message: the session log attributes QQ inbound
    // messages to this plugin (the built-in plugin source with form omitted),
    // keeping them distinguishable from host/web UI inputs.
    chat.agent.followup(createUserMessage({
      content: [{ type: 'text', text: final }],
      source: { kind: 'plugin', plugin: 'dsh-onebot' },
    }))
    this.startTyping(chat)
  }

  /** Prepend per-chat context directives (/goal reminder) to a turn's user
   * text. Plan mode is host-owned now (/plan forwards to the host command),
   * so the agent's own plan-mode instruction section governs planning. */
  private prefixTurn(chatId: ChatId, text: string): string {
    let out = text
    const goal = this.chatGoals.get(chatId)
    if (goal !== undefined && goal.trim() !== '') {
      out = '【当前目标】' + goal + '\n' + out
    }
    return out.trim()
  }

  /** Per-chat outbound-mode override (/mode), falling back to the global config. */
  private effectiveInterim(chatId: ChatId): boolean {
    return this.chatInterimOverrides.get(chatId) ?? this.deps.config.interimMessages
  }

  /** Tool calls whose host-plane UI has no QQ equivalent; relay them to the chat. */
  private relayHostCards(chatId: ChatId, content: readonly unknown[]): void {
    relayCards(this.cardRelayCtx, chatId, content)
  }

  /** The CardRelayContext handed to the card relay (D1-PR2): the outbound
   * send path plus the bridge log — the only capabilities the relay touches. */
  private get cardRelayCtx(): CardRelayContext {
    return {
      sendToChat: (chatId, text) => this.sendToChat(chatId, text),
      log: (level, message) => this.deps.log(level, message),
    }
  }

  /**
   * Slash-command router. Commands are admin-only (the Hermes member
   * slash-command block) and are matched on the first word; a leading
   * @mention glued to the command (QQ group at + text) is stripped first.
   * A path like /tmp/x is never a command (command words are
   * /[A-Za-z][A-Za-z0-9_-]* only). Unknown commands return false so the
   * message reaches the model, matching the Hermes "fall through" behavior.
   * @param chatId - the chat the command arrived in.
   * @param text - parsed inbound text.
   * @param userId - sender QQ number.
   * @returns true when the message was consumed by a command.
   */
  private tryHandleCommand(chatId: ChatId, text: string, userId: string): Promise<boolean> {
    return routeCommand(this.commandCtx, chatId, text, userId)
  }

  /**
   * The CommandContext handed to the command table (D1-PR1): exposes exactly
   * the bridge capabilities the routed commands use, resolved live per
   * invocation (ctx.llm especially must stay a live service lookup).
   */
  private get commandCtx(): CommandContext {
    const bridge = this
    return {
      sendToChat: (chatId, text) => bridge.sendToChat(chatId, text),
      log: (level, message) => bridge.deps.log(level, message),
      isAdmin: userId => classifyUserRole(userId, bridge.deps.policy.adminUsers) === 'admin',
      getChat: chatId => bridge.chats.get(chatId),
      hasChat: chatId => bridge.chats.has(chatId),
      resetChat: chatId => bridge.resetChat(chatId),
      dispatchFollowup: (chatId, text, role, nickname) => bridge.dispatchFollowup(chatId, text, role, nickname),
      effectiveCwd: chatId => bridge.effectiveCwd(chatId),
      sessionIdFromMapping: chatId => bridge.sessionIdFromMapping(chatId),
      resolvePresetId: chatId => bridge.resolvePresetId(chatId),
      setChatWorkspacePath: (chatId, path) => bridge.chatWorkspacePaths.set(chatId, path),
      presetOverride: chatId => bridge.chatPresetOverrides.get(chatId),
      setPresetOverride: (chatId, id) => { bridge.chatPresetOverrides.set(chatId, id) },
      hasPresetOverride: chatId => bridge.chatPresetOverrides.has(chatId),
      interimOverride: chatId => bridge.chatInterimOverrides.get(chatId),
      setInterimOverride: (chatId, value) => { bridge.chatInterimOverrides.set(chatId, value) },
      goal: chatId => bridge.chatGoals.get(chatId),
      setGoal: (chatId, value) => { bridge.chatGoals.set(chatId, value) },
      deleteGoal: chatId => { bridge.chatGoals.delete(chatId) },
      lastImagePath: chatId => bridge.chatLastImagePaths.get(chatId),
      takePendingImageRef: chatId => {
        const ref = bridge.chatPendingImageRefs.get(chatId)
        if (ref !== undefined) bridge.chatPendingImageRefs.delete(chatId)
        return ref
      },
      resolveMediaRef: (ref, chatId) => bridge.resolveMediaRef(ref, chatId),
      get llm() { return bridge.deps.ctx.llm },
      workspaceRegistry: bridge.deps.workspaceRegistry,
      agentDefaultModel: bridge.deps.agentDefaultModel,
      agentPresets: bridge.deps.agentPresets,
      commands: bridge.deps.commands,
      connection: bridge.deps.connection,
      dshHome: bridge.deps.dshHome,
      config: { interimMessages: bridge.deps.config.interimMessages, maxImageBytes: bridge.deps.config.maxImageBytes },
    }
  }

  /** Read the chat→session mapping file (for /id and /status when no live chat). */
  private async sessionIdFromMapping(chatId: ChatId): Promise<string | undefined> {
    const file = join(this.deps.config.mediaDir, MAPPING_FILE)
    try {
      const text = await readFile(file, 'utf8')
      const map = JSON.parse(text) as Record<string, string>
      const id = map[chatId]
      return typeof id === 'string' && id !== '' ? id : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Build the message body text: placeholders become annotated local paths
   * (images/voices/videos) and voice files are transcribed when enabled.
   */
  private async buildBody(
    text: string,
    media: MediaRef[],
    chatId: ChatId,
  ): Promise<string> {
    if (media.length === 0) return text
    let out = text
    for (const ref of media) {
      const placeholder = placeholderFor(ref)
      const idx = out.indexOf(placeholder)
      const annotation = await this.resolveMediaRef(ref, chatId)
      if (idx >= 0 && annotation !== '') {
        out = out.slice(0, idx) + annotation + out.slice(idx + placeholder.length)
      }
    }
    return out
  }

  /** Resolve one media ref to a text annotation with a local path. */
  private async resolveMediaRef(ref: MediaRef, chatId: ChatId): Promise<string> {
    if (ref.kind === 'file') {
      return await this.resolveNasFile(ref)
    }
    const resolved = await this.deps.media.resolve(ref, async (kind, file) => {
      if (kind === 'image') {
        const data = await this.deps.connection.call('get_image', { file }) as { url?: string; file?: string }
        return { url: data.url, file: data.file }
      }
      if (kind === 'voice') {
        const data = await this.deps.connection.call('get_record', { file, out_format: 'mp3' }) as { file?: string }
        return { file: data.file }
      }
      return undefined
    })
    if (resolved === undefined) return ''
    switch (resolved.kind) {
      case 'image':
        // Remember the most recent inbound image for /ocr (survives /new);
        // consume the pre-routing pending ref so /ocr never re-resolves it.
        this.chatLastImagePaths.set(chatId, resolved.path)
        this.chatPendingImageRefs.delete(chatId)
        return '[图片:' + resolved.path + ']'
      case 'voice': {
        if (this.deps.transcriber.enabled) {
          try {
            const text = await this.deps.transcriber.transcribe(resolved.path)
            const label = transcriptLabel(text)
            if (label !== '') return '[语音]' + label
          } catch (error) {
            this.deps.log('warn', 'STT failed: ' + (error instanceof Error ? error.message : String(error)))
          }
        }
        return '[语音]'
      }
      case 'video':
        return '[视频:' + resolved.path + ']'
      default:
        return '[文件:' + resolved.path + ']'
    }
  }

  /** Expand a quoted (reply) message into [引用] text via get_msg. */
  private async expandQuote(messageId: string): Promise<string> {
    try {
      const data = await this.deps.connection.call('get_msg', { message_id: Number(messageId) }) as {
        message?: unknown
        raw_message?: string
        sender?: { nickname?: string }
      }
      const segments = Array.isArray(data.message) ? data.message as OneBotSegment[] : undefined
      const raw = typeof data.raw_message === 'string' ? data.raw_message : ''
      const text = cqUnescape(segmentText(segments, raw))
      if (text.trim() === '') return ''
      const name = data.sender?.nickname ?? ''
      return '[引用]' + (name !== '' ? name + ': ' : '') + text
    } catch (error) {
      this.deps.log('debug', 'quote expansion failed: ' + (error instanceof Error ? error.message : String(error)))
      return ''
    }
  }

  /**
   * Fetch an inbound QQ file to a local path. NapCat's get_file may return
   * container-internal paths unreachable from this host, so:
   *   1. prefer the private-file direct link (get_private_file_url → HTTP
   *      CDN download, works for private chats);
   *   2. fall back to get_file base64 / http-url payloads.
   * Returns the [文件:path] annotation, or '' when disabled/failed.
   */
  private async resolveNasFile(ref: MediaRef): Promise<string> {
    const name = ref.name !== undefined && ref.name !== '' ? ref.name : 'file'
    // The sender-controlled name never becomes the on-disk path (it could
    // otherwise overwrite chat-sessions.json etc.); only a whitelisted
    // extension survives into the fresh media_* name.
    const ext = extForInboundName(name)
    // Streaming size cap for both URL branches below (0 = uncapped).
    const maxBytes = this.deps.config.maxInboundFileBytes > 0 ? this.deps.config.maxInboundFileBytes : undefined
    const fid = ref.fileId ?? ref.file ?? ''
    if (fid === '') return ''
    try {
      // 1. Private-chat direct link (works without any container access).
      const direct = await this.deps.connection.call('get_private_file_url', { file_id: fid }) as {
        url?: string
      }
      if (direct.url !== undefined && direct.url !== '') {
        try {
          const localPath = await this.deps.media.downloadUrl(direct.url, ext, maxBytes)
          this.deps.log('info', 'qq file fetched via direct link: ' + localPath)
          return '[文件:' + localPath + ']'
        } catch (error) {
          this.deps.log('warn', 'qq file direct download failed: ' + (error instanceof Error ? error.message : String(error)))
        }
      }
    } catch (error) {
      this.deps.log('debug', 'get_private_file_url failed (falling back to get_file): ' + (error instanceof Error ? error.message : String(error)))
    }
    // 2. get_file: with NapCat's file server enabled it returns a `base64`
    //    payload or an http(s) `url`; otherwise a container path we cannot reach.
    try {
      const data = await this.deps.connection.call('get_file', { file: fid }) as {
        file?: string
        url?: string
        base64?: string
        file_size?: string | number
      }
      const size = Number(data.file_size ?? 0)
      if (this.deps.config.maxInboundFileBytes > 0 && size > this.deps.config.maxInboundFileBytes) {
        this.deps.log('warn', 'qq file too large (' + size + 'B), skipping fetch')
        return ''
      }
      if (data.base64 !== undefined && data.base64 !== '') {
        const localPath = await this.writeMediaFile(Buffer.from(data.base64, 'base64'), ext)
        if (localPath !== '') {
          this.deps.log('info', 'qq file fetched via get_file base64: ' + localPath)
          return '[文件:' + localPath + ']'
        }
      }
      if (data.url !== undefined && /^https?:\/\//.test(data.url)) {
        try {
          const localPath = await this.deps.media.downloadUrl(data.url, ext, maxBytes)
          this.deps.log('info', 'qq file fetched via get_file url: ' + localPath)
          return '[文件:' + localPath + ']'
        } catch (error) {
          this.deps.log('warn', 'qq file direct download failed: ' + (error instanceof Error ? error.message : String(error)))
        }
      }
    } catch (error) {
      this.deps.log('debug', 'get_file base64/url path failed: ' + (error instanceof Error ? error.message : String(error)))
    }
    this.deps.log('warn', 'qq file fetch failed: no direct link / base64 / http url available for ' + fid)
    return ''
  }

  /** Write bytes into the media dir under a fresh unpredictable name; returns the path or ''. */
  private async writeMediaFile(buffer: Buffer, ext: string): Promise<string> {
    try {
      // freshPath mints media_<ts>_<uuid><ext>: inbound data can never land
      // on a known name (chat-sessions.json etc.) no matter what the sender
      // chose as the file name.
      await this.deps.media.ensure()
      const localPath = this.deps.media.freshPath(ext)
      await writeFile(localPath, buffer)
      return localPath
    } catch (error) {
      this.deps.log('warn', 'media write failed: ' + (error instanceof Error ? error.message : String(error)))
      return ''
    }
  }

  /** Expand a combined-forward id into "name: content" lines. */
  private async expandForward(forwardId: string): Promise<string> {
    try {
      const data = await this.deps.connection.call('get_forward_msg', { id: forwardId }) as {
        messages?: Array<{ sender?: { nickname?: string; user_id?: number | string }; content?: unknown }>
      }
      const lines: string[] = []
      for (const node of data.messages ?? []) {
        const name = node.sender?.nickname ?? String(node.sender?.user_id ?? '未知')
        const text = nodeContentText(node.content)
        if (text !== '') lines.push(name + ': ' + text)
      }
      if (lines.length === 0) return ''
      return '[合并转发]\n' + lines.join('\n')
    } catch (error) {
      this.deps.log('debug', 'forward expansion failed: ' + (error instanceof Error ? error.message : String(error)))
      return '[合并转发]'
    }
  }

  // ------------------------------------------------------------ outbound

  /** Send one message to a chat and return its message id. */
  private async sendMsg(chatId: ChatId, segments: OutboundSegment[], options: SendOptions): Promise<string | undefined> {
    return this.outbound.sendMsg(chatId, segments, options)
  }

  /** Send [[qq_forward]] nodes as a merged-forward message. */
  async sendForward(chatId: ChatId, nodes: Array<{ name: string; content: string }>): Promise<void> {
    return this.outbound.sendForward(chatId, nodes)
  }

  /** Cancel a message's pending 90s auto-recall timer. */
  private clearInterimTimer(chat: ChatAgent, id: string): void {
    const timer = chat.recallTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      chat.recallTimers.delete(id)
    }
  }

  /** Clear every pending interim auto-recall timer for a chat (dispose path). */
  private clearInterimTimers(chat: ChatAgent): void {
    for (const timer of chat.recallTimers.values()) clearTimeout(timer)
    chat.recallTimers.clear()
  }

  /**
   * Recall the still-on-screen interim originals (turn/end step 2). Ids the
   * 90s timer already revoked during the turn are skipped (already gone).
   * Recall failure is logged only — the summary card still carries the text.
   */
  private async recallLoopMessages(chatId: ChatId, chat: ChatAgent, buf: Array<{ id: string; text: string }>): Promise<void> {
    for (const { id } of buf) {
      if (chat.recalledInterimIds.has(id)) continue
      this.clearInterimTimer(chat, id)
      try {
        await this.deps.connection.call('delete_msg', { message_id: id })
        chat.recalledInterimIds.add(id)
        await new Promise(resolve => setTimeout(resolve, RECALL_SPACING_MS))
      } catch (error) {
        this.deps.log('debug', 'loop recall delete_msg failed for ' + id + ': ' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }

  /** Fire when an interim's own 90s timer elapses mid-turn: revoke it alone. */
  private revokeInterim(chatId: ChatId, chat: ChatAgent, id: string): void {
    chat.recallTimers.delete(id)
    this.deps.connection.call('delete_msg', { message_id: id }).then(() => {
      chat.recalledInterimIds.add(id)
    }).catch(error => {
      this.deps.log('debug', 'interim auto-recall failed for ' + id + ': ' + (error instanceof Error ? error.message : String(error)))
    })
  }

  /** Render this turn's interims into one t2i image (summary card, before final). */
  private async sendInterimSummary(chatId: ChatId, buf: Array<{ id: string; text: string }>): Promise<void> {
    const body = buf.map((item, index) => (index + 1) + '. ' + item.text.trim()).filter(line => line !== '').join('\n\n')
    if (body === '') return
    let png: Buffer
    try {
      png = renderTextImage(body, {
        title: '📋 本轮中间记录',
        footerBrand: this.deps.config.cardFooter,
        fontFiles: this.deps.config.fontFiles,
        fontFamilies: this.deps.config.fontFamilies,
      })
    } catch (error) {
      this.deps.log('warn', 'interim summary t2i failed, sending as text: ' + (error instanceof Error ? error.message : String(error)))
      await this.sendToChat(chatId, body)
      return
    }
    const b64 = 'base64://' + png.toString('base64')
    if (b64.length <= this.deps.config.maxImageBytes) {
      await this.sendMsg(chatId, [{ type: 'image', data: { file: b64 } }], {})
    } else {
      await this.sendToChat(chatId, body)
    }
  }

  // ------------------------------------------------------------ session events

  /** Send one interim live and record it: text for the turn/end summary card,
   * plus a per-message auto-recall timer (config interimRecallMs) so long turns
   * clean up their early messages even before the summary arrives. */
  private sendInterim(chatId: ChatId, chat: ChatAgent, text: string): void {
    this.sendToChat(chatId, text).then(ids => {
      const sentAt = Date.now()
      for (const id of ids) {
        chat.loopBuffer.push({ id, text, sentAt })
        const delay = this.deps.config.interimRecallMs ?? 90_000
        const timer = setTimeout(() => this.revokeInterim(chatId, chat, id), delay)
        chat.recallTimers.set(id, timer)
      }
    }).catch(error => {
      this.deps.log('warn', 'interim send failed: ' + (error instanceof Error ? error.message : String(error)))
    })
  }

  /**
   * Settle a finished turn's interim trail (interimMessages on): drain the send
   * chain so every interim id is recorded, then render ONE t2i summary card of
   * all interims, immediately recall the still-on-screen originals, and finally
   * send the deferred final text. No merged-forward any more — QQ refuses to
   * recall messages older than ~2 min, and a forward of aged interims would
   * leave the originals plus a duplicate card, so interims are surfaced live
   * and auto-revoked per message (90s) during long turns.
   */
  private async settleLoop(chatId: ChatId, chat: ChatAgent): Promise<void> {
    try {
      await chat.queue
    } catch {
      // failures already settle the enqueue chain; keep going
    }
    const buf = chat.loopBuffer
    chat.loopBuffer = []
    if (buf.length >= 1) {
      try {
        await this.sendInterimSummary(chatId, buf)
      } catch (error) {
        this.deps.log('warn', 'interim summary send failed: ' + (error instanceof Error ? error.message : String(error)))
      }
      try {
        await this.recallLoopMessages(chatId, chat, buf)
      } catch (error) {
        this.deps.log('warn', 'loop recall failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    if (chat.loopPending !== null) {
      const final = chat.loopPending
      chat.loopPending = null
      try {
        await this.sendToChat(chatId, final, { queuable: true })
      } catch (error) {
        this.deps.log('warn', 'final send failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (this.stopping) return
    const chatId = this.bySession.get(session.id)
    if (chatId === undefined) return
    const chat = this.chats.get(chatId)
    if (chat === undefined || chat.sessionId !== session.id) return
    if (event.type === 'turn/start') {
      // Freeze the running turn's initiator role from the dispatch FIFO
      // (M1-A2): turns the plugin did not dispatch (host/web input) find an
      // empty queue and fail closed as member.
      chat.activeTurnRole = chat.pendingTurnRoles.shift() ?? 'member'
      chat.busy = true
      return
    }
    if (event.type === 'assistant/message') {
      // Dedupe: the session may re-emit the same message (streaming/usage
      // updates); each id is handled exactly once, or interims would send
      // repeatedly and flood the loop buffer.
      const messageId = event.data.message.id
      if (messageId !== undefined && chat.lastHandledMessageId === messageId) return
      if (messageId !== undefined) chat.lastHandledMessageId = messageId
      // Host-plane cards (plan review / ask_user_question) never enter the
      // session text stream — the model calls a tool whose arguments carry the
      // content and whose text block is empty, so the `text === ''` early
      // return below would otherwise leave QQ silent. Relay those cards here,
      // before any early return, so the user is never left hanging.
      this.relayHostCards(chatId, event.data.message.content)
      const text = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (text === '') return
      if (this.effectiveInterim(chatId)) {
        // The arriving message proves the previously deferred text interim —
        // flush it now, regardless of this message's shape.
        const prior = chat.loopPending
        if (prior !== null) {
          chat.loopPending = null
          this.sendInterim(chatId, chat, prior)
        }
        // A message carrying tool calls can never be the final reply (the
        // model continues after the tool) — send it immediately instead of
        // deferring one step, so QQ receives interims without the one-step
        // lag. Only tool-free text stays deferred until turn/end proves it
        // either interim (next assistant/message) or final.
        const hasToolCall = event.data.message.content.some(block => block.type === 'tool-call')
        if (hasToolCall) {
          this.sendInterim(chatId, chat, text)
        } else {
          chat.loopPending = text
        }
      } else {
        chat.pendingFinal = text
      }
      return
    }
    if (event.type === 'turn/end') {
      if (this.effectiveInterim(chatId)) {
        void this.settleLoop(chatId, chat)
      } else if (chat.pendingFinal !== '') {
        const final = chat.pendingFinal
        chat.pendingFinal = ''
        this.sendToChat(chatId, final, { queuable: true }).catch(error => {
          this.deps.log('warn', 'final send failed: ' + (error instanceof Error ? error.message : String(error)))
        })
      }
      if (event.data.reason.kind === 'error' && this.deps.config.sendErrorNotice) {
        const message = event.data.reason.error.message
        this.sendToChat(chatId, '⚠️ 运行出错：' + message, { queuable: true }).catch(() => undefined)
        if (/persisted log on disk that does not match this live session|id collision/i.test(message)) {
          void this.healSessionCollision(chatId)
        }
      }
      this.stopTyping(chat)
      chat.busy = false
      this.deps.log('info', 'turn/end for ' + chatId + ': ' + event.data.reason.kind)
      // Durable: flush the session so a later restart can resume it.
      void this.deps.sessions.flush(chat.agent.session).catch((error: unknown) => {
        this.deps.log('warn', 'session flush failed: ' + String(error))
      })
      void this.saveMappingDebounced()
    }
  }

  private async onSessionFlush(session: Session): Promise<void> {
    if (this.stopping) return
    const chatId = this.bySession.get(session.id)
    if (chatId === undefined) return
    // M1-E2: arbitrary session flushes debounce like turn/end — stop() still
    // forces the final saveMapping directly.
    this.saveMappingDebounced()
  }

  // ------------------------------------------------------------ chat lifecycle

  /** C2: default-model wiring shared by the create and resume assembly paths
   * — agent options for the registry call plus the mutable per-agent
   * selection ref (undefined when the deployment has no default model). */
  private modelWiring(): { agentOptions: { provider?: string; model?: string }; selectionRef: ModelSelectionRef | undefined } {
    const selection = this.deps.defaultModel?.()
    const agentOptions: { provider?: string; model?: string } = {}
    if (selection !== undefined) {
      agentOptions.provider = selection.provider
      agentOptions.model = selection.model
    }
    const selectionRef = selection !== undefined
      ? { current: selection, assembled: undefined }
      : undefined
    return { agentOptions, selectionRef }
  }

  /** C2: the AgentSetup closure shared by the create and resume assembly
   * paths. The only difference between the callers is the preset: a resumed
   * session rejoins the preset it recorded itself; a fresh create reuses the
   * config/default resolution already recorded in its header meta. */
  private buildSetup(selectionRef: ModelSelectionRef | undefined, recordedPreset?: string): AgentSetup {
    return async agentCtx => {
      this.installChannelScope(agentCtx)
      await this.joinPreset(agentCtx, recordedPreset)
      if (selectionRef !== undefined) {
        installModelSelection(agentCtx, selectionRef)
      }
    }
  }

  /** C2: the ChatAgent literal shared by the create and resume assembly
   * paths — every field starts at its neutral initial value. `nickname` is
   * the one deliberate divergence between the callers (create seeds it from
   * the inbound message, resume keeps the pre-C2 hardcoded ''); pinned by
   * the M2-C2 characterization tests in bridge.spec.ts. */
  private createChatAgent(
    chatId: ChatId,
    handle: { agent: Agent; dispose(): Promise<void> },
    selectionRef: ModelSelectionRef | undefined,
    nickname: string,
  ): ChatAgent {
    return {
      chatId,
      sessionId: handle.agent.session.id,
      agent: handle.agent,
      dispose: () => handle.dispose(),
      queue: Promise.resolve(),
      pendingFinal: '',
      loopPending: null,
      loopBuffer: [],
      recallTimers: new Map(),
      recalledInterimIds: new Set(),
      lastHandledMessageId: undefined,
      busy: false,
      dispatchTimes: [],
      rateLimitNoticeAt: undefined,
      typingTimer: undefined,
      lastNickname: nickname,
      pendingTurnRoles: [],
      activeTurnRole: 'member',
      lastFollowup: undefined,
      selectionRef,
    }
  }

  /** Get (or create) the agent for a chat. */
  private async ensureChat(chatId: ChatId, nickname: string): Promise<ChatAgent> {
    const existing = this.chats.get(chatId)
    if (existing !== undefined) return existing
    await this.mappingLoaded
    let sessionId = makeSessionId(sessionIdForChat(chatId))
    if (this.isSessionIdBlocked(sessionId)) {
      sessionId = this.freshSessionId(chatId)
    } else if (await this.hasPersistedLog(sessionId)) {
      // The bare id still owns a stale on-disk log (e.g. the retired record
      // was lost in an earlier crash): reusing it would collide, so retire it
      // NOW and move to a suffixed id instead of failing the chat later.
      this.retireSession(sessionId)
      sessionId = this.freshSessionId(chatId)
    }
    const { agentOptions, selectionRef } = this.modelWiring()
    const cwd = this.effectiveCwd(chatId)
    const presetId = await this.resolvePresetId(chatId)
    const meta: { cwd: string; agentPreset?: string } = { cwd }
    if (presetId !== undefined) meta.agentPreset = presetId
    const setup = this.buildSetup(selectionRef)
    let handle: { agent: Agent; dispose(): Promise<void> }
    try {
      handle = await this.deps.agents.create({
        sessionId,
        meta,
        agentOptions,
        setup,
      })
    } catch (error) {
      // A stale or foreign persisted log under the same id blocks creation
      // (id collision). Recover with a fresh suffixed session id instead of
      // failing the chat.
      this.retireSession(sessionId)
      const fallbackId = this.freshSessionId(chatId)
      this.deps.log('warn', 'agent create failed (' + (error instanceof Error ? error.message : String(error)) + '); retrying with ' + fallbackId)
      handle = await this.deps.agents.create({
        sessionId: fallbackId,
        meta,
        agentOptions,
        setup,
      })
      this.deps.log('info', 'recovered with fresh session ' + fallbackId + ' for ' + chatId)
    }
    // The real session id is authoritative (the fallback path above creates a
    // different id than the one initially attempted); record it everywhere so
    // session events route to this chat and the mapping persists the truth.
    const actualSessionId = handle.agent.session.id
    await this.attachToWorkspace(actualSessionId, handle.agent.session.header?.cwd)
    const chat = this.createChatAgent(chatId, handle, selectionRef, nickname)
    await handle.agent.whenIdle()
    this.chats.set(chatId, chat)
    this.bySession.set(actualSessionId, chatId)
    this.deps.log('info', 'agent created for ' + chatId + ' (session ' + actualSessionId + ')')
    void this.saveMapping()
    return chat
  }

  /** Resume persisted chats from the mapping file (best-effort). */
  private async loadMapping(): Promise<void> {
    try {
      const content = await readFile(this.mappingPath(), 'utf8')
      const mapping = JSON.parse(content) as Record<string, string>
      this.deps.log('debug', 'mapping file has ' + Object.keys(mapping).length + ' chat(s)')
      for (const [chatId, sessionId] of Object.entries(mapping)) {
        this.deps.log('debug', 'attempting resume of ' + chatId + ' @ ' + sessionId)
        if (this.stopping) return
        try {
          const { agentOptions, selectionRef } = this.modelWiring()
          const recordedPreset = await this.recordedPresetFor(makeSessionId(sessionId))
          const handle = await this.deps.agents.resume({
            resumeSessionId: makeSessionId(sessionId),
            agentOptions,
            setup: this.buildSetup(selectionRef, recordedPreset),
          })
          await this.attachToWorkspace(handle.agent.session.id, handle.agent.session.header?.cwd)
          // /workspace persistence across restarts: the per-chat override map is
          // in-memory only, but a session's cwd is frozen in its header. When the
          // resumed session's directory differs from what this chat would default
          // to now, restore it as the override so /workspace and future /new
          // sessions keep using it.
          const headerCwd = handle.agent.session.header?.cwd
          if (headerCwd !== undefined && headerCwd !== '' && headerCwd !== this.effectiveCwd()) {
            this.chatWorkspacePaths.set(chatId, headerCwd)
            this.deps.log('debug', 'workspace override restored for ' + chatId + ': ' + headerCwd)
          }
          const chat = this.createChatAgent(chatId, handle, selectionRef, '')
          await handle.agent.whenIdle()
          this.chats.set(chatId, chat)
          this.bySession.set(handle.agent.session.id, chatId)
        } catch (error) {
          this.retireSession(sessionId)
          this.deps.log('warn', 'resume failed for ' + chatId + ': ' + (error instanceof Error ? error.message : String(error)))
        }
      }
    } catch {
      // No mapping file yet — fresh start.
    }
  }

  private mappingPath(): string {
    return this.deps.config.mediaDir.endsWith('/') || this.deps.config.mediaDir.endsWith('\\')
      ? this.deps.config.mediaDir + MAPPING_FILE
      : this.deps.config.mediaDir + '/' + MAPPING_FILE
  }

  private async saveMapping(): Promise<void> {
    try {
      await mkdir(this.deps.config.mediaDir, { recursive: true })
      const mapping: Record<string, string> = {}
      for (const chat of this.chats.values()) {
        mapping[chat.chatId] = chat.sessionId
      }
      await writeFile(this.mappingPath(), JSON.stringify(mapping, null, 2), 'utf8')
    } catch (error) {
      this.deps.log('warn', 'mapping save failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  private saveMappingDebounced(): void {
    if (this.mappingSaveTimer !== undefined) clearTimeout(this.mappingSaveTimer)
    this.mappingSaveTimer = setTimeout(() => {
      this.mappingSaveTimer = undefined
      void this.saveMapping()
    }, 2_000).unref()
  }

  // ------------------------------------------------------------ retired ids

  /** Whether a session id must never be created again (this run or on disk). */
  private isSessionIdBlocked(id: string): boolean {
    return this.brokenSessions.has(id) || this.retiredSessionIds.has(id)
  }

  /** A suffixed session id for a chat that avoids every blocked id. */
  private freshSessionId(chatId: ChatId): SessionId {
    let id: SessionId
    do {
      id = makeSessionId(sessionIdForChat(chatId) + '-' + Date.now().toString(36))
    } while (this.isSessionIdBlocked(id))
    return id
  }

  /** Permanently retire a session id: in-memory plus durable on-disk record,
   * so a restart never reuses an id whose log collides with a fresh session. */
  private retireSession(id: string): void {
    this.brokenSessions.add(id)
    this.retiredSessionIds.add(id)
    void this.saveRetired()
  }

  /** Whether the persistence layer already owns a durable log for this id —
   * true means reusing the id would collide (stale on-disk log or live entry).
   * A read failure counts as no log so the caller falls back to the normal
   * path rather than blocking an id on a transient error. */
  private async hasPersistedLog(id: SessionId): Promise<boolean> {
    const persistence = this.deps.sessionPersistence
    if (persistence === undefined) return false
    try {
      await persistence.inspect(id)
      return true
    } catch {
      return false
    }
  }

  private retiredPath(): string {
    return this.deps.config.mediaDir.endsWith('/') || this.deps.config.mediaDir.endsWith('\\')
      ? this.deps.config.mediaDir + RETIRED_FILE
      : this.deps.config.mediaDir + '/' + RETIRED_FILE
  }

  private async loadRetired(): Promise<void> {
    let content: string
    try {
      content = await readFile(this.retiredPath(), 'utf8')
    } catch (error) {
      // Only a missing file means "fresh start". ANY other read failure must
      // not be treated as an empty retired set — a later saveRetired() would
      // then OVERWRITE the on-disk record with nothing, silently dropping
      // every retired id (exactly the 2026-08-17 regression: the bare id
      // lost its retire record and /new collided on the stale log).
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.deps.log('warn', 'retired-sessions read failed; keeping the current set: ' + (error instanceof Error ? error.message : String(error)))
      }
      return
    }
    try {
      const parsed = JSON.parse(content) as unknown
      if (Array.isArray(parsed)) {
        this.retiredSessionIds = new Set(parsed.filter((id): id is string => typeof id === 'string'))
        for (const id of this.retiredSessionIds) this.brokenSessions.add(id)
        this.deps.log('debug', 'retired-sessions file has ' + this.retiredSessionIds.size + ' id(s)')
      } else {
        this.deps.log('warn', 'retired-sessions file is not a JSON array; ignoring')
      }
    } catch (error) {
      // Corrupt JSON: keep the current in-memory set (never replace it with
      // an empty array) and warn so a future save does not obliterate history.
      this.deps.log('warn', 'retired-sessions file is unparsable; keeping the current set: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  private async saveRetired(): Promise<void> {
    try {
      await mkdir(this.deps.config.mediaDir, { recursive: true })
      // Atomic write: a temp file + rename never leaves a half-written file
      // that a concurrent/future loadRetired could parse into a broken empty set.
      const tmpPath = this.retiredPath() + '.tmp'
      await writeFile(tmpPath, JSON.stringify(Array.from(this.retiredSessionIds), null, 2), 'utf8')
      await rename(tmpPath, this.retiredPath())
    } catch (error) {
      this.deps.log('warn', 'retired-sessions save failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /**
   * Recover from a session-log collision: the live session cannot append to
   * the mismatched on-disk log, so dispose the agent and rebuild the chat on
   * a fresh session id. The user is asked to resend.
   */
  private async healSessionCollision(chatId: ChatId): Promise<void> {
    const chat = this.chats.get(chatId)
    if (chat === undefined) return
    this.retireSession(chat.sessionId)
    // The bare derived id shares the chat's stale log; retire it too so the
    // next ensureChat can never pick it again in this run OR after a restart.
    this.retireSession(sessionIdForChat(chatId))
    this.chats.delete(chatId)
    this.bySession.delete(chat.sessionId)
    this.stopTyping(chat)
    try {
      await chat.dispose()
    } catch (error) {
      this.deps.log('warn', 'collision heal dispose failed: ' + String(error))
    }
    this.deps.log('warn', 'healed session collision for ' + chatId + '; a fresh session will be created on next message')
    void this.saveMapping()
  }

  // ------------------------------------------------------------ workspace & preset

  /**
   * Effective workspace directory for a chat's sessions: the per-chat
   * /workspace override when set, else the configured workspacePath, falling
   * back to the host process cwd.
   */
  private effectiveCwd(chatId?: ChatId): string {
    if (chatId !== undefined) {
      const override = this.chatWorkspacePaths.get(chatId)
      if (override !== undefined && override !== '') return override
    }
    const configured = this.deps.config.workspacePath
    return configured !== undefined && configured !== '' ? configured : process.cwd()
  }

  /**
   * The preset id a NEW session records and joins: the configured id when set,
   * else the deployment default — the same resolution the Web surface applies,
   * so cross-channel sessions carry the same header fact. A roster that cannot
   * resolve the effective id leaves the header bare and the session uncomposed,
   * exactly like a failed mount.
   */
  private async resolvePresetId(chatId: ChatId): Promise<string | undefined> {
    // A /preset override wins for this chat (survives /new, so the re-created
    // session registers the chosen preset in its header).
    const override = chatId !== undefined ? this.chatPresetOverrides.get(chatId) : undefined
    if (override !== undefined && override !== '') return override
    const presets = this.deps.agentPresets
    if (presets === undefined) return undefined
    const configured = this.deps.config.agentPreset
    const wanted = configured !== undefined && configured !== '' ? configured : presets.defaultId
    try {
      const preset = await presets.resolve(wanted)
      return preset.id
    } catch (error) {
      this.deps.log('warn', 'agent preset resolve failed; session header records no preset: ' + (error instanceof Error ? error.message : String(error)))
      return undefined
    }
  }

  /**
   * The preset id a persisted session recorded for itself (newest logged
   * selection wins, else the creation header), or undefined when it recorded
   * none or the record cannot be read — a legacy session resumes under the
   * config/default, preserving its original behavior.
   */
  private async recordedPresetFor(sessionId: SessionId): Promise<string | undefined> {
    const persistence = this.deps.sessionPersistence
    if (persistence === undefined) return undefined
    try {
      const inspection = await persistence.inspect(sessionId)
      return resolveRecordedPreset(inspection)
    } catch (error) {
      this.deps.log('warn', 'preset record read failed for ' + sessionId + ' (falling back to config/default): ' + (error instanceof Error ? error.message : String(error)))
      return undefined
    }
  }

  /**
   * Join the QQ agent to the configured agent preset (the deployment default
   * when unset) so its tools/prompt sections/skill catalog resolve against the
   * preset composition instead of the empty global layer. `preferred` — the
   * preset the session itself recorded — overrides the config (its history was
   * produced under that composition; replaying it differently would break the
   * recorded tool calls); a conflicting config only logs. Best-effort: a
   * broken preset falls back to the previous behavior rather than failing the
   * chat.
   */
  private async joinPreset(agentCtx: unknown, preferred?: string): Promise<void> {
    if (this.deps.agentPresets === undefined) return
    const configured = this.deps.config.agentPreset
    if (preferred !== undefined && configured !== undefined && configured !== '' && configured !== preferred) {
      this.deps.log('warn', 'session records preset ' + preferred + ' but plugin config names ' + configured + '; resuming under the recorded preset')
    }
    const selected = preferred ?? (configured !== undefined && configured !== '' ? configured : undefined)
    try {
      const preset = await this.deps.agentPresets.mount(agentCtx, selected)
      this.deps.log('debug', 'agent joined preset ' + preset.id)
    } catch (error) {
      this.deps.log('warn', 'agent preset mount failed (tools fall back to the global layer): ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /**
   * Compose the QQ channel's scoped world for one agent: the QQ platform
   * prompt section and the qq_* tools. Registered on `agentCtx` (the agent's
   * own scope) instead of the plugin context, so Web/local sessions never see
   * the channel instructions or the media tools — they cannot (and should
   * not) push messages to QQ.
   */
  private installChannelScope(agentCtx: Context): void {
    agentCtx.systemPrompt.section({
      name: 'channel:dsh-onebot',
      order: 90,
      text: buildPlatformPrompt(this.deps.config.restrictedMemberPrefix),
    })
    registerTools(agentCtx, this, this.deps.connection, {
      maxImageBytes: this.deps.config.maxImageBytes,
      maxVoiceBytes: this.deps.config.maxVoiceBytes,
      maxFileBytes: this.deps.config.maxFileBytes,
    })
  }

  /**
   * Attach a chat session to the workspace owning its header cwd, so QQ
   * sessions group under a workspace in the GUI instead of "Ungrouped".
   * Best-effort: failure only logs.
   *
   * A workspace is auto-created only when the session cwd matches the
   * configured workspacePath (new sessions). A resumed session carrying a
   * foreign cwd (e.g. created under an earlier host cwd) is attached only when
   * a workspace already owns that path — never auto-created, so legacy
   * sessions cannot spawn accidental workspaces.
   */
  private async attachToWorkspace(sessionId: string, headerCwd: string | undefined): Promise<void> {
    const registry = this.deps.workspaceRegistry
    if (registry === undefined) return
    try {
      if (headerCwd === undefined || headerCwd === '') {
        this.deps.log('warn', 'workspace attach skipped: session header carries no cwd')
        return
      }
      const workspace = await registry.resolveByPath(headerCwd)
      if (workspace === undefined) {
        if (headerCwd !== this.effectiveCwd()) {
          this.deps.log('debug', 'workspace attach skipped: no workspace owns ' + headerCwd + ' and it differs from the configured workspacePath')
          return
        }
        const created = await registry.create(headerCwd)
        this.deps.log('info', 'created workspace for ' + headerCwd)
        await created.attachSession(sessionId)
        this.deps.log('info', 'attached session ' + sessionId + ' to workspace ' + headerCwd)
        return
      }
      await workspace.attachSession(sessionId)
      this.deps.log('info', 'attached session ' + sessionId + ' to workspace ' + headerCwd)
    } catch (error) {
      this.deps.log('warn', 'workspace attach failed for ' + sessionId + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /**
   * /new: dispose the current chat agent and retire its session id, so the
   * next inbound message creates a brand-new session (fresh history; the old
   * conversation stays on disk). The confirmation is sent directly through
   * the outbound pipeline since no agent is left to reply.
   */
  private async resetChat(chatId: ChatId): Promise<void> {
    const chat = this.chats.get(chatId)
    if (chat !== undefined) {
      this.stopTyping(chat)
      this.clearInterimTimers(chat)
      this.retireSession(chat.sessionId)
      // The bare derived id is forever unsafe for this chat once its history
      // has moved to a suffixed id: its on-disk log (if any) would collide
      // with any future bare-id session. Retire it up front so a /new after a
      // restart — when only the retired file protects us — stays safe.
      this.retireSession(sessionIdForChat(chatId))
      this.chats.delete(chatId)
      this.bySession.delete(chat.sessionId)
      try {
        await chat.dispose()
      } catch (error) {
        this.deps.log('warn', 'reset dispose failed: ' + (error instanceof Error ? error.message : String(error)))
      }
      this.deps.log('info', 'reset chat ' + chatId + ' (old session ' + chat.sessionId + ' retired)')
    }
    void this.saveMapping()
    this.sendToChat(chatId, '✅ 已开启新会话，下一条消息将进入全新会话，旧对话历史保留在之前的会话中。').catch((error: unknown) => {
      this.deps.log('warn', 'reset notice send failed: ' + String(error))
    })
  }

  // ------------------------------------------------------------ typing

  /** Start the NapCat typing indicator (private chats only). */
  private startTyping(chat: ChatAgent): void {
    const ref = splitChatId(chat.chatId)
    if (ref.kind !== 'private') return
    this.stopTyping(chat)
    const pulse = (): void => {
      if (this.stopping) return
      void this.deps.connection.call('set_input_status', {
        user_id: Number(ref.target),
        event_type: 1,
      }).catch(() => undefined)
    }
    pulse()
    chat.typingTimer = setInterval(pulse, 5_000).unref()
  }

  /** Stop the typing indicator. */
  private stopTyping(chat: ChatAgent): void {
    if (chat.typingTimer !== undefined) {
      clearInterval(chat.typingTimer)
      chat.typingTimer = undefined
    }
    const ref = splitChatId(chat.chatId)
    if (ref.kind !== 'private') return
    void this.deps.connection.call('set_input_status', {
      user_id: Number(ref.target),
      event_type: 0,
    }).catch(() => undefined)
  }
}

/** The placeholder a media ref contributes to the parsed text. */
function placeholderFor(ref: MediaRef): string {
  switch (ref.kind) {
    case 'image': return '[图片]'
    case 'voice': return '[语音]'
    case 'video': return '[视频]'
    default: return ref.name !== undefined ? '[文件:' + ref.name + ']' : '[文件]'
  }
}

/**
 * Extract text from a forward-node content (segment array or CQ string).
 */
function nodeContentText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map(seg => {
        const s = seg as { type?: string; data?: Record<string, unknown> }
        if (s?.type === 'text') return String(s.data?.text ?? '')
        if (s?.type === 'face') return '😀'
        return '[非文本]'
      })
      .join('')
      .trim()
  }
  if (typeof content === 'string') return content.trim()
  return ''
}

export { OneBotNotConnectedError, OneBotActionError } from './connection.js'
