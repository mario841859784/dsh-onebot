/**
 * The chat↔agent bridge: one Agent per QQ chat, inbound message pipeline
 * (policy → parse → media → STT → quote/forward expansion → followup),
 * outbound delivery driven by session events (assistant/message, turn/end),
 * typing indicator, per-chat send ordering, and chat→session mapping
 * persistence for restart resume. Ported from the Hermes OneBotAdapter
 * gateway-interaction half onto the dsh headless-runner agent pattern.
 * @module dsh-onebot/bridge
 */
import type { AgentRegistry, ModelSelection } from '@deepseek-ai/dsh-agent';
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent, SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import type { OneBotConnection, OneBotEvent } from './connection.js';
import type { MediaStore } from './media.js';
import type { Transcriber } from './stt.js';
import type { ChatId } from './chat.js';
import type { AccessPolicyConfig } from './chat.js';
import { type NoticeTexts } from './notices.js';
import { type UserQuestionsPort } from './ask-tool.js';
import type { OutboundSegment, SendOptions } from './outbound.js';
import type { TraceSink } from './trace.js';
import type { InjectChannel } from './inject.js';
import type { InboundRecorder } from './record.js';
import type { TraceStage } from './trace.js';
/** T2 (P1): the queue notice sent to a chat when a message arrives while its
 * task is running under the default 'queue' policy — at most ONE per running
 * turn (the flag resets at turn/end) so a burst of queued messages never
 * spams the chat. Exported for the deterministic text wait in tests. */
export declare const QUEUE_NOTICE_TEXT = "\u23F3 \u5F53\u524D\u4EFB\u52A1\u8FD0\u884C\u4E2D\uFF0C\u65B0\u6D88\u606F\u5DF2\u6392\u961F\uFF0C\u5C06\u5728\u5F53\u524D\u4EFB\u52A1\u7ED3\u675F\u540E\u4F9D\u6B21\u5904\u7406\u3002";
/** T2-B2: how long a relayed ask_user_question batch stays interceptable —
 * after this the bridge stops treating plain replies as answers (the host's
 * continued-state question may still be answered from the Web card). */
export declare const QUESTION_TTL_MS: number;
/** T2-B3: the auto-receipt sent when a QQ reply settles an ask_user_question batch. */
export declare const ANSWER_ACCEPTED_NOTICE = "\u2714 \u5DF2\u63D0\u4EA4\u56DE\u7B54";
/** Resolved runtime configuration for the bridge. */
export interface BridgeConfig {
    botQQ: string;
    ignoreSelf: boolean;
    requireMention: boolean;
    /** Unknown slash-command handling (R1): 'intercept' (default) consumes the
     * message with a closest-match suggestion or a hint; 'passthrough' restores
     * the old fall-through to the model. */
    unknownCommand?: 'intercept' | 'passthrough';
    interimMessages: boolean;
    /** Per-interim auto-recall delay (ms) from each interim's send completion
     * while the turn is still running (QQ recall window ~2 min); absent → 90s.
     * At turn/end the remaining originals are recalled immediately regardless. */
    interimRecallMs?: number;
    /** M3-D2b degrade switch: false = send-only interims — no auto-recall
     * timers, no turn/end immediate recall and no summary card (the turn ends
     * with the final text only). Absent/true = the full recall behavior. */
    interimRecall?: boolean;
    sendErrorNotice: boolean;
    /** T8/#27: auto-receipt notice switches / custom texts — absent or `true`
     * → the default text (0.9.x behavior unchanged); `false` or `''` → not
     * sent; a non-empty string → the custom text. steerAccepted gates the
     * steer-mode auto receipt AND customizes the /steer command confirmation
     * (which stays on regardless — it is a command reply, not an auto
     * receipt); queue gates the once-per-running-turn queue notice. */
    notices?: NoticeTexts;
    /** B7: per-chat per-minute sliding-window cap for normal (non-command)
     * messages; absent → 30, 0 disables. */
    rateLimitPerMinute?: number;
    restrictedMemberPrefix: boolean;
    sensitivePatterns: readonly string[];
    mediaDir: string;
    maxImageBytes: number;
    maxVoiceBytes: number;
    maxFileBytes: number;
    textImageThreshold: number;
    cardFooter: string;
    fontFiles: readonly string[];
    fontFamilies: readonly string[];
    /** T2 (P1): preferred mono family names for code text (t2i); absent → t2i platform defaults. */
    monoFamilies?: readonly string[];
    agentPreset: string;
    /** 权限分档 A3: 群聊粗档 preset——设置后群聊会话优先使用该 preset id（私聊
     * 仍用 agentPreset）；absent/空串 = 现行为（群私同源 agentPreset）。 */
    agentPresetGroup?: string;
    /** 权限分档 A2: 成员档位工具权限。'none'（缺省）= 成员（非管理员）回合
     * 内全部 qq_* 工具在 execute 前被硬拦截；'all' = 不限。fail-closed：
     * 字段缺失按 'none' 处理。 */
    permissions?: {
        memberTools?: 'none' | 'all';
    };
    workspacePath: string;
    /** T3 (PR port 群工作区)：群聊 chat 的会话默认工作区目录——配置后 group:
     * 前缀 chat 的会话落在群独立目录（per-chat /workspace override 仍最优先，
     * 私聊不受影响）；absent/空串 = 现行为。 */
    groupWorkspacePath?: string;
    /** T3 (PR port 退休会话自动恢复)：chat 绑定会话在宿主侧已退休/不存在时，
     * 扫描宿主 sessions 目录找该 chat 可用的最新会话自动重绑；absent/false =
     * 关（默认，维持上游默认行为），开启后探测失败仍静默降级为原行为。 */
    sessionAutoRecover?: boolean;
    /** Max inbound file bytes fetched via QQ direct link / base64 (0 = no cap). */
    maxInboundFileBytes: number;
    /** B8c: chats idle longer than this many days are evicted on the next
     * inbound message (0 disables; default 7). Evicted chats keep their
     * chat→session mapping, so a later message resumes the same session. */
    chatIdleEvictDays?: number;
    /** T2 (P1): how a new ordinary message is handled while the chat's task
     * (agent turn) is running; absent → 'queue' (the default). 'queue' = the
     * message keeps the 0.8.1 dispatch path (agent.followup queues it as the
     * next turn — consumed AFTER the current turn ends, in arrival order) and
     * the chat gets at most one queue notice per running turn; 'steer' = plain
     * text (no media/quote/forward, non-restricted senders) is submitted as a
     * supplementary instruction into the running turn via the same
     * agent.steer kernel as steerTranscript, with a per-message submit notice. */
    newMessagePolicy?: 'queue' | 'steer';
    /** T9-B (用户裁决 2026-10-12)：steer 模式下自动插话的发送者资格档位；
     * absent → 'admin'（缺省）。'admin' = 仅管理员可自动插话；'all' = 所有
     * 非受限发送者均可。不改变 /steer 命令（始终仅管理员）与 queue 模式行为，
     * 也不放宽受限用户软限制（受限消息任何档都排队）。 */
    autoSteerPolicy?: 'admin' | 'all';
    /** T3 (P2)：等待模型回复超时阈值（ms）——回合超过该时长没有任何模型输出
     * 时提示超时并登记补发跟踪（deferred delivery），回合完成后向原聊天补发
     * 最终文字（「（超时补发）」前缀，走既有 outbound 管线）；absent →
     * 600000（保守 10 分钟），0 = 关闭超时补发。 */
    deferredTimeoutMs?: number;
    /** T4 (PR port 提示词文件)：私聊（dm:）会话的附加设定文件路径（~/ 展开；
     * 内容进 system prompt 的「本会话附加设定」段）；absent/空 = 不注入。 */
    dmPromptFile?: string;
    /** T4 (PR port 提示词文件)：群聊（group:）会话的附加设定文件路径；absent/空 = 不注入。 */
    groupPromptFile?: string;
    /** T4 (PR port 记忆文件)：记忆文件开关（默认关，裁定口径）；只对私聊生效。 */
    memoryFilesEnabled?: boolean;
    /** T4 (PR port 记忆文件)：记忆文件路径列表（~/ 展开；单文件 8000 字符、
     * 总量 12000 字符截断）。 */
    memoryFiles?: readonly string[];
    /** T4 (PR port 上下文尾巴)：/new 把上一会话最后几句带进新会话（默认关，
     * 裁定口径；落盘 mediaDir/chat-tails.json）。 */
    chatTailsEnabled?: boolean;
    /** T7 (PR port 入站连发合并)：入站排队+连发合并开关（默认关，裁定口径）；
     * absent/false = 不排队不合并，handleInbound 走既有路径，与上游逐字节
     * 等价。开启后每会话一条串行链，同会话紧挨的消息并成一条投递（斜杠命令
     * 不合并、注入消息不排队不合并直接串行），全局积压 50 条超限丢弃并 warn。 */
    inboxQueueEnabled?: boolean;
    /** T7 (PR port 入站连发合并)：合并窗口毫秒数——最后一条进来后等这么久再
     * 投递，从首条算起最多 3000ms 封顶；absent → 600。仅在 inboxQueueEnabled
     * 开启时生效（开关与延迟设置项同一配置组）。 */
    inboxQueueDelayMs?: number;
    /** T24 (PR port 会话标题同步)：QQ 用户消息派发回合后触发宿主会话标题刷新
     * （每条消息一次，等价宿主自动标题 all-prompts 的原行为——QQ 派发的
     * source.kind 'plugin:dsh-onebot' 不触发宿主 onUserMessage，本开关补上）；
     * absent/false = 关（默认，裁定口径）。用户在宿主里钉住的标题
     * （snapshot.source.kind==='user'）永不覆盖；服务未部署或刷新失败静默
     * 降级（warn 日志），绝不冒泡进派发主流程。 */
    titleSyncEnabled?: boolean;
}
/** T24 (PR port 会话标题同步)：宿主 dsh-session-title 服务的最小结构面
 * （不 import 宿主包类型——宿主包不在本插件构建/测试依赖里，同
 * userQuestions 的结构化复刻手法）。get() 读当前标题快照（undefined = 尚
 * 无标题；source.kind 'user' = 用户在宿主里手动钉住，refresh 的语义是故意
 * 解除钉住——钉住态绝不调）；refresh() 触发 provider 重新生成标题。
 * 服务未部署（宿主摘除 session-title 插件）时取不到 = 同步跳过，不崩。 */
export interface SessionTitlePort {
    get(session: Session): {
        source?: {
            kind?: string;
        };
    } | undefined;
    refresh(session: Session): Promise<unknown>;
}
/** W1 trace/config extensions: the observability knobs ride as optional
 * members (same pattern as the W2-②③ gate keys) so the declared BridgeConfig
 * shape above stays untouched; absent = the feature is off (0.6.0 behavior). */
export interface TraceBridgeConfig {
    /** W1: decision-trace sink; absent/disabled = no traceIds, no jsonl, zero
     * behavior difference vs 0.6.0. */
    trace?: TraceSink | undefined;
    /** W1/T5: inbound recorder (recordInbound); absent = recording off. */
    recorder?: InboundRecorder | undefined;
    /** W1/T5: inject channel (injectEnabled, DEBUG-ONLY); absent = channel off. */
    inject?: InjectChannel | undefined;
}
/** Agent-preset service (dsh-agent-presets): joins agents to a preset composition. */
export interface AgentPresetsLike {
    /** The preset id a new session gets when none is named (deployment default). */
    readonly defaultId: string;
    /** Resolve one preset by id (undefined = default); throws when no root supplies it. */
    resolve(id?: string): Promise<{
        id: string;
    }>;
    mount(agentCtx: unknown, id?: string): Promise<{
        id: string;
    }>;
}
/** Structural slice of one logged session event the /session preview reads
 * — only the preview's fields are named, and the host's SessionEvent (whose
 * 'user/message' payload is a UserMessage) satisfies it. */
export interface SessionPreviewEvent {
    type?: string;
    data?: {
        agentPreset?: string;
        source?: {
            kind?: string;
        };
        content?: readonly {
            type?: string;
            text?: string;
        }[];
    };
}
/** Narrowed read handle over one stored session (dsh-session-persistence's
 * `SessionHandle` from `open(id, 'read')`): the /session preview reads the
 * immutable header plus a small event prefix and then MUST close the handle
 * (AsyncDisposable — a leaked read handle pins backend resources). */
export interface SessionReadHandleLike {
    readonly header: {
        createdAt?: number;
        agentPreset?: string;
    };
    read(offset?: number, length?: number): Promise<{
        events: readonly SessionPreviewEvent[];
    }>;
    close(): Promise<void>;
}
/** Durable session persistence (dsh-session-persistence): cold-read what a session recorded. */
export interface SessionPersistenceLike {
    /** Existence probe (dsh-session-persistence 0.1.6 `stat`): resolves the
     * stored snapshot, or undefined when the id owns no durable log. Replaces
     * the retired host `inspect` convenience. */
    stat(id: SessionId): Promise<object | undefined>;
    /** Open an existing stored session for reading: 'read' never takes write
     * ownership and works while a live writer holds the session. */
    open(id: SessionId, access: 'read'): Promise<SessionReadHandleLike>;
}
/** Workspace registry (dsh-workspace): durable workspace membership. */
export interface WorkspaceLike {
    id: string;
    path: string;
    sessionIds: readonly string[];
    attachSession(sessionId: string): Promise<void>;
}
/** Workspace registry (dsh-workspace): durable workspace membership. */
export interface WorkspaceRegistryLike {
    resolveByPath(path: string): Promise<WorkspaceLike | undefined>;
    create(path: string, title?: string): Promise<WorkspaceLike>;
    list(): WorkspaceLike[];
}
/** Default model service (dsh-agent-default-model): read/save the default selection. */
export interface AgentDefaultModelLike {
    currentSelection(): ModelSelection | undefined;
    saveSelection(next: ModelSelection): Promise<void>;
}
/** Live model-catalog port (M2-C5b): the only llm surface the command domain
 * reads (/model). index.ts implements it over a live llm-service lookup so
 * late-registered providers stay visible; commands never touch Context. */
export interface LlmCatalogPort {
    listProviders(): LlmProviderInfo[];
    listModels(provider: string): Promise<LlmModelInfo[]>;
}
/** Session-event feed port (M2-C5b): the narrowed event-bus surface the bridge
 * subscribes to, replacing the whole-plugin Context. index.ts satisfies it
 * with the host context itself (its event-bus `on` IS the implementation); the
 * BridgeDeps field keeps the historical name `ctx` because existing test
 * assemblies pass the host context directly. */
export interface SessionEventPort {
    on(type: 'session/event', handler: (session: Session, event: SessionEvent) => void): () => void;
    on(type: 'session/flush', handler: (session: Session) => void): () => void;
}
/** Services the bridge needs (M2-C5b: the plugin Context enters only through
 * the two explicit ports below — session events and the /model catalog). */
export interface BridgeDeps {
    ctx: SessionEventPort;
    /** Resolves once the host's boot-time configuration (the loader service) is
     * fully applied; index.ts owns the 'loader' lookup and swallows its errors.
     * Absent in test assemblies = no gate (matches the previously swallowed
     * lookup). Must not reject. */
    hostReady?: (() => Promise<void>) | undefined;
    /** Live model-catalog port for /model (M2-C5b); index.ts implements it over
     * the live llm service. Absent only in assemblies that never route /model. */
    llmCatalog?: LlmCatalogPort | undefined;
    connection: OneBotConnection;
    /** The dsh data home (default <home>/.dsh); used to enumerate agent presets. */
    dshHome?: string | undefined;
    media: MediaStore;
    transcriber: Transcriber;
    agents: AgentRegistry;
    sessions: SessionStore;
    agentPresets: AgentPresetsLike | undefined;
    /** Host command runtime: forwards /plan and /permission so QQ reaches the
     * native commands. dsh ≥0.1.5-rc.1: `submittedAttachments` (always pass an
     * empty array) and `signal` are both REQUIRED (the host reads `.length` /
     * `.aborted` unconditionally); the settled return is the
     * `{ commandId, result: { kind, text } }` wrapper (older hosts: flat). */
    commands?: {
        execute(agent: unknown, line: string, submittedAttachments: readonly unknown[], signal: AbortSignal): Promise<{
            kind?: string;
            text?: string;
            result?: {
                kind?: string;
                text?: string;
            };
        }>;
    } | undefined;
    /** Durable persistence for cold reads: the recorded preset at resume and
     * the /session list's per-item content previews; absent = config/default
     * fallback and preview-less list items. */
    sessionPersistence: SessionPersistenceLike | undefined;
    workspaceRegistry: WorkspaceRegistryLike | undefined;
    agentDefaultModel: AgentDefaultModelLike | undefined;
    defaultModel: (() => ModelSelection | undefined) | undefined;
    /** T2-B3: the host userQuestions service — settles intercepted QQ replies
     * against the chat's continued-state ask_user_question. Absent (test
     * assemblies / unexpected hosts) = answer interception stays disabled and
     * every reply flows into the conversation normally. */
    userQuestions?: UserQuestionsPort | undefined;
    /** T24/T27: the host session-title service (dsh-session-title). Read by
     * name via a tolerant lookup in index.ts (deliberately NOT a cordis inject
     * dependency — inject is hard, a missing service would keep the whole
     * plugin from loading). Absent (title plugin removed / test assemblies) =
     * title sync is skipped — no crash, no load failure. */
    sessionTitle?: SessionTitlePort | undefined;
    config: BridgeConfig & TraceBridgeConfig;
    policy: AccessPolicyConfig;
    /** W1/T5 health: the ALREADY-redacted plugin config snapshot (secrets
     * replaced by 已配置/未配置 — see health.redactSnapshot). Absent = the
     * /healthcheck diagnostics export renders without a config section. */
    configSnapshot?: (() => Record<string, unknown>) | undefined;
    /** Log line callback (level, message). */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
}
/**
 * Bridge between OneBot events and dsh agents. Create via the constructor and
 * call start() from the plugin's effect; call stop() on disposal.
 */
export declare class ChatBridge {
    private readonly deps;
    /** Outbound pipeline (D1-PR2): the same-name bridge methods below delegate here. */
    private readonly outbound;
    /** The chat↔session registry (D1-PR3): chats/bySession dual index, the
     * persistence pair, per-chat settings and the create/resume assembly. */
    private readonly registry;
    /** Inbound pipeline (D1-PR4): normalizeOneBot11 + the policy→media→quote→
     * dispatch path; the same-name bridge methods below delegate here. */
    private readonly inbound;
    /** Interim domain (D1-PR5): the assistant/message interim routing, the
     * per-message recall timers and the turn/end settlement. */
    private readonly interim;
    /** T3 (P2): the deferred-delivery tracker (超时补发) — timeout timers, the
     * JSONL registry, bounded send retries and restart recovery. */
    private readonly deferred;
    /** T4 (PR port 提示词文件/记忆文件)：dm/group 提示词文件与记忆文件的
     * 读取与组装（mtime 失效缓存；记忆只喂私聊）。 */
    private readonly prompts;
    /** T4 (PR port 上下文尾巴)：/new 前的上一会话尾巴（防抖落盘 mediaDir/
     * chat-tails.json；默认关）。 */
    private readonly tails;
    /** T7 (PR port 入站连发合并)：入站排队+合并调度器；开关关闭（默认）时为
     * undefined，handleInbound 保持既有路径（上游逐字节等价）。 */
    private readonly inboundQueue;
    /** T4 (P3): the bounded registry of recent fault references — every minted
     * QQ-CONN-/MF- number is recorded here for the /healthcheck report and the
     * diagnostics archive file name. */
    private readonly failureRefs;
    /** Live registry indexes — the inbound/outbound/interim/turn links keep
     * reading them through these same-name views. */
    private get chats();
    private get bySession();
    private sessionEventOff;
    private sessionFlushOff;
    /** W1: chat-level traceId association table — session events arrive on a
     * different async chain than the inbound pipeline, so dispatchFollowup
     * records the initiating traceId per chat here and onSessionEvent reads it
     * back (agent 回复事件归属发起 traceId). Last dispatch wins; entries are
     * dropped when the chat is removed. Not cleared at turn/end: the interim
     * settle loop sends the final reply AFTER turn/end, and clearing there
     * would orphan exactly that reply's outbound events. One entry per chat
     * id (bounded by the chat population), so growth is not a concern. */
    private readonly traceByChat;
    /** T3-board /silent: per-chat silence window (epoch-ms until; no entry =
     * not silenced). The Map is the hot-path READ cache (the QQ message probe
     * stays IO-free); the durable copy is ChatSettings.silentUntil (registry),
     * which rides chat-sessions.json — a restart re-arms a running window and
     * /new keeps it. Writes go through setSilentUntilImpl (memory + settings +
     * debounced save); a bare /silent clears both copies explicitly. */
    private readonly silentUntil;
    /** W1/T5: chatId → the traceId of the chat's unsettled INJECTED round
     * (independent of the trace sink, so the dry-run guard covers the async
     * agent reply even with tracing off). Cleared by a real dispatch to the
     * chat or when the chat is removed. */
    private readonly injectRoundByChat;
    /** T2 (P1): chats that already got the QUEUE_NOTICE_TEXT for their current
     * running turn (one notice per turn; cleared at turn/end and on chat
     * removal — bounded by the chat population). */
    private readonly queueNoticeChats;
    /** T2-B2: the chat's outstanding ask_user_question batch, keyed by chat id
     * (memory only — a restart loses it and the model re-asks). Populated from
     * the card relay's onQuestionCall, consumed by interceptQuestionAnswer,
     * cleared on settle (user-question-reply event), chat removal and the TTL. */
    private readonly activeQuestion;
    /** T3-board: live foreground answerers keyed by callId — the
     * 'user-questions/request' waterfall listener waits on these for the QQ
     * answer (instant settle: the ask tool returns instead of timing out to
     * pending). Populated by onForegroundQuestionRequest, delivered by
     * interceptQuestionAnswer, cleared on settle, chat removal, bridge stop,
     * and each listener's own deadline/host-signal race. */
    private readonly foregroundWaits;
    /** Plugin version + git commit, read once for /ver. */
    private pluginVersion;
    private pluginCommit;
    private stopping;
    constructor(deps: BridgeDeps);
    /** Start listening: wire connection handlers and the session event feed. */
    start(): void;
    /** Stop everything: dispose agents, save mapping, cancel timers. */
    stop(): Promise<void>;
    /** Map an agent session id back to its chat (for model tools). */
    chatForSession(sessionId: string): ChatId | undefined;
    /** Whether a caller backing an agent session may perform file edits. QQ chats
     * require the currently running turn's initiator to be an admin (role frozen
     * from the dispatch queue at turn/start); non-QQ sessions (Web and other
     * channels) are trusted by default (A1 scoping). Unknown states fail closed
     * as member. */
    canEditFiles(sessionId: string): boolean;
    /**
     * 权限分档 A2（工具硬防线）：one tool-call's permission decision. Reuses the
     * M1-A2 turn-level role (frozen at turn/start, fail-closed member) via
     * canEditFiles; a caller with no QQ session mapping (Web/other channels) is
     * outside the tier semantics and stays allowed; permissions.memberTools
     * === 'all' disables the gate entirely. Absent config fails closed to
     * 'none' (members blocked).
     */
    memberToolsAllowed(sessionId: string | undefined): boolean;
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
    mediaSendRoots(sessionId: string | undefined): Promise<{
        roots: string[];
        isTurnAdmin: boolean;
    }>;
    /** Whether the connection is usable for sends. */
    get connected(): boolean;
    /**
     * Send plain text to a chat with the full outbound pipeline (forward
     * blocks, Markdown strip, sentence splitting).
     * @param chatId - target chat.
     * @param text - model-produced text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    sendToChat(chatId: ChatId, text: string, options?: SendOptions): Promise<string[]>;
    /**
     * Send raw OneBot segments (used by the media tools).
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId: ChatId, segments: OutboundSegment[]): Promise<string | undefined>;
    /**
     * Wait for the loader's complete application (model selection, settings,
     * persistence) before reading the default model — the same gate the
     * headless runner uses, so the pinned selection is never a half-loaded
     * default.
     */
    private ready;
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
    handleInbound(event: OneBotEvent, opts?: {
        injected?: boolean;
    }): Promise<void>;
    private handleInboundOnce;
    /** W1: mint the inbound traceId + scope and record the first (收到消息)
     * event; undefined when tracing is off (zero overhead, zero difference).
     * W1/T5: an injected event REUSES its inject round's traceId, so the whole
     * injected round (pipeline decisions + intercepted outbound calls) shares
     * one traceId in the trace stream. */
    private beginInboundTrace;
    private processInbound;
    /** Feed one user message into a chat's agent (create on demand). Records
     * the base text for /retry, queues the initiator's turn role, and applies
     * per-chat /goal + /plan prefixes. */
    private dispatchFollowup;
    /** T24 (PR port 会话标题同步)：每条 QQ 用户消息派发回合后，让宿主标题
     * 服务为该会话重新生成标题（频率=每条消息，等价宿主 all-prompts 自动
     * 标题的原行为——QQ 派发的 source.kind 'plugin:dsh-onebot' 不进宿主
     * onUserMessage，QQ 会话原本永远拿不到自动标题）。门控与降级：
     * - titleSyncEnabled 关（默认）→ 不做任何事（零行为差异）；
     * - 服务按名可选读取（deps.sessionTitle 为 undefined，含宿主未部署标题
     *   插件）→ 跳过，不崩、不影响加载；
     * - 钉住态（snapshot.source.kind==='user'，用户在宿主里手动命名）→
     *   绝不 refresh——refresh 的语义就是故意解除钉住；跨进程竞态（refresh
     *   在途时用户在宿主 rename）由宿主 supersede 语义化解——rename 会中止
     *   该会话 in-flight 的标题生成，迟到的 provider 结果不提交；
     * - refresh 后台执行不 await 主流程；get/refresh 同步抛或拒绝都只
     *   warn（标题是辅助功能，失败静默降级，不冒泡进派发主流程）。 */
    private syncSessionTitle;
    /** Prepend per-chat context directives (/goal reminder) to a turn's user
     * text. Plan mode is host-owned now (/plan forwards to the host command),
     * so the agent's own plan-mode instruction section governs planning. */
    private prefixTurn;
    /** Per-chat outbound-mode override (/mode), falling back to the global config. */
    private effectiveInterim;
    /** Tool calls whose host-plane UI has no QQ equivalent; relay them to the chat. */
    private relayHostCards;
    /** The CardRelayContext handed to the card relay (D1-PR2): the outbound
     * send path plus the bridge log — the only capabilities the relay touches.
     * T2-B2 adds onQuestionCall to record the outstanding batch. */
    private get cardRelayCtx();
    /** T2-B2: the chat's outstanding ask_user_question batch, or undefined when
     * there is none or the TTL (QUESTION_TTL_MS) has expired (expired entries
     * are dropped lazily — no timer needed). */
    private activeQuestionFor;
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
    private interceptQuestionAnswer;
    /** T1 (#27): the answer-accepted auto receipt — notices.answerAccepted
     * resolves the text (false/'' = not sent, string = custom text). */
    private sendAnswerNotice;
    /** T3-board: the chat whose live root agent is `agent` (identity first,
     * then the session id as a defensive fallback). */
    private chatIdForAgent;
    /** T3-board: try to settle a live foreground wait with a parsed QQ answer
     * batch (instant settle). Only a wait whose question ids are exactly
     * covered by the parsed answers accepts the delivery; anything else stays
     * for the answer() (pending) path. */
    private deliverForegroundAnswer;
    /** T3-board: resolve-and-drop every foreground wait belonging to `chatId`;
     * each listener sees undefined, releases its claim and falls through. */
    private abandonForegroundWaits;
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
    private onForegroundQuestionRequest;
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
    private tryHandleCommand;
    /**
     * The CommandContext handed to the command table (D1-PR1): exposes exactly
     * the bridge capabilities the routed commands use, resolved live per
     * invocation (the llm catalog especially must stay a live service lookup).
     */
    private get commandCtx();
    /** T3-board /silent: the chat's silence-window end (in-memory read cache). */
    private getSilentUntil;
    /** T3-board /silent: write BOTH copies of the silence window — the
     * in-memory hot-path cache and the durable ChatSettings.silentUntil (the
     * debounced mapping save; persistEntry drops already-expired values).
     * `undefined` clears. Survives /new (silence belongs to the chat, not the
     * session); a bare /silent clears both copies explicitly. */
    private setSilentUntilImpl;
    /** Read the chat→session mapping file (for /id and /status when no live chat). */
    private sessionIdFromMapping;
    /**
     * Build the message body text: placeholders become annotated local paths
     * (images/voices/videos) and voice files are transcribed when enabled.
     */
    private buildBody;
    /** Resolve one media ref to a text annotation with a local path. */
    private resolveMediaRef;
    /** M3-D4c: steer a completed voice transcript into the chat's agent — the
     * running turn consumes it at its nearest step boundary; an idle agent
     * opens a turn. No live chat (dispatch dropped/never happened) drops it. */
    private steerTranscript;
    /** T2 (P1): the single agent.steer write point — one createUserMessage with
     * the producer-owned source kind (the session-v4 guard counts the source
     * write points; this and dispatchFollowup are the only two). Shared by the
     * voice transcript path (steerTranscript), the 'steer' policy and /steer.
     * Returns false when the chat has no live agent (nothing was steered). */
    private steerMessage;
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
    private interceptBusyTurn;
    /** Expand a quote, forwarding a verified response without repeating get_msg. */
    private expandQuote;
    /** Send one message to a chat and return its message id. */
    private sendMsg;
    /** Send [[qq_forward]] nodes as a merged-forward message. */
    sendForward(chatId: ChatId, nodes: Array<{
        name: string;
        content: string;
    }>): Promise<void>;
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
    private guardedConnectionCall;
    /** The health deps the /healthcheck command renders from (resolved live). */
    private healthDeps;
    /** /healthcheck: render the health summary. */
    private buildHealthReport;
    /** /healthcheck export: pack the redacted diagnostics archive. T4 (P3): the
     * file name carries the trigger reference — the explicit command argument,
     * or the most recent recorded fault reference when omitted. */
    private exportDiagnosticsPackage;
    /**
     * T1 (PR port): 非插件 dispatch 的回合（后台/Web 输入，pendingTurnRoles
     * 队列为空）的回合角色判定。旧实现一律 fail-closed 为 member，管理员的
     * Web 回合也被当 member，qq_* 工具全拒；现对私聊按管理员名单判档，群聊
     * 维持 fail-closed member（群成员身份无法从宿主侧验证）。
     */
    private hostTurnRole;
    private onSessionEvent;
    /** W1: the trace scope for one chat's session events, resolved through the
     * chat-level association table; undefined when tracing is off or the chat
     * has no recorded dispatch (host-initiated turns stay untraced). */
    private traceForChat;
    /**
     * T4 (P3): the single fault-reference entry point. Mints one QQ-CONN-/MF-
     * number, records it in the bounded registry, emits the ok:false trace
     * event carrying `data.ref` (traceId = the chat's mapped id, or a fresh id
     * for chat-less connection faults), and writes the structured error log
     * line — every surface of the fault shares this one number. Called only on
     * fault events: normal traffic mints nothing (zero overhead).
     */
    private mintFailureRef;
    /** T4: connection-fault reference entry (wired from index.ts via
     * `connection.onFailure`); the returned reference is appended to the
     * transport's own log line. */
    registerConnectionFailure(stage: string, detail: string): string;
    /** T4: message-fault reference entry for command-plane failures (e.g. the
     * /retry dispatch throw); the caller appends the returned reference to the
     * user-visible ⚠️ notice. */
    registerMessageFailure(chatId: ChatId, stage: TraceStage, detail: string): string;
    private onSessionFlush;
    /** Same-name delegations to the chat registry (D1-PR3): the command table's
     * ctx, the interim/turn event links and the outbound pipeline keep calling
     * the bridge exactly as before the split. */
    /** Get (or create) the agent for a chat. */
    private ensureChat;
    private effectiveCwd;
    private resolvePresetId;
    private saveMappingDebounced;
    private healSessionCollision;
    /**
     * /new: the registry disposes the agent and retires its session id so the
     * next inbound message creates a brand-new session (fresh history; the old
     * conversation stays on disk). The confirmation is sent directly through
     * the outbound pipeline since no agent is left to reply.
     */
    private resetChat;
    /**
     * Compose the QQ channel's scoped world for one agent: the QQ platform
     * prompt section and the qq_* tools. Registered on `agentCtx` (the agent's
     * own scope) instead of the plugin context, so Web/local sessions never see
     * the channel instructions or the media tools — they cannot (and should
     * not) push messages to QQ.
     */
    private installChannelScope;
    /** Start the NapCat typing indicator (private chats only). */
    private startTyping;
    /** Stop the typing indicator. */
    private stopTyping;
}
export { OneBotNotConnectedError, OneBotActionError } from './connection.js';
