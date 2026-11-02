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
import { buildChatId, classifyUserRole, splitChatId } from './chat.js'
import type { AccessPolicyConfig } from './chat.js'
import { buildPlatformPrompt } from './prompt.js'
import { registerTools } from './tools.js'
import { tryHandleCommand as routeCommand, STEER_ACCEPTED_NOTICE, type CommandContext } from './commands.js'
import { relayHostCards as relayCards, type CardRelayContext, type RelayQuestionCall } from './card-relay.js'
import { ASK_USER_TIMEOUT_SECONDS, registerAskUserTool, type AskUserAnswer, type UserQuestionsPort } from './ask-tool.js'
import { holdForegroundWait, type AttachWaitPort, type ForegroundQuestionRequest } from './ask-foreground.js'
import { parseQuestionAnswer } from './question-answer.js'
import { OutboundPipeline } from './outbound.js'
import type { OutboundSegment, SendOptions } from './outbound.js'
import { ChatRegistry } from './registry.js'
import type { ChatAgent } from './registry.js'
import { InboundPipeline, normalizeOneBot11 } from './inbound.js'
import type { NormalizedInbound, QuotedMessageData } from './inbound.js'
import { InterimTracker } from './interim.js'
import { DeferredDelivery } from './deferred.js'
import { DEFAULT_DEFERRED_TIMEOUT_MS } from './deferred.js'
import { describeError, errorStack } from './errors.js'
import { currentTrace, newTraceId, runWithTrace, TRACE_REASONS } from './trace.js'
import type { TraceSink, TraceScope } from './trace.js'
import { runInjectRound, currentInjectRound, isWriteAction, INTERCEPTED_MESSAGE_ID } from './inject.js'
import type { InjectChannel } from './inject.js'
import type { InboundRecorder } from './record.js'
import { healthReport, exportDiagnostics, redactSnapshot } from './health.js'
import type { HealthDeps } from './health.js'
import { FailureRefRegistry, failureRefSuffix } from './ref.js'
import type { FailureRefKind } from './ref.js'
import type { TraceStage } from './trace.js'
/** T2 (P1): the queue notice sent to a chat when a message arrives while its
 * task is running under the default 'queue' policy — at most ONE per running
 * turn (the flag resets at turn/end) so a burst of queued messages never
 * spams the chat. Exported for the deterministic text wait in tests. */
export const QUEUE_NOTICE_TEXT = '⏳ 当前任务运行中，新消息已排队，将在当前任务结束后依次处理。'

/** T2-B2: how long a relayed ask_user_question batch stays interceptable —
 * after this the bridge stops treating plain replies as answers (the host's
 * continued-state question may still be answered from the Web card). */
export const QUESTION_TTL_MS = 15 * 60 * 1000
/** T2-B3: the auto-receipt sent when a QQ reply settles an ask_user_question batch. */
export const ANSWER_ACCEPTED_NOTICE = '✔ 已提交回答'

/** Resolved runtime configuration for the bridge. */
export interface BridgeConfig {
  botQQ: string
  ignoreSelf: boolean
  requireMention: boolean
  /** Unknown slash-command handling (R1): 'intercept' (default) consumes the
   * message with a closest-match suggestion or a hint; 'passthrough' restores
   * the old fall-through to the model. */
  unknownCommand?: 'intercept' | 'passthrough'
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
  /** T8 (#3): auto-receipt notice switches — absent → both on (0.9.x
   * behavior unchanged). steerAccepted gates the steer-mode auto receipt;
   * queue gates the once-per-running-turn queue notice. The explicit /steer
   * command confirmation is a command reply, not an auto receipt, and stays
   * on regardless of this knob. */
  notices?: { steerAccepted?: boolean, queue?: boolean }
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
  /** T2 (P1): preferred mono family names for code text (t2i); absent → t2i platform defaults. */
  monoFamilies?: readonly string[]
  agentPreset: string
  /** 权限分档 A3: 群聊粗档 preset——设置后群聊会话优先使用该 preset id（私聊
   * 仍用 agentPreset）；absent/空串 = 现行为（群私同源 agentPreset）。 */
  agentPresetGroup?: string
  /** 权限分档 A2: 成员档位工具权限。'none'（缺省）= 成员（非管理员）回合
   * 内全部 qq_* 工具在 execute 前被硬拦截；'all' = 不限。fail-closed：
   * 字段缺失按 'none' 处理。 */
  permissions?: { memberTools?: 'none' | 'all' }
  workspacePath: string
  /** Max inbound file bytes fetched via QQ direct link / base64 (0 = no cap). */
  maxInboundFileBytes: number
  /** B8c: chats idle longer than this many days are evicted on the next
   * inbound message (0 disables; default 7). Evicted chats keep their
   * chat→session mapping, so a later message resumes the same session. */
  chatIdleEvictDays?: number
  /** T2 (P1): how a new ordinary message is handled while the chat's task
   * (agent turn) is running; absent → 'queue' (the default). 'queue' = the
   * message keeps the 0.8.1 dispatch path (agent.followup queues it as the
   * next turn — consumed AFTER the current turn ends, in arrival order) and
   * the chat gets at most one queue notice per running turn; 'steer' = plain
   * text (no media/quote/forward, non-restricted senders) is submitted as a
   * supplementary instruction into the running turn via the same
   * agent.steer kernel as steerTranscript, with a per-message submit notice. */
  newMessagePolicy?: 'queue' | 'steer'
  /** T9-B (用户裁决 2026-10-12)：steer 模式下自动插话的发送者资格档位；
   * absent → 'admin'（缺省）。'admin' = 仅管理员可自动插话；'all' = 所有
   * 非受限发送者均可。不改变 /steer 命令（始终仅管理员）与 queue 模式行为，
   * 也不放宽受限用户软限制（受限消息任何档都排队）。 */
  autoSteerPolicy?: 'admin' | 'all'
  /** T3 (P2)：等待模型回复超时阈值（ms）——回合超过该时长没有任何模型输出
   * 时提示超时并登记补发跟踪（deferred delivery），回合完成后向原聊天补发
   * 最终文字（「（超时补发）」前缀，走既有 outbound 管线）；absent →
   * 600000（保守 10 分钟），0 = 关闭超时补发。 */
  deferredTimeoutMs?: number
}

/** W1 trace/config extensions: the observability knobs ride as optional
 * members (same pattern as the W2-②③ gate keys) so the declared BridgeConfig
 * shape above stays untouched; absent = the feature is off (0.6.0 behavior). */
export interface TraceBridgeConfig {
  /** W1: decision-trace sink; absent/disabled = no traceIds, no jsonl, zero
   * behavior difference vs 0.6.0. */
  trace?: TraceSink | undefined
  /** W1/T5: inbound recorder (recordInbound); absent = recording off. */
  recorder?: InboundRecorder | undefined
  /** W1/T5: inject channel (injectEnabled, DEBUG-ONLY); absent = channel off. */
  inject?: InjectChannel | undefined
}

/** Agent-preset service (dsh-agent-presets): joins agents to a preset composition. */
export interface AgentPresetsLike {
  /** The preset id a new session gets when none is named (deployment default). */
  readonly defaultId: string
  /** Resolve one preset by id (undefined = default); throws when no root supplies it. */
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: unknown, id?: string): Promise<{ id: string }>
}

/** Structural slice of one logged session event the /session preview reads
 * — only the preview's fields are named, and the host's SessionEvent (whose
 * 'user/message' payload is a UserMessage) satisfies it. */
export interface SessionPreviewEvent {
  type?: string
  data?: {
    agentPreset?: string
    source?: { kind?: string }
    content?: readonly { type?: string; text?: string }[]
  }
}

/** Narrowed read handle over one stored session (dsh-session-persistence's
 * `SessionHandle` from `open(id, 'read')`): the /session preview reads the
 * immutable header plus a small event prefix and then MUST close the handle
 * (AsyncDisposable — a leaked read handle pins backend resources). */
export interface SessionReadHandleLike {
  readonly header: { createdAt?: number; agentPreset?: string }
  read(offset?: number, length?: number): Promise<{ events: readonly SessionPreviewEvent[] }>
  close(): Promise<void>
}

/** Durable session persistence (dsh-session-persistence): cold-read what a session recorded. */
export interface SessionPersistenceLike {
  /** Existence probe (dsh-session-persistence 0.1.6 `stat`): resolves the
   * stored snapshot, or undefined when the id owns no durable log. Replaces
   * the retired host `inspect` convenience. */
  stat(id: SessionId): Promise<object | undefined>
  /** Open an existing stored session for reading: 'read' never takes write
   * ownership and works while a live writer holds the session. */
  open(id: SessionId, access: 'read'): Promise<SessionReadHandleLike>
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
  /** Host command runtime: forwards /plan and /permission so QQ reaches the
   * native commands. dsh ≥0.1.5-rc.1: `submittedAttachments` (always pass an
   * empty array) and `signal` are both REQUIRED (the host reads `.length` /
   * `.aborted` unconditionally); the settled return is the
   * `{ commandId, result: { kind, text } }` wrapper (older hosts: flat). */
  commands?: { execute(agent: unknown, line: string, submittedAttachments: readonly unknown[], signal: AbortSignal): Promise<{ kind?: string; text?: string; result?: { kind?: string; text?: string } }> } | undefined
  /** Durable persistence for cold reads: the recorded preset at resume and
   * the /session list's per-item content previews; absent = config/default
   * fallback and preview-less list items. */
  sessionPersistence: SessionPersistenceLike | undefined
  workspaceRegistry: WorkspaceRegistryLike | undefined
  agentDefaultModel: AgentDefaultModelLike | undefined
  defaultModel: (() => ModelSelection | undefined) | undefined
  /** T2-B3: the host userQuestions service — settles intercepted QQ replies
   * against the chat's continued-state ask_user_question. Absent (test
   * assemblies / unexpected hosts) = answer interception stays disabled and
   * every reply flows into the conversation normally. */
  userQuestions?: UserQuestionsPort | undefined
  config: BridgeConfig & TraceBridgeConfig
  policy: AccessPolicyConfig
  /** W1/T5 health: the ALREADY-redacted plugin config snapshot (secrets
   * replaced by 已配置/未配置 — see health.redactSnapshot). Absent = the
   * /healthcheck diagnostics export renders without a config section. */
  configSnapshot?: (() => Record<string, unknown>) | undefined
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
  /** T3 (P2): the deferred-delivery tracker (超时补发) — timeout timers, the
   * JSONL registry, bounded send retries and restart recovery. */
  private readonly deferred: DeferredDelivery
  /** T4 (P3): the bounded registry of recent fault references — every minted
   * QQ-CONN-/MF- number is recorded here for the /healthcheck report and the
   * diagnostics archive file name. */
  private readonly failureRefs = new FailureRefRegistry()
  /** Live registry indexes — the inbound/outbound/interim/turn links keep
   * reading them through these same-name views. */
  private get chats(): Map<ChatId, ChatAgent> { return this.registry.chats }
  private get bySession(): Map<string, ChatId> { return this.registry.bySession }
  private sessionEventOff: (() => void) | undefined
  private sessionFlushOff: (() => void) | undefined
  /** W1: chat-level traceId association table — session events arrive on a
   * different async chain than the inbound pipeline, so dispatchFollowup
   * records the initiating traceId per chat here and onSessionEvent reads it
   * back (agent 回复事件归属发起 traceId). Last dispatch wins; entries are
   * dropped when the chat is removed. Not cleared at turn/end: the interim
   * settle loop sends the final reply AFTER turn/end, and clearing there
   * would orphan exactly that reply's outbound events. One entry per chat
   * id (bounded by the chat population), so growth is not a concern. */
  private readonly traceByChat = new Map<ChatId, string>()
  /** T3-board /silent: per-chat silence window (epoch-ms until; no entry =
   * not silenced). The Map is the hot-path READ cache (the QQ message probe
   * stays IO-free); the durable copy is ChatSettings.silentUntil (registry),
   * which rides chat-sessions.json — a restart re-arms a running window and
   * /new keeps it. Writes go through setSilentUntilImpl (memory + settings +
   * debounced save); a bare /silent clears both copies explicitly. */
  private readonly silentUntil = new Map<ChatId, number>()
  /** W1/T5: chatId → the traceId of the chat's unsettled INJECTED round
   * (independent of the trace sink, so the dry-run guard covers the async
   * agent reply even with tracing off). Cleared by a real dispatch to the
   * chat or when the chat is removed. */
  private readonly injectRoundByChat = new Map<ChatId, string>()
  /** T2 (P1): chats that already got the QUEUE_NOTICE_TEXT for their current
   * running turn (one notice per turn; cleared at turn/end and on chat
   * removal — bounded by the chat population). */
  private readonly queueNoticeChats = new Set<ChatId>()
  /** T2-B2: the chat's outstanding ask_user_question batch, keyed by chat id
   * (memory only — a restart loses it and the model re-asks). Populated from
   * the card relay's onQuestionCall, consumed by interceptQuestionAnswer,
   * cleared on settle (user-question-reply event), chat removal and the TTL. */
  private readonly activeQuestion = new Map<ChatId, RelayQuestionCall & { askedAt: number }>()
  /** T3-board: live foreground answerers keyed by callId — the
   * 'user-questions/request' waterfall listener waits on these for the QQ
   * answer (instant settle: the ask tool returns instead of timing out to
   * pending). Populated by onForegroundQuestionRequest, delivered by
   * interceptQuestionAnswer, cleared on settle, chat removal, bridge stop,
   * and each listener's own deadline/host-signal race. */
  private readonly foregroundWaits = new Map<string, {
    chatId: ChatId
    questions: Array<{ id: string }>
    resolve: (answers: AskUserAnswer[] | undefined) => void
  }>()
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
      onChatRemoved: chat => {
        this.stopTyping(chat)
        // W1/T5: forget the chat's injected round (and its trace mapping).
        this.deps.config.inject?.clearChat(chat.chatId)
        this.traceByChat.delete(chat.chatId)
        this.injectRoundByChat.delete(chat.chatId)
        this.queueNoticeChats.delete(chat.chatId)
        this.activeQuestion.delete(chat.chatId)
        // T3-board: a removed chat cannot answer anymore — give up its
        // foreground waits (listeners release their claims and fall through
        // to the pending path).
        this.abandonForegroundWaits(chat.chatId)
      },
      installChannelScope: agentCtx => this.installChannelScope(agentCtx),
    })
    this.outbound = new OutboundPipeline({
      getChat: chatId => this.chats.get(chatId),
      connected: () => this.deps.connection.connected,
      selfId: () => this.deps.connection.selfId,
      call: (action, params, chatId) => this.guardedConnectionCall(action, params, chatId),
      isStopping: () => this.stopping,
      log: (level, message) => this.deps.log(level, message),
      config: deps.config,
      // W1: outbound decision events ride the chat's initiating traceId; a
      // write with no mapped trace (proactive tool sends) starts a fresh one.
      trace: (chatId, event) => {
        const sink = deps.config.trace
        if (sink === undefined || !sink.enabled) return
        const mapped = this.traceByChat.get(chatId)
        sink.emit({ traceId: mapped ?? newTraceId(sink.now()), chatId, ...event })
      },
    })
    this.inbound = new InboundPipeline({
      call: (action, params) => this.guardedConnectionCall(action, params),
      selfId: () => this.deps.connection.selfId,
      policy: deps.policy,
      getChat: chatId => this.chats.get(chatId),
      getSettings: chatId => this.registry.getSettings(chatId),
      sweepIdleChats: () => this.registry.sweepIdleChats(),
      media: deps.media,
      transcriber: deps.transcriber,
      steerTranscript: (chatId, text) => this.steerTranscript(chatId, text),
      tryHandleCommand: (chatId, text, userId, nickname) => this.tryHandleCommand(chatId, text, userId, nickname),
      // T3-board /silent: silence-window probe (reads the in-memory cache
      // backfilled from the persisted ChatSettings at startup; expired
      // entries are pruned from the cache lazily on read — the durable copy
      // expires naturally and is dropped at persist time).
      isSilenced: chatId => {
        const until = this.silentUntil.get(chatId)
        if (until === undefined) return false
        if (until <= Date.now()) {
          this.silentUntil.delete(chatId)
          return false
        }
        return true
      },
      buildBody: (text, media, chatId) => this.buildBody(text, media, chatId),
      expandQuote: (messageId, verifiedData) => this.expandQuote(messageId, verifiedData),
      dispatchFollowup: (chatId, text, role, nickname) => this.dispatchFollowup(chatId, text, role, nickname),
      interceptBusyTurn: (chatId, text, role, nickname, plain) => this.interceptBusyTurn(chatId, text, role, nickname, plain),
      interceptQuestionAnswer: (chatId, text) => this.interceptQuestionAnswer(chatId, text),
      sendToChat: (chatId, text) => this.sendToChat(chatId, text),
      log: (level, message) => this.deps.log(level, message),
      config: deps.config,
    })
    this.interim = new InterimTracker({
      sendToChat: (chatId, text, options) => this.sendToChat(chatId, text, options),
      sendMsg: (chatId, segments, options) => this.sendMsg(chatId, segments, options),
      call: (action, params) => this.guardedConnectionCall(action, params),
      chainTail: chatId => this.outbound.chainTail(chatId),
      relayHostCards: (chatId, content) => this.relayHostCards(chatId, content),
      effectiveInterim: chatId => this.effectiveInterim(chatId),
      log: (level, message) => this.deps.log(level, message),
      config: deps.config,
    })
    this.deferred = new DeferredDelivery({
      sendToChat: (chatId, text, options) => this.sendToChat(chatId, text, options),
      isTurnRunning: chatId => this.chats.get(chatId)?.agent.status === 'running',
      takePendingText: chatId => {
        const chat = this.chats.get(chatId)
        if (chat === undefined || chat.loopPending === null) return null
        const text = chat.loopPending
        chat.loopPending = null
        return text
      },
      traceIdFor: chatId => this.traceByChat.get(chatId),
      log: (level, message) => this.deps.log(level, message),
      trace: (chatId, event) => {
        const sink = deps.config.trace
        if (sink === undefined || !sink.enabled) return
        const mapped = this.traceByChat.get(chatId)
        sink.emit({ traceId: mapped ?? newTraceId(sink.now()), chatId, ...event })
      },
      mediaDir: deps.config.mediaDir,
      timeoutMs: deps.config.deferredTimeoutMs ?? DEFAULT_DEFERRED_TIMEOUT_MS,
      isStopping: () => this.stopping,
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
      await this.registry.loadSwitchable()
      await this.registry.loadMapping()
      // T3-board /silent: replay the persisted still-open silence windows
      // into the in-memory read cache so a restart does not lift a running
      // mute (expired windows were already dropped by loadMapping).
      for (const { chatId, until } of this.registry.silenceWindows()) this.silentUntil.set(chatId, until)
      // T3 (P2): restore deferred-delivery tracking（未完结条目在该会话的
      // 下一次 turn/end 兑现；损坏行降级跳过）。
      await this.deferred.loadPersisted()
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
    // T3 (P2): disarm the deferred silent-wait timers（pending 条目已落盘，
    // 重启后 loadPersisted 恢复跟踪续投）。
    this.deferred.stopAll()
    // T3-board: release every foreground wait claim; the listeners fall
    // through (next() → NO_PROVIDER) and the host wait closes on its own
    // deadline → pending, the pre-T3 path. No claim may outlive the bridge.
    for (const wait of this.foregroundWaits.values()) wait.resolve(undefined)
    this.foregroundWaits.clear()
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
   * 权限分档 A2（工具硬防线）：one tool-call's permission decision. Reuses the
   * M1-A2 turn-level role (frozen at turn/start, fail-closed member) via
   * canEditFiles; a caller with no QQ session mapping (Web/other channels) is
   * outside the tier semantics and stays allowed; permissions.memberTools
   * === 'all' disables the gate entirely. Absent config fails closed to
   * 'none' (members blocked).
   */
  memberToolsAllowed(sessionId: string | undefined): boolean {
    if ((this.deps.config.permissions?.memberTools ?? 'none') === 'all') return true
    if (sessionId === undefined) return true
    return this.canEditFiles(sessionId)
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
   * W1: the whole inbound chain runs inside one trace scope (ALS), so every
   * pipeline decision point can attribute its event to this message's
   * traceId; disabled = no scope, no id, 0.6.0 behavior. W1/T5: injected
   * events (opts.injected) run inside their inject round (ALS) so the
   * dry-run guard covers the whole synchronous chain, and real events are
   * recorded by the inbound recorder when recordInbound is on (injected
   * events are never recorded — no inject→record→replay feedback loop).
   */
  async handleInbound(event: OneBotEvent, opts: { injected?: boolean } = {}): Promise<void> {
    const run = (): Promise<void> => this.handleInboundOnce(event, opts.injected === true)
    return opts.injected === true
      ? runInjectRound({ traceId: newTraceId(), intercepted: 0 }, run)
      : run()
  }

  private async handleInboundOnce(event: OneBotEvent, injected: boolean): Promise<void> {
    // Recording: skipped for injected events (they would otherwise feed the
    // injector again through replay) and skipped when no recorder exists.
    const recorder = injected ? undefined : this.deps.config.recorder
    const session = recorder?.begin(event) ?? undefined
    const trace = this.beginInboundTrace(event)
    const scope = trace !== undefined
      ? (session !== undefined ? session.wrapScope(trace) : trace)
      : session?.captureScope()
    try {
      await runWithTrace(scope, async () => {
        if (this.stopping) {
          this.deps.log('debug', '插件停止中，入站消息丢弃')
          scope?.emit('inbound', { ok: false, reason: TRACE_REASONS.inboundStopping })
          return
        }
        const inbound = normalizeOneBot11(event)
        if (inbound === null) {
          this.deps.log('debug', '非聊天消息事件，不处理（post_type=' + String(event.post_type) + '）')
          scope?.emit('normalize', { ok: false, reason: TRACE_REASONS.inboundNotChat })
          return
        }
        await this.processInbound(inbound)
      })
    } catch (error) {
      scope?.emit('dispatch', { ok: false, reason: '入站处理失败: ' + describeError(error) })
      this.deps.log('error', 'inbound handling failed: ' + describeError(error) + errorStack(error))
    } finally {
      session?.end()
    }
  }

  /** W1: mint the inbound traceId + scope and record the first (收到消息)
   * event; undefined when tracing is off (zero overhead, zero difference).
   * W1/T5: an injected event REUSES its inject round's traceId, so the whole
   * injected round (pipeline decisions + intercepted outbound calls) shares
   * one traceId in the trace stream. */
  private beginInboundTrace(event: OneBotEvent): TraceScope | undefined {
    const sink = this.deps.config.trace
    if (sink === undefined || !sink.enabled) return undefined
    const kind = event.message_type === 'group' ? 'group' : event.message_type === 'private' ? 'private' : undefined
    const chatId = kind !== undefined
      ? buildChatId(kind, String(kind === 'group' ? event.group_id ?? '' : event.user_id ?? ''))
      : ''
    const messageId = event.message_id === undefined || event.message_id === null ? undefined : String(event.message_id)
    const traceId = currentInjectRound()?.traceId ?? newTraceId(sink.now())
    const scope = sink.scope(traceId, chatId, messageId)
    sink.emit({ traceId: scope.traceId, stage: 'inbound', ok: true, chatId, messageId, data: { messageType: String(event.message_type ?? '') } })
    return scope
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
    // messages to this plugin's own producer-owned source kind, keeping them
    // distinguishable from host/web UI inputs.
    chat.agent.followup(createUserMessage({
      content: [{ type: 'text', text: final }],
      source: { kind: 'plugin:dsh-onebot' },
    }))
    // W1 cross-stream join: the turn's session events arrive on a different
    // async chain, so record this dispatch's traceId per chat for
    // onSessionEvent to pick up (runs inside the inbound ALS scope — command
    // dispatches reach here through the same await chain).
    const trace = currentTrace()
    if (trace !== undefined) {
      this.traceByChat.set(chatId, trace.traceId)
      trace.emit('dispatch', { ok: true, reason: '消息已投递给模型' })
    }
    // W1/T5 inject bookkeeping: an injected dispatch registers its round for
    // this chat (the async reply stays attributable — INDEPENDENT of tracing,
    // so the dry-run guard also works with the trace sink off); a real
    // dispatch clears any leftover injected round so real users are never
    // collaterally intercepted by the dry-run guard.
    const injectedRound = currentInjectRound()
    if (injectedRound !== undefined) this.injectRoundByChat.set(chatId, injectedRound.traceId)
    else this.injectRoundByChat.delete(chatId)
    this.deps.config.inject?.noteDispatch(chatId)
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
   * send path plus the bridge log — the only capabilities the relay touches.
   * T2-B2 adds onQuestionCall to record the outstanding batch. */
  private get cardRelayCtx(): CardRelayContext {
    return {
      sendToChat: (chatId, text) => this.sendToChat(chatId, text),
      log: (level, message) => this.deps.log(level, message),
      onQuestionCall: (chatId, call) => {
        this.activeQuestion.set(chatId, { ...call, askedAt: Date.now() })
      },
    }
  }

  /** T2-B2: the chat's outstanding ask_user_question batch, or undefined when
   * there is none or the TTL (QUESTION_TTL_MS) has expired (expired entries
   * are dropped lazily — no timer needed). */
  private activeQuestionFor(chatId: ChatId): RelayQuestionCall | undefined {
    const entry = this.activeQuestion.get(chatId)
    if (entry === undefined) return undefined
    if (Date.now() - entry.askedAt > QUESTION_TTL_MS) {
      this.activeQuestion.delete(chatId)
      return undefined
    }
    return entry
  }

  /**
   * T2-B3: intercept a plain QQ message that parses as a reply to the chat's
   * outstanding ask_user_question batch (选项选择 / 答:前缀 / 跳过 — see
   * question-answer.ts) and settle it through the host userQuestions service
   * (the chat's live root agent). Runs in the inbound pipeline before the
   * busy-turn seam. Any failure — no active batch, not an answer shape, no
   * userQuestions service, BAD_ANSWER / REPLY_QUEUED / returned false —
   * falls through so the message reaches the conversation normally.
   * @param chatId - the chat the reply arrived in.
   * @param text - raw parsed inbound text.
   * @returns true when the message was consumed as an answer.
   */
  private async interceptQuestionAnswer(chatId: ChatId, text: string): Promise<boolean> {
    if (this.deps.userQuestions === undefined) return false
    const entry = this.activeQuestionFor(chatId)
    if (entry === undefined) return false
    const answers = parseQuestionAnswer(text, entry.questions)
    if (answers === undefined) return false
    const chat = this.chats.get(chatId)
    if (chat === undefined) return false
    // T3-board: a live foreground wait (the ask tool's waterfall answerer)
    // settles instantly — the tool is still in its wait window and receives
    // the result instead of timing out to pending. Falls through to the
    // answer() path when no wait matches (the pending state).
    if (this.deliverForegroundAnswer(chatId, answers)) {
      this.sendToChat(chatId, ANSWER_ACCEPTED_NOTICE).catch((error: unknown) => {
        this.deps.log('debug', '回答回执发送失败: ' + describeError(error))
      })
      return true
    }
    try {
      const settled = await this.deps.userQuestions.answer(chat.agent, entry.callId, { answers })
      if (settled !== true) return false
    } catch (error: unknown) {
      // BAD_ANSWER / REPLY_QUEUED / callId no longer continued → not ours to
      // consume; the message continues into the conversation.
      this.deps.log('debug', 'question answer settle failed: ' + describeError(error))
      return false
    }
    this.activeQuestion.delete(chatId)
    this.sendToChat(chatId, ANSWER_ACCEPTED_NOTICE).catch((error: unknown) => {
      this.deps.log('debug', '回答回执发送失败: ' + describeError(error))
    })
    return true
  }

  /** T3-board: the chat whose live root agent is `agent` (identity first,
   * then the session id as a defensive fallback). */
  private chatIdForAgent(agent: unknown): ChatId | undefined {
    if (agent === undefined || agent === null) return undefined
    for (const chat of this.chats.values()) {
      if (chat.agent === agent) return chat.chatId
    }
    const sessionId = (agent as { session?: { id?: unknown } } | undefined)?.session?.id
    if (typeof sessionId === 'string') {
      const chatId = this.bySession.get(sessionId as SessionId)
      if (chatId !== undefined) return chatId
    }
    return undefined
  }

  /** T3-board: try to settle a live foreground wait with a parsed QQ answer
   * batch (instant settle). Only a wait whose question ids are exactly
   * covered by the parsed answers accepts the delivery; anything else stays
   * for the answer() (pending) path. */
  private deliverForegroundAnswer(chatId: ChatId, answers: ReadonlyArray<AskUserAnswer>): boolean {
    if (this.foregroundWaits.size === 0) return false
    const byId = new Map(answers.map(answer => [answer.id, answer]))
    for (const [callId, wait] of this.foregroundWaits) {
      if (wait.chatId !== chatId) continue
      const batch = wait.questions.map(question => byId.get(question.id))
      if (batch.some(answer => answer === undefined)) continue
      this.foregroundWaits.delete(callId)
      this.activeQuestion.delete(chatId)
      wait.resolve(batch as AskUserAnswer[])
      return true
    }
    return false
  }

  /** T3-board: resolve-and-drop every foreground wait belonging to `chatId`;
   * each listener sees undefined, releases its claim and falls through. */
  private abandonForegroundWaits(chatId: ChatId): void {
    for (const [callId, wait] of this.foregroundWaits) {
      if (wait.chatId !== chatId) continue
      this.foregroundWaits.delete(callId)
      wait.resolve(undefined)
    }
  }

  /**
   * T3-board: the per-agent 'user-questions/request' waterfall listener
   * (registered from installChannelScope). The host dispatches timed asks as
   * `{ ...request, agent, signal: wait.signal, wait: { callId, timed: true } }`
   * with the innermost noAnswerer (NO_PROVIDER) last; the Web forwarder is
   * the listener registered before us, so we only see asks the Web layer did
   * not settle. Answering = returning { answers } (vetoing next()); anything
   * else — not timed, no callId, no matching QQ chat, attach failed, deadline
   * reached, host wait closed, aborted — falls through via next() so the
   * existing 300s→pending→inbound answer() path stays intact (fail-open).
   */
  private async onForegroundQuestionRequest(request: ForegroundQuestionRequest, next: () => Promise<unknown>): Promise<unknown> {
    const callId = request.wait?.callId
    if (request.wait?.timed !== true || typeof callId !== 'string' || callId === '') return next()
    const chatId = this.chatIdForAgent(request.agent)
    if (chatId === undefined) return next()
    const questions = (Array.isArray(request.questions) ? request.questions : [])
      .map(question => (question !== null && typeof question === 'object' ? (question as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string')
    if (questions.length === 0) return next()
    // Without a host signal the wait cannot be bounded — never hold it.
    const signal = request.signal
    if (signal === undefined) return next()

    // Hold the host's wait stream: the claim suppresses the host deadline
    // timer while we wait for the QQ answer. No hold (attach yielded no
    // frames / port lacks attachWait / attach threw) → the host timer keeps
    // running and the signal-abort race still bounds this listener.
    const service = this.deps.userQuestions as unknown
    const attachPort = service !== undefined && typeof (service as Partial<AttachWaitPort>).attachWait === 'function'
      ? service as AttachWaitPort
      : undefined
    const hold = attachPort === undefined ? undefined : await holdForegroundWait(attachPort, request.agent, callId, signal)

    const delivery = Promise.withResolvers<AskUserAnswer[] | undefined>()
    this.foregroundWaits.set(callId, { chatId, questions: questions.map(id => ({ id })), resolve: delivery.resolve })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const giveUp = new Promise<undefined>(resolve => {
        if (signal.aborted) {
          resolve(undefined)
          return
        }
        signal.addEventListener('abort', () => resolve(undefined), { once: true })
        if (hold !== undefined) {
          void hold.ended.then(() => resolve(undefined))
          timer = setTimeout(() => resolve(undefined), hold.remainingMs)
        }
      })
      const winner = await Promise.race([delivery.promise, giveUp])
      if (winner === undefined) {
        // Deadline reached / host closed the wait / aborted → release the
        // claim (the host timer re-arms and closes the wait with
        // ASK_TIMED_OUT → pending) and pass the request on; the innermost
        // noAnswerer rejects NO_PROVIDER and askTimed maps it to pending.
        return next()
      }
      return { answers: winner }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.foregroundWaits.delete(callId)
      hold?.release()
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
   * @param nickname - sender display name (pre-sanitized; T9-A /steer boundary).
   * @returns true when the message was consumed by a command.
   */
  private tryHandleCommand(chatId: ChatId, text: string, userId: string, nickname?: string): Promise<boolean> {
    return routeCommand(this.commandCtx, chatId, text, userId, nickname)
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
      // T3 (P2): /stop 也显式终止该聊天的超时补发跟踪（其他聊天不受影响）。
      stopDeferredTracking: chatId => bridge.deferred.cancelChat(chatId),
      // T2 (P1): /steer — the bridge-owned steer core keeps the createUserMessage
      // source write point in bridge.ts (producer-owned kind, session-v4 guard).
      steerRunningTurn: (chatId, text) => bridge.steerMessage(chatId, text),
      effectiveCwd: chatId => bridge.effectiveCwd(chatId),
      sessionIdFromMapping: chatId => bridge.sessionIdFromMapping(chatId),
      resolvePresetId: chatId => bridge.resolvePresetId(chatId),
      // T3: /workspace persists with the chat mapping (debounced). When the
      // chat is not live, noteWorkspaceOverride snapshots it into the registry
      // so the flush actually reaches the mapping file instead of being
      // dropped by the chats/evictedChats-only rewrite.
      setChatWorkspacePath: (chatId, path) => {
        bridge.registry.getSettings(chatId).workspacePath = path
        bridge.registry.noteWorkspaceOverride(chatId)
        bridge.registry.saveMappingDebounced()
      },
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
      // R2: pending serial-number selection snapshot (lazy TTL lives in commands).
      pendingSelection: chatId => bridge.registry.getSettings(chatId).pendingSelection,
      setPendingSelection: (chatId, value) => { bridge.registry.getSettings(chatId).pendingSelection = value },
      // /session: the per-chat switchable history and the switch itself.
      switchableSessions: chatId => bridge.registry.switchableSessions(chatId),
      // T4 (#15): the run-scoped broken-session count (the retire record) so
      // the /session list can surface quarantined history.
      brokenSessionCount: () => bridge.registry.brokenSessionCount(),
      switchSession: (chatId, targetSessionId) => bridge.registry.switchSession(chatId, targetSessionId),
      // /session list previews: cold-read each retired session's first user
      // input through the persistence port (read handle, small prefix).
      sessionPersistence: bridge.deps.sessionPersistence,
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
      // W1/T5: the healthcheck command renders/packs through the bridge.
      healthReport: () => bridge.buildHealthReport(),
      // T4 (P3): export takes an optional trigger reference (file-name stamp).
      exportDiagnostics: triggerRef => bridge.exportDiagnosticsPackage(triggerRef),
      // T4 (P3): command-plane failures (/retry) mint an MF- reference through
      // the bridge's single entry point (registry + trace + structured log).
      reportFailure: (chatId, stage, detail) => bridge.registerMessageFailure(chatId, stage, detail),
      // T3-board /silent: read the in-memory cache; writes sync both copies
      // (cache + durable ChatSettings field, debounced save).
      silentUntil: chatId => bridge.getSilentUntil(chatId),
      setSilentUntil: (chatId, untilMs) => bridge.setSilentUntilImpl(chatId, untilMs),
      config: { interimMessages: bridge.deps.config.interimMessages, maxImageBytes: bridge.deps.config.maxImageBytes, unknownCommand: bridge.deps.config.unknownCommand },
    }
  }

  /** T3-board /silent: the chat's silence-window end (in-memory read cache). */
  private getSilentUntil(chatId: ChatId): number | undefined {
    return this.silentUntil.get(chatId)
  }

  /** T3-board /silent: write BOTH copies of the silence window — the
   * in-memory hot-path cache and the durable ChatSettings.silentUntil (the
   * debounced mapping save; persistEntry drops already-expired values).
   * `undefined` clears. Survives /new (silence belongs to the chat, not the
   * session); a bare /silent clears both copies explicitly. */
  private setSilentUntilImpl(chatId: ChatId, untilMs: number | undefined): void {
    if (untilMs === undefined) this.silentUntil.delete(chatId)
    else this.silentUntil.set(chatId, untilMs)
    const settings = this.registry.getSettings(chatId)
    if (untilMs === undefined) {
      if (settings.silentUntil !== undefined) {
        delete settings.silentUntil
        this.registry.saveMappingDebounced()
      }
      return
    }
    settings.silentUntil = untilMs
    this.registry.saveMappingDebounced()
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
    if (this.steerMessage(chatId, transcriptLabel(text))) return
    this.deps.log('debug', 'voice transcript dropped (no live chat): ' + chatId)
    currentTrace()?.emit('dispatch', { ok: false, reason: TRACE_REASONS.transcriptNoChat })
  }

  /** T2 (P1): the single agent.steer write point — one createUserMessage with
   * the producer-owned source kind (the session-v4 guard counts the source
   * write points; this and dispatchFollowup are the only two). Shared by the
   * voice transcript path (steerTranscript), the 'steer' policy and /steer.
   * Returns false when the chat has no live agent (nothing was steered). */
  private steerMessage(chatId: ChatId, text: string): boolean {
    const chat = this.chats.get(chatId)
    if (chat === undefined) return false
    chat.agent.steer(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-onebot' },
    }))
    return true
  }

  /**
   * T2 (P1): the busy-turn policy seam (inbound ctx.interceptBusyTurn).
   * Called for every non-command message AFTER all gates, only when deciding
   * what to do with it while the chat's task is running:
   * - no running turn → false (caller dispatches normally; the 0.8.1 path,
   *   byte-identical — also the path for newMessagePolicy缺省 idle traffic);
   * - 'steer' policy + plain text + non-restricted sender + autoSteerPolicy
   *   eligibility ('admin' 档缺省 = 仅管理员；'all' 档不限，T9-B 用户裁决
   *   2026-10-12) → the message is submitted into the running turn via the
   *   steerMessage kernel (consumed at the nearest step boundary, NO new turn)
   *   and a submit notice goes out;
   * - otherwise (queue policy default / media-quote-forward message /
   *   restricted group member / 不具备自动插话资格) → the 0.8.1 dispatch path
   *   (agent.followup queues it as the next turn: consumed after the current
   *   turn ends, in arrival order) plus the queue notice at most once per
   *   running turn.
   * The running check reads the agent's own lifecycle state — the same
   * authoritative signal /stop uses; chat.busy (turn/start..turn/end view)
   * can lag the host driver and is deliberately NOT consulted.
   */
  private async interceptBusyTurn(chatId: ChatId, text: string, role: UserRole, nickname: string | undefined, plain: boolean): Promise<boolean> {
    const chat = this.chats.get(chatId)
    if (chat === undefined || chat.agent.status !== 'running') return false
    // The restricted-member soft limit ([受限用户:仅问答]) is never widened by
    // the steer policy: restricted senders' messages queue like everyone
    // else's media. The condition mirrors the RESTRICTED_PREFIX application
    // in the inbound pipeline (group + non-admin + restrictedMemberPrefix).
    const restricted = splitChatId(chatId).kind === 'group'
      && role !== 'admin' && this.deps.config.restrictedMemberPrefix
    // T9-B: auto-steer eligibility (user ruling 2026-10-12) — 'admin' (缺省)
    // = admins only; 'all' = anyone. Restricted members stay excluded under
    // both; /steer remains admin-only regardless of this knob; queue mode is
    // untouched.
    const autoSteerAllowed = (this.deps.config.autoSteerPolicy ?? 'admin') === 'all' || role === 'admin'
    if ((this.deps.config.newMessagePolicy ?? 'queue') === 'steer' && plain && !restricted && autoSteerAllowed) {
      this.steerMessage(chatId, text)
      currentTrace()?.emit('dispatch', { ok: true, reason: TRACE_REASONS.busyTurnSteered })
      // T8 (#3): the auto receipt is switchable (notices.steerAccepted);
      // the steer itself always happens.
      if (this.deps.config.notices?.steerAccepted ?? true) {
        this.sendToChat(chatId, STEER_ACCEPTED_NOTICE).catch((error: unknown) => {
          this.deps.log('debug', '插话提交提示发送失败: ' + describeError(error))
          currentTrace()?.emit('notice', { ok: false, reason: '插话提交提示发送失败: ' + describeError(error) })
        })
      }
      return true
    }
    await this.dispatchFollowup(chatId, text, role, nickname)
    currentTrace()?.emit('dispatch', { ok: true, reason: TRACE_REASONS.busyTurnQueued })
    // T8 (#3): the once-per-running-turn queue notice is switchable
    // (notices.queue); the queueing itself always happens.
    if ((this.deps.config.notices?.queue ?? true) && !this.queueNoticeChats.has(chatId)) {
      this.queueNoticeChats.add(chatId)
      this.sendToChat(chatId, QUEUE_NOTICE_TEXT).catch((error: unknown) => {
        this.deps.log('debug', '排队提示发送失败: ' + describeError(error))
        currentTrace()?.emit('notice', { ok: false, reason: '排队提示发送失败: ' + describeError(error) })
      })
    }
    return true
  }

  /** Expand a quote, forwarding a verified response without repeating get_msg. */
  private expandQuote(messageId: string, verifiedData?: QuotedMessageData): Promise<string> {
    return this.inbound.expandQuote(messageId, verifiedData)
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

  // ------------------------------------------------------------ inject dry-run guard

  /**
   * W1/T5: the single connection-call gate every bridge pipeline
   * (inbound/outbound/interim/typing) routes through. In inject dry-run
   * mode, WRITE actions of an injected round are intercepted at this
   * outbound action layer: counted, traced with the original text, resolved
   * with the marker message id — the real OneBot connection never sees them.
   * Attribution: (a) the synchronous chain via the inject round's ALS, (b)
   * the async agent reply via the chat→round association (injectRoundByChat,
   * independent of the trace sink), (c) recalls of already-intercepted sends
   * via the marker message id (a real OneBot id is never negative).
   */
  private guardedConnectionCall(action: string, params: Record<string, unknown>, chatId?: ChatId): Promise<unknown> {
    const inject = this.deps.config.inject
    if (inject === undefined || !inject.intercepting || !isWriteAction(action)) {
      return this.deps.connection.call(action, params)
    }
    const alsRound = currentInjectRound()
    if (alsRound !== undefined) return inject.intercept(alsRound, action, params)
    if (chatId !== undefined) {
      const round = inject.activeRoundFor(chatId)
      if (round !== undefined && this.injectRoundByChat.get(chatId) === round.traceId) {
        return inject.intercept(round, action, params)
      }
    }
    if ((params as { message_id?: unknown }).message_id === INTERCEPTED_MESSAGE_ID) {
      // Recall of an intercepted send (interim path has no chatId): count it
      // on the marker rule even without a resolvable round.
      return inject.intercept(undefined, action, params)
    }
    return this.deps.connection.call(action, params)
  }

  // ------------------------------------------------------------ health (W1/T5)

  /** The health deps the /healthcheck command renders from (resolved live). */
  private healthDeps(): HealthDeps {
    const conn = this.deps.connection as unknown as {
      reverseRetryAttempts?: number
      reconnectAttempts?: number
      selfHealing?: boolean
      config?: { mode?: string; host?: string; port?: number }
    }
    const transport = conn.config ?? {}
    const recorder = this.deps.config.recorder
    const inject = this.deps.config.inject
    return {
      mediaDir: this.deps.config.mediaDir,
      connection: { connected: this.deps.connection.connected, selfId: this.deps.connection.selfId },
      transport: { mode: String(transport.mode ?? '未知'), host: String(transport.host ?? ''), port: Number(transport.port ?? 0) },
      retryState: {
        reverseRetryAttempts: conn.reverseRetryAttempts,
        reconnectAttempts: conn.reconnectAttempts,
        selfHealing: conn.selfHealing,
      },
      dedup: {
        entries: this.inbound.dedupWindowEntries,
        // The W2-② window key rides as an optional intersection member.
        windowSeconds: (this.deps.config as { dedupWindowSeconds?: number }).dedupWindowSeconds ?? 300,
      },
      writeGate: this.outbound.writeGateStats(),
      ...(recorder !== undefined
        ? { recorder: { enabled: true, redact: recorder.redact, written: recorder.getStats().written } }
        : {}),
      ...(inject !== undefined
        ? {
            inject: {
              enabled: true, dryRun: inject.intercepting,
              consumed: inject.getStats().consumed, intercepted: inject.getStats().intercepted,
              skippedHistory: inject.getStats().skippedHistory,
            },
          }
        : {}),
      configSnapshot: this.deps.configSnapshot?.() ?? {},
      // T4 (P3): the recent fault references for the report section.
      failureRefs: () => this.failureRefs.recent(),
      log: (level, message) => this.deps.log(level, message),
    }
  }

  /** /healthcheck: render the health summary. */
  private async buildHealthReport(): Promise<string> {
    return healthReport(this.healthDeps())
  }

  /** /healthcheck export: pack the redacted diagnostics archive. T4 (P3): the
   * file name carries the trigger reference — the explicit command argument,
   * or the most recent recorded fault reference when omitted. */
  private async exportDiagnosticsPackage(triggerRef?: string): Promise<string> {
    const deps = this.healthDeps()
    return exportDiagnostics({ ...deps, triggerRef: triggerRef ?? this.failureRefs.recent(1)[0]?.ref })
  }

  // ------------------------------------------------------------ session events

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (this.stopping) return
    const chatId = this.bySession.get(session.id)
    if (chatId === undefined) {
      // pipeline-hooks.md #20: non-QQ sessions (web/host) ride this same bus;
      // keep the early exit visible at debug without emitting any trace.
      this.deps.log('debug', 'session 事件早退：无 chat 映射（session=' + session.id + ' type=' + String(event.type) + '）')
      return
    }
    const chat = this.chats.get(chatId)
    if (chat === undefined || chat.sessionId !== session.id) return
    const trace = this.traceForChat(chatId)
    if (event.type === 'user/message') {
      // T2-B2: a user-question-reply user message (this bridge's settled
      // answer, or a Web-side answer) means the outstanding batch is settled —
      // drop it so later plain text stops being intercepted as answers.
      const source = (event.data as { source?: { kind?: string } }).source
      if (source?.kind === 'user-question-reply') this.activeQuestion.delete(chatId)
      return
    }
    if (event.type === 'turn/start') {
      trace?.emit('agent', { ok: true, reason: '模型回合开始' })
      // B8: a new turn begins — prune the previous turn's recalled-id
      // residue (see InterimTracker.onTurnStart for the safety analysis).
      this.interim.onTurnStart(chat)
      // Freeze the running turn's initiator role from the dispatch FIFO
      // (M1-A2): turns the plugin did not dispatch (host/web input) find an
      // empty queue and fail closed as member.
      chat.activeTurnRole = chat.pendingTurnRoles.shift() ?? 'member'
      chat.lastActivityAt = Date.now()
      chat.busy = true
      // T3 (P2): arm the deferred silent-wait window for this turn（每次模型
      // 输出重置；turn/end 解除；deferredTimeoutMs<=0 时为 no-op）。
      this.deferred.onTurnStart(chatId, session.id)
      return
    }
    if (event.type === 'assistant/message') {
      // T3 (P2): a deferred-registered (timed-out) turn is muted — its text
      // messages are captured for the final补发 only（不插播 interim、不转
      // 审批/提问卡：超时后只补最终文字与终态通知）。
      if (this.deferred.onAssistantMessage(chatId, session.id, event.data.message)) return
      this.interim.onAssistantMessage(chatId, chat, event.data.message)
      return
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason
      // T4 (P3): a message-turn fault mints ONE MF- reference before any
      // consumer runs — the trace event (data.ref), the structured log line,
      // the ⚠️ notice tail and the deferred terminal text all carry the same
      // number. Normal (completed/cancelled) turns mint nothing.
      const errorRef = reason.kind === 'error'
        ? this.mintFailureRef('msg', 'agent', '模型回合出错: ' + reason.error.message, { chatId })
        : undefined
      // T3 (P2): complete a deferred entry（补发异步进行）；true = the turn was
      // under deferred tracking — the terminal-state notice rides the补发
      // path, so the normal error notice below is suppressed（同一故障不双发）.
      const deferredTracked = this.deferred.onTurnEnd(chatId, session.id, reason, errorRef)
      this.interim.onTurnEnd(chatId, chat)
      if (reason.kind === 'error') {
        // T4: the ok:false agent event is emitted by mintFailureRef (with
        // data.ref) — no second event for the same decision point.
      } else {
        trace?.emit('agent', { ok: true, reason: '模型回合结束（' + reason.kind + '）' })
      }
      if (reason.kind === 'error') {
        const message = reason.error.message
        // 基线语义保持：碰撞自愈原本挂在 sendErrorNotice 分支内；deferred
        // 回合的终态走补发通道，也必须自愈，故闸为 sendErrorNotice || deferredTracked。
        if ((this.deps.config.sendErrorNotice || deferredTracked)
          && /persisted log on disk that does not match this live session|id collision/i.test(message)) {
          void this.healSessionCollision(chatId)
        }
        if (!deferredTracked && this.deps.config.sendErrorNotice) {
          this.sendToChat(chatId, '⚠️ 运行出错：' + message + failureRefSuffix(errorRef), { queuable: true }).catch((error: unknown) => {
            // pipeline-hooks.md #21: the send failure used to be swallowed.
            this.deps.log('debug', '错误通知发送失败: ' + describeError(error))
            trace?.emit('notice', { ok: false, reason: TRACE_REASONS.noticeErrorSendFailed })
          })
        }
      }
      // #4a: a 'blocked' turn claims the user's message then discards it in
      // the pre-step rejection — without a notice the user sees pure silence
      // and reads it as the bot ignoring them. Same fault-notice discipline
      // as the error branch above: queuable send; a deferred-tracked turn
      // keeps its single terminal notice on the补发 path instead.
      if (reason.kind === 'blocked' && !deferredTracked && this.deps.config.sendErrorNotice) {
        this.sendToChat(chatId, '⚠️ 该消息未生成回复：回合在开始处理前被系统拦截，请稍后重发。', { queuable: true }).catch((error: unknown) => {
          this.deps.log('debug', '拦截提示发送失败: ' + describeError(error))
          trace?.emit('notice', { ok: false, reason: TRACE_REASONS.noticeErrorSendFailed })
        })
      }
      this.stopTyping(chat)
      chat.lastActivityAt = Date.now()
      chat.busy = false
      // T2 (P1): the turn that armed the queue notice is over — a later
      // running turn notifies again.
      this.queueNoticeChats.delete(chatId)
      this.deps.log('info', 'turn/end for ' + chatId + ': ' + event.data.reason.kind)
      // Durable: flush the session so a later restart can resume it.
      void this.deps.sessions.flush(chat.agent.session).catch((error: unknown) => {
        this.deps.log('warn', 'session flush failed: ' + String(error))
        trace?.emit('notice', { ok: false, reason: '会话落盘失败: ' + String(error) })
      })
      void this.saveMappingDebounced()
    }
  }

  /** W1: the trace scope for one chat's session events, resolved through the
   * chat-level association table; undefined when tracing is off or the chat
   * has no recorded dispatch (host-initiated turns stay untraced). */
  private traceForChat(chatId: ChatId): TraceScope | undefined {
    const sink = this.deps.config.trace
    if (sink === undefined || !sink.enabled) return undefined
    const traceId = this.traceByChat.get(chatId)
    return traceId !== undefined ? sink.scope(traceId, chatId) : undefined
  }

  // ------------------------------------------------------ failure references (W3/T4)

  /**
   * T4 (P3): the single fault-reference entry point. Mints one QQ-CONN-/MF-
   * number, records it in the bounded registry, emits the ok:false trace
   * event carrying `data.ref` (traceId = the chat's mapped id, or a fresh id
   * for chat-less connection faults), and writes the structured error log
   * line — every surface of the fault shares this one number. Called only on
   * fault events: normal traffic mints nothing (zero overhead).
   */
  private mintFailureRef(kind: FailureRefKind, stage: TraceStage, detail: string, opts: { chatId?: ChatId } = {}): string {
    const ref = this.failureRefs.mint(kind)
    const traceId = opts.chatId !== undefined ? this.traceByChat.get(opts.chatId) : undefined
    this.failureRefs.record({ ref, kind, ts: Date.now(), stage, detail, traceId })
    const sink = this.deps.config.trace
    if (sink !== undefined && sink.enabled) {
      sink.emit({
        traceId: traceId ?? newTraceId(sink.now()),
        chatId: opts.chatId,
        stage,
        ok: false,
        reason: detail,
        data: { ref, refKind: kind },
      })
    }
    this.deps.log('error', '故障参考号 ' + ref + ' [' + stage + ']: ' + detail)
    return ref
  }

  /** T4: connection-fault reference entry (wired from index.ts via
   * `connection.onFailure`); the returned reference is appended to the
   * transport's own log line. */
  registerConnectionFailure(stage: string, detail: string): string {
    return this.mintFailureRef('conn', 'connection', detail)
  }

  /** T4: message-fault reference entry for command-plane failures (e.g. the
   * /retry dispatch throw); the caller appends the returned reference to the
   * user-visible ⚠️ notice. */
  registerMessageFailure(chatId: ChatId, stage: TraceStage, detail: string): string {
    return this.mintFailureRef('msg', stage, detail, { chatId })
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
    // T2-B1: expose ask_user_question to QQ sessions (timed variant, 300s
    // default). The host registers the tool only for preset/Web scopes, and
    // the platform prompt previously banned the call on QQ; now QQ sessions
    // get a scoped shadow whose pending/answer loop the bridge settles (B2/B3).
    registerAskUserTool(agentCtx, {
      timeoutSeconds: ASK_USER_TIMEOUT_SECONDS,
      log: (level, message) => this.deps.log(level, message),
    })
    // T3-board: instant settle during the ask foreground wait — timed asks
    // dispatch 'user-questions/request' as a waterfall (the Web forwarder is
    // registered before us on the host root; the innermost noAnswerer last).
    // This listener answers from QQ; every non-timed / non-QQ case falls
    // through via next() (fail-open to the 300s→pending path).
    ;(agentCtx as { on: (event: string, listener: (request: unknown, next: () => Promise<unknown>) => unknown) => () => void })
      .on('user-questions/request', (request, next) => this.onForegroundQuestionRequest(request as ForegroundQuestionRequest, next))
  }

  // ------------------------------------------------------------ typing

  /** Start the NapCat typing indicator (private chats only). */
  private startTyping(chat: ChatAgent): void {
    const ref = splitChatId(chat.chatId)
    if (ref.kind !== 'private') return
    this.stopTyping(chat)
    const pulse = (): void => {
      if (this.stopping) return
      void this.guardedConnectionCall('set_input_status', {
        user_id: Number(ref.target),
        event_type: 1,
      }, chat.chatId).catch(() => undefined)
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
    void this.guardedConnectionCall('set_input_status', {
      user_id: Number(ref.target),
      event_type: 0,
    }, chat.chatId).catch(() => undefined)
  }
}

export { OneBotNotConnectedError, OneBotActionError } from './connection.js'
