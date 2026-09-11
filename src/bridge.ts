/**
 * The chat↔agent bridge: one Agent per QQ chat, inbound message pipeline
 * (policy → parse → media → STT → quote/forward expansion → followup),
 * outbound delivery driven by session events (assistant/message, turn/end),
 * typing indicator, per-chat send ordering, and chat→session mapping
 * persistence for restart resume. Ported from the Hermes OneBotAdapter
 * gateway-interaction half onto the dsh headless-runner agent pattern.
 * @module dsh-onebot/bridge
 */

import type { AgentRegistry, ModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { realpath, writeFile } from 'node:fs/promises'


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
  RESTRICTED_PREFIX, sanitizeNickname, splitChatId,
} from './chat.js'
import type { AccessPolicyConfig } from './chat.js'
import { renderTextImage } from './t2i/index.js'
import { buildPlatformPrompt } from './prompt.js'
import { registerTools } from './tools.js'
import { tryHandleCommand as routeCommand, type CommandContext } from './commands.js'
import { relayHostCards as relayCards, type CardRelayContext } from './card-relay.js'
import { OutboundPipeline } from './outbound.js'
import type { OutboundSegment, SendOptions } from './outbound.js'
import { ChatRegistry } from './registry.js'
import type { ChatAgent } from './registry.js'
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
  /** The chat↔session registry (D1-PR3): chats/bySession dual index, the
   * persistence pair, per-chat settings and the create/resume assembly. */
  private readonly registry: ChatRegistry
  /** Live registry indexes — the inbound/outbound/interim/turn links keep
   * reading them through these same-name views. */
  private get chats(): Map<ChatId, ChatAgent> { return this.registry.chats }
  private get bySession(): Map<string, ChatId> { return this.registry.bySession }
  private sessionEventOff: (() => void) | undefined
  private sessionFlushOff: (() => void) | undefined
  /** Per-chat FIFO of model final replies parked while disconnected; drained
   * oldest-first on reconnect (M1-B6). */
  private readonly pendingSends = new Map<ChatId, Array<{ text: string; sentAt: number }>>()
  /** Plugin version + git commit, read once for /ver. */
  private pluginVersion: string | undefined
  private pluginCommit: string | undefined
  private stopping = false

  constructor(deps: BridgeDeps) {
    this.deps = deps
    this.registry = new ChatRegistry({
      agents: deps.agents,
      sessionPersistence: deps.sessionPersistence,
      workspaceRegistry: deps.workspaceRegistry,
      agentPresets: deps.agentPresets,
      defaultModel: deps.defaultModel,
      config: deps.config,
      log: (level, message) => deps.log(level, message),
      isStopping: () => this.stopping,
      onChatRemoved: chat => this.stopTyping(chat),
      installChannelScope: agentCtx => this.installChannelScope(agentCtx),
    })
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
    this.registry.mappingLoaded = this.ready().then(async () => {
      await this.registry.loadRetired()
      await this.registry.loadMapping()
    }).then(() => {
      if (this.stopping) return
      this.deps.log('info', 'bridge ready (' + this.registry.chats.size + ' resumed chat(s))')
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
    await this.registry.stop()
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
      if (ref.kind === 'image') this.registry.getSettings(chatId).pendingImageRef = ref
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
    const goal = this.registry.getSettings(chatId).goal
    if (goal !== undefined && goal.trim() !== '') {
      out = '【当前目标】' + goal + '\n' + out
    }
    return out.trim()
  }

  /** Per-chat outbound-mode override (/mode), falling back to the global config. */
  private effectiveInterim(chatId: ChatId): boolean {
    return this.registry.getSettings(chatId).interimOverride ?? this.deps.config.interimMessages
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
      setChatWorkspacePath: (chatId, path) => { bridge.registry.getSettings(chatId).workspacePath = path },
      presetOverride: chatId => bridge.registry.getSettings(chatId).presetOverride,
      setPresetOverride: (chatId, id) => { bridge.registry.getSettings(chatId).presetOverride = id },
      hasPresetOverride: chatId => bridge.registry.getSettings(chatId).presetOverride !== undefined,
      interimOverride: chatId => bridge.registry.getSettings(chatId).interimOverride,
      setInterimOverride: (chatId, value) => { bridge.registry.getSettings(chatId).interimOverride = value },
      goal: chatId => bridge.registry.getSettings(chatId).goal,
      setGoal: (chatId, value) => { bridge.registry.getSettings(chatId).goal = value },
      deleteGoal: chatId => { bridge.registry.getSettings(chatId).goal = undefined },
      lastImagePath: chatId => bridge.registry.getSettings(chatId).lastImagePath,
      takePendingImageRef: chatId => {
        const settings = bridge.registry.getSettings(chatId)
        const ref = settings.pendingImageRef
        if (ref !== undefined) settings.pendingImageRef = undefined
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
    return this.registry.sessionIdFromMapping(chatId)
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
        const settings = this.registry.getSettings(chatId)
        settings.lastImagePath = resolved.path
        settings.pendingImageRef = undefined
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

  // ------------------------------------------------------------ registry facades

  /** Same-name delegations to the chat registry (D1-PR3): the command table's
   * ctx, the interim/turn event links and the outbound pipeline keep calling
   * the bridge exactly as before the split. */

  /** Get (or create) the agent for a chat. */
  private ensureChat(chatId: ChatId, nickname: string): Promise<ChatAgent> {
    return this.registry.ensureChat(chatId, nickname)
  }

  private effectiveCwd(chatId?: ChatId): string {
    return this.registry.effectiveCwd(chatId)
  }

  private resolvePresetId(chatId: ChatId): Promise<string | undefined> {
    return this.registry.resolvePresetId(chatId)
  }

  private saveMappingDebounced(): void {
    this.registry.saveMappingDebounced()
  }

  private healSessionCollision(chatId: ChatId): Promise<void> {
    return this.registry.healSessionCollision(chatId)
  }

  /**
   * /new: the registry disposes the agent and retires its session id so the
   * next inbound message creates a brand-new session (fresh history; the old
   * conversation stays on disk). The confirmation is sent directly through
   * the outbound pipeline since no agent is left to reply.
   */
  private async resetChat(chatId: ChatId): Promise<void> {
    await this.registry.resetChat(chatId)
    this.sendToChat(chatId, '✅ 已开启新会话，下一条消息将进入全新会话，旧对话历史保留在之前的会话中。').catch((error: unknown) => {
      this.deps.log('warn', 'reset notice send failed: ' + String(error))
    })
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
