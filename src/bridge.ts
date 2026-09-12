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
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { realpath } from 'node:fs/promises'


import type { OneBotConnection, OneBotEvent } from './connection.js'
import type { MediaStore } from './media.js'
import type { Transcriber } from './stt.js'
import { transcriptLabel } from './stt.js'
import type { MediaRef } from './cq.js'
import type { ChatId, UserRole } from './chat.js'
import { classifyUserRole, splitChatId } from './chat.js'
import type { AccessPolicyConfig } from './chat.js'
import { buildPlatformPrompt } from './prompt.js'
import { registerTools } from './tools.js'
import { tryHandleCommand as routeCommand, type CommandContext } from './commands.js'
import { relayHostCards as relayCards, type CardRelayContext } from './card-relay.js'
import { OutboundPipeline } from './outbound.js'
import type { OutboundSegment, SendOptions } from './outbound.js'
import { ChatRegistry } from './registry.js'
import type { ChatAgent } from './registry.js'
import { InboundPipeline, normalizeOneBot11 } from './inbound.js'
import type { NormalizedInbound } from './inbound.js'
import { InterimTracker } from './interim.js'
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
  /** M3-D2b degrade switch: false = send-only interims — no auto-recall
   * timers, no turn/end immediate recall and no summary card (the turn ends
   * with the final text only). Absent/true = the full recall behavior. */
  interimRecall?: boolean
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
  /** B8c: chats idle longer than this many days are evicted on the next
   * inbound message (0 disables; default 7). Evicted chats keep their
   * chat→session mapping, so a later message resumes the same session. */
  chatIdleEvictDays?: number
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

/** Live model-catalog port (M2-C5b): the only llm surface the command domain
 * reads (/model). index.ts implements it over a live llm-service lookup so
 * late-registered providers stay visible; commands never touch Context. */
export interface LlmCatalogPort {
  listProviders(): LlmProviderInfo[]
  listModels(provider: string): Promise<LlmModelInfo[]>
}

/** Session-event feed port (M2-C5b): the narrowed event-bus surface the bridge
 * subscribes to, replacing the whole-plugin Context. index.ts satisfies it
 * with the host context itself (its event-bus `on` IS the implementation); the
 * BridgeDeps field keeps the historical name `ctx` because existing test
 * assemblies pass the host context directly. */
export interface SessionEventPort {
  on(type: 'session/event', handler: (session: Session, event: SessionEvent) => void): () => void
  on(type: 'session/flush', handler: (session: Session) => void): () => void
}

/** Services the bridge needs (M2-C5b: the plugin Context enters only through
 * the two explicit ports below — session events and the /model catalog). */
export interface BridgeDeps {
  ctx: SessionEventPort
  /** Resolves once the host's boot-time configuration (the loader service) is
   * fully applied; index.ts owns the 'loader' lookup and swallows its errors.
   * Absent in test assemblies = no gate (matches the previously swallowed
   * lookup). Must not reject. */
  hostReady?: (() => Promise<void>) | undefined
  /** Live model-catalog port for /model (M2-C5b); index.ts implements it over
   * the live llm service. Absent only in assemblies that never route /model. */
  llmCatalog?: LlmCatalogPort | undefined
  connection: OneBotConnection
  /** The dsh data home (default <home>/.dsh); used to enumerate agent presets. */
  dshHome?: string | undefined
  media: MediaStore
  transcriber: Transcriber
  agents: AgentRegistry
  sessions: SessionStore
  agentPresets: AgentPresetsLike | undefined
  /** Host command runtime: forwards /plan so QQ reaches the native plan command.
   * `signal` is REQUIRED by the host implementation (it reads `signal.aborted`
   * unconditionally) — pass a fresh never-aborted one. */
  commands?: { execute(agent: unknown, line: string, signal: AbortSignal): Promise<{ kind?: string; text?: string; result?: { kind?: string; text?: string } }> } | undefined
  /** Durable persistence for cold-reading a session's recorded preset; absent = config/default fallback. */
  sessionPersistence: SessionPersistenceLike | undefined
  workspaceRegistry: WorkspaceRegistryLike | undefined
  agentDefaultModel: AgentDefaultModelLike | undefined
  defaultModel: (() => ModelSelection | undefined) | undefined
  config: BridgeConfig
  policy: AccessPolicyConfig
  /** Log line callback (level, message). */
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
}

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
  /** Inbound pipeline (D1-PR4): normalizeOneBot11 + the policy→media→quote→
   * dispatch path; the same-name bridge methods below delegate here. */
  private readonly inbound: InboundPipeline
  /** Interim domain (D1-PR5): the assistant/message interim routing, the
   * per-message recall timers and the turn/end settlement. */
  private readonly interim: InterimTracker
  /** Live registry indexes — the inbound/outbound/interim/turn links keep
   * reading them through these same-name views. */
  private get chats(): Map<ChatId, ChatAgent> { return this.registry.chats }
  private get bySession(): Map<string, ChatId> { return this.registry.bySession }
  private sessionEventOff: (() => void) | undefined
  private sessionFlushOff: (() => void) | undefined
  /** Plugin version + git commit, read once for /ver. */
  private pluginVersion: string | undefined
  private pluginCommit: string | undefined
  private stopping = false

  constructor(deps: BridgeDeps) {
    this.deps = deps
    this.registry = new ChatRegistry({
      agents: deps.agents,
      sessions: deps.sessions,
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
    this.inbound = new InboundPipeline({
      call: (action, params) => this.deps.connection.call(action, params),
      selfId: () => this.deps.connection.selfId,
      policy: deps.policy,
      getChat: chatId => this.chats.get(chatId),
      getSettings: chatId => this.registry.getSettings(chatId),
      sweepIdleChats: () => this.registry.sweepIdleChats(),
      media: deps.media,
      transcriber: deps.transcriber,
      steerTranscript: (chatId, text) => this.steerTranscript(chatId, text),
      tryHandleCommand: (chatId, text, userId) => this.tryHandleCommand(chatId, text, userId),
      buildBody: (text, media, chatId) => this.buildBody(text, media, chatId),
      expandQuote: messageId => this.expandQuote(messageId),
      dispatchFollowup: (chatId, text, role, nickname) => this.dispatchFollowup(chatId, text, role, nickname),
      sendToChat: (chatId, text) => this.sendToChat(chatId, text),
      log: (level, message) => this.deps.log(level, message),
      config: deps.config,
    })
    this.interim = new InterimTracker({
      sendToChat: (chatId, text, options) => this.sendToChat(chatId, text, options),
      sendMsg: (chatId, segments, options) => this.sendMsg(chatId, segments, options),
      call: (action, params) => this.deps.connection.call(action, params),
      chainTail: chatId => this.outbound.chainTail(chatId),
      relayHostCards: (chatId, content) => this.relayHostCards(chatId, content),
      effectiveInterim: chatId => this.effectiveInterim(chatId),
      log: (level, message) => this.deps.log(level, message),
      config: deps.config,
    })
  }

  /** Start listening: wire connection handlers and the session event feed. */
  start(): void {
    const { connection, ctx: sessionEvents } = this.deps
    connection.selfId = this.deps.config.botQQ
    this.sessionEventOff = sessionEvents.on('session/event', (session: Session, event: SessionEvent) => {
      this.onSessionEvent(session, event)
    })
    this.sessionFlushOff = sessionEvents.on('session/flush', (session: Session) => {
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
    await this.deps.hostReady?.()
  }

  // ------------------------------------------------------------ inbound

  /**
   * Inbound OneBot message event → agent turn. All policy and media work is
   * contained: a failure here logs and drops the message, never the host.
   */
  async handleInbound(event: OneBotEvent): Promise<void> {
    if (this.stopping) return
    try {
      const inbound = normalizeOneBot11(event)
      if (inbound === null) return
      await this.processInbound(inbound)
    } catch (error) {
      this.deps.log('error', 'inbound handling failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  private async processInbound(inbound: NormalizedInbound): Promise<void> {
    await this.inbound.processInbound(inbound)
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
    chat.lastActivityAt = Date.now()
    // M3-D2a: a dispatched user turn starts a fresh interim cycle (the
    // inbound residue reset already cleared the loop fields directly).
    this.interim.onNewUserTurn(chat)
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
   * invocation (the llm catalog especially must stay a live service lookup).
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
      // D4b: /mode and /goal persist with the chat mapping (debounced).
      setInterimOverride: (chatId, value) => { bridge.registry.getSettings(chatId).interimOverride = value; bridge.registry.saveMappingDebounced() },
      goal: chatId => bridge.registry.getSettings(chatId).goal,
      setGoal: (chatId, value) => { bridge.registry.getSettings(chatId).goal = value; bridge.registry.saveMappingDebounced() },
      deleteGoal: chatId => { bridge.registry.getSettings(chatId).goal = undefined; bridge.registry.saveMappingDebounced() },
      lastImagePath: chatId => bridge.registry.getSettings(chatId).lastImagePath,
      takePendingImageRef: chatId => {
        const settings = bridge.registry.getSettings(chatId)
        const ref = settings.pendingImageRef
        if (ref !== undefined) settings.pendingImageRef = undefined
        return ref
      },
      resolveMediaRef: (ref, chatId) => bridge.resolveMediaRef(ref, chatId),
      llmCatalog: bridge.deps.llmCatalog,
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
  private buildBody(text: string, media: MediaRef[], chatId: ChatId): Promise<string> {
    return this.inbound.buildBody(text, media, chatId)
  }

  /** Resolve one media ref to a text annotation with a local path. */
  private resolveMediaRef(ref: MediaRef, chatId: ChatId): Promise<string> {
    return this.inbound.resolveMediaRef(ref, chatId)
  }

  /** M3-D4c: steer a completed voice transcript into the chat's agent — the
   * running turn consumes it at its nearest step boundary; an idle agent
   * opens a turn. No live chat (dispatch dropped/never happened) drops it. */
  private steerTranscript(chatId: ChatId, text: string): void {
    const chat = this.chats.get(chatId)
    if (chat === undefined) {
      this.deps.log('debug', 'voice transcript dropped (no live chat): ' + chatId)
      return
    }
    chat.agent.steer(createUserMessage({
      content: [{ type: 'text', text: transcriptLabel(text) }],
      source: { kind: 'plugin', plugin: 'dsh-onebot' },
    }))
  }

  /** Expand a quoted (reply) message into [引用] text via get_msg. */
  private expandQuote(messageId: string): Promise<string> {
    return this.inbound.expandQuote(messageId)
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

  // ------------------------------------------------------------ session events

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (this.stopping) return
    const chatId = this.bySession.get(session.id)
    if (chatId === undefined) return
    const chat = this.chats.get(chatId)
    if (chat === undefined || chat.sessionId !== session.id) return
    if (event.type === 'turn/start') {
      // B8: a new turn begins — prune the previous turn's recalled-id
      // residue (see InterimTracker.onTurnStart for the safety analysis).
      this.interim.onTurnStart(chat)
      // Freeze the running turn's initiator role from the dispatch FIFO
      // (M1-A2): turns the plugin did not dispatch (host/web input) find an
      // empty queue and fail closed as member.
      chat.activeTurnRole = chat.pendingTurnRoles.shift() ?? 'member'
      chat.lastActivityAt = Date.now()
      chat.busy = true
      return
    }
    if (event.type === 'assistant/message') {
      this.interim.onAssistantMessage(chatId, chat, event.data.message)
      return
    }
    if (event.type === 'turn/end') {
      this.interim.onTurnEnd(chatId, chat)
      if (event.data.reason.kind === 'error' && this.deps.config.sendErrorNotice) {
        const message = event.data.reason.error.message
        this.sendToChat(chatId, '⚠️ 运行出错：' + message, { queuable: true }).catch(() => undefined)
        if (/persisted log on disk that does not match this live session|id collision/i.test(message)) {
          void this.healSessionCollision(chatId)
        }
      }
      this.stopTyping(chat)
      chat.lastActivityAt = Date.now()
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

export { OneBotNotConnectedError, OneBotActionError } from './connection.js'
