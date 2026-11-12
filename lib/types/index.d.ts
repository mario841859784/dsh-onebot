/**
 * dsh-onebot: a QQ (OneBot 11 / NapCat) chat channel for DeepSeek Harness.
 *
 * Mounts inside the dsh host process: a reverse- or forward-WebSocket link to
 * NapCat, one Agent per QQ chat, inbound images/voice handled for the model
 * (whisper STT when enabled), outbound replies split at sentence boundaries,
 * [[qq_forward]] merged forwards, allowlist/mention access control, and a set
 * of qq_* tools for media and NapCat APIs.
 * @module dsh-onebot
 */
import type { Context as CordisContext } from '@deepseek-ai/cordis';
import type SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import type ToolRuntime from '@deepseek-ai/dsh-tools';
import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { Session, SessionStore } from '@deepseek-ai/dsh-session';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type Z from '@deepseek-ai/schemastery';
import type { OneBotEvent } from './connection.js';
type Context = CordisContext & {
    tools: ToolRuntime;
    systemPrompt: SystemPrompt;
    agents: AgentRegistry;
    sessions: SessionStore;
    agentDefaultModel: {
        currentSelection(): ModelSelection | undefined;
        saveSelection(next: ModelSelection): Promise<void>;
    };
    agentPresets: {
        readonly defaultId: string;
        resolve(id?: string): Promise<{
            id: string;
        }>;
        mount(agentCtx: unknown, id?: string): Promise<{
            id: string;
        }>;
    };
    sessionPersistence: {
        /** dsh-session-persistence 0.1.6 `stat`: the stored snapshot, or
         * undefined when the id owns no durable log (the retired `inspect`
         * convenience no longer exists on the host service). */
        stat(id: string): Promise<object | undefined>;
        /** /session list previews: open a stored session read-only (never takes
         * write ownership), read the header + a small event prefix, then close. */
        open(id: string, access: 'read'): Promise<{
            header: {
                createdAt?: number;
                agentPreset?: string;
            };
            read(offset?: number, length?: number): Promise<{
                events: readonly {
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
                }[];
            }>;
            close(): Promise<void>;
        }>;
    };
    workspaceRegistry: {
        resolveByPath(path: string): Promise<{
            id: string;
            path: string;
            sessionIds: readonly string[];
            attachSession(sessionId: string): Promise<void>;
        } | undefined>;
        create(path: string, title?: string): Promise<{
            id: string;
            path: string;
            sessionIds: readonly string[];
            attachSession(sessionId: string): Promise<void>;
        }>;
        list(): Array<{
            id: string;
            path: string;
            sessionIds: readonly string[];
        }>;
    };
    commands: {
        execute(agent: unknown, line: string, submittedAttachments: readonly unknown[], signal: AbortSignal): Promise<{
            kind?: string;
            text?: string;
            result?: {
                kind?: string;
                text?: string;
            };
        }>;
    };
    /** T2-B1/B3: the host userQuestions service (dsh-base registers it). Not in
     * the inject list on purpose — a deployment without it must degrade to "no
     * ask_user_question tool / no answer interception", never block the load. */
    userQuestions?: {
        askTimed(request: unknown, callId: string, timeoutMs: number): Promise<unknown>;
        answer(agent: unknown, callId: string, payload: {
            answers: Array<{
                id: string;
                selected: string[];
                custom?: string;
            }>;
        }): Promise<boolean>;
    };
    /** T24/T27 (PR port 会话标题同步)：宿主 dsh-session-title 服务（dsh-base
     * 标准 include 集自带）。有意不进 inject 列表——cordis inject 是硬依赖
     * （缺任一注入服务时 fiber 恒 INACTIVE、apply 不执行，宿主摘除标题插件会
     * 导致整个插件静默不加载）。运行时经 resolveSessionTitle 按名容错读取：
     * 服务缺失=undefined=桥接侧跳过标题同步。 */
    sessionTitle?: {
        /** 当前标题快照；undefined = 尚无标题；source.kind 'user' = 用户钉住。 */
        get(session: Session): {
            source?: {
                kind?: string;
            };
        } | undefined;
        /** 触发 provider 重新生成标题（语义=故意解除钉住——钉住态绝不调）。 */
        refresh(session: Session): Promise<unknown>;
    };
};
export declare const name = "dsh-onebot";
export declare const inject: string[];
/** T24/T27: 容错读取宿主 dsh-session-title 服务（与 userQuestions 同手法）。
 * 按名从 ctx 读取（cordis 下服务未注册时 ctx.get 返回 null/undefined，宿主
 * 摘除 dsh-session-title 亦然），取不到或读取抛错一律归一为 undefined；
 * 桥接侧对 undefined 跳过标题同步。绝不走 inject——cordis inject 是硬依赖，
 * 缺服务时 fiber 恒 INACTIVE，整个插件会静默不加载。 */
export declare function resolveSessionTitle(ctx: unknown): import('./bridge.js').SessionTitlePort | undefined;
/** Plugin configuration (validated by schemastery). */
export interface Config {
    mode: 'reverse' | 'forward';
    host: string;
    port: number;
    url: string;
    accessToken: string;
    /** Forward-mode reconnect attempt limit; 0 = retry forever. */
    reconnectMaxAttempts: number;
    botQQ: string;
    requireMention: boolean;
    /** T1 (PR port): 戳一戳唤醒开关；false = poke notice 一律忽略。 */
    pokeEnabled: boolean;
    /** T1 (PR port): 引用即叫——群聊回复任意消息（不限机器人）也算 @机器人。 */
    replyCountsAsMention: boolean;
    /** T1 (PR port): @全体即叫——群聊 @全体成员 也算 @机器人。 */
    atAllCountsAsMention: boolean;
    /** 群聊 @ 表情回执：群聊被显式 @ 后，回合启动时给该消息贴表情回执作为已收到回执；
     *  仅 NapCat/SnowLuma 支持（set_msg_emoji_like），其他实现静默跳过。 */
    reactionOnMention: boolean;
    /** 回执表情 ID，默认 178（微笑）。 */
    reactionEmoji: number;
    /** T1 (PR port): 管理员唤醒词；群聊消息以任一词开头即视为 @机器人。 */
    wakeNamesAdmin: string[];
    /** T1 (PR port): 成员唤醒词；群聊消息以任一词开头即视为 @机器人。 */
    wakeNamesMember: string[];
    /** T6 (PR port GIF 分帧)：开启后入站 .gif 附件旁附一张四格分帧长图；默认关闭，
     *  关闭时不装依赖也不触碰文件系统（行为与上游逐字节等价）。 */
    gifFramesEnabled: boolean;
    /** T6 (PR port 官方表情名表)：[CQ:face] 的呈现风格：name=官方名（默认，
     *  如「[微笑]」）；emoji=旧 emoji 对照表。 */
    faceStyle: 'name' | 'emoji';
    /** Unknown slash-command handling: intercept（默认）=拦截并给建议；passthrough=透传给模型。 */
    unknownCommand: 'intercept' | 'passthrough';
    /** T2 (P1): 任务运行中的新消息处理策略：queue=排队（默认）；steer=插话进当前任务。 */
    newMessagePolicy: 'queue' | 'steer';
    /** T9-B (用户裁决 2026-10-12)：steer 模式下自动插话资格：admin=仅管理员（默认）；all=不限。 */
    autoSteerPolicy: 'admin' | 'all';
    /** T3 (P2): 等待模型回复超时阈值（毫秒）——超时后登记补发跟踪、回合完成后向原聊天补发最终文字；0=关闭。 */
    deferredTimeoutMs: number;
    /** T7 (PR port 入站连发合并)：入站排队+连发合并开关；默认关（关侧与上游
     *  逐字节等价）。开启后每会话一条串行链，同会话紧挨的消息并成一条投递。 */
    inboxQueueEnabled: boolean;
    /** T7 (PR port 入站连发合并)：合并窗口毫秒数（最后一条进来后等这么久，
     *  首条起最多 3000ms 封顶）；默认 600。仅在 inboxQueueEnabled 开启时生效。 */
    inboxQueueDelayMs: number;
    /** 群聊旁观 (#58)：总开关，默认关。开启后未通过 @ 门控的群消息进每群
     *  环形旁听缓冲，规则触发（唤醒词/话题词/问句/机会触发）时开一次回顾
     *  回合：模型可插话，也可输出 [[不回]] 保持沉默。 */
    bystanderEnabled: boolean;
    /** 群聊旁观 (#58)：每群旁听缓冲条数上限；默认 50。 */
    bystanderCapacity: number;
    /** 群聊旁观 (#58)：话题词表，消息文本包含任一词即触发回顾（子串匹配，
     *  大小写不敏感）；默认 []。 */
    bystanderTopics: string[];
    /** 群聊旁观 (#58)：每群两次回顾回合的最小间隔分钟数；默认 45。 */
    bystanderCooldownMinutes: number;
    /** 群聊旁观 (#58)：每群每日回顾回合上限（本地日期键计数）；默认 20。 */
    bystanderDailyLimit: number;
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    allowFrom: string[];
    groupAllowFrom: string[];
    adminUsers: string[];
    allowAllUsers: boolean;
    ignoreSelf: boolean;
    interimMessages: boolean;
    /** Per-interim auto-recall delay (ms) from each interim's send completion. */
    interimRecallMs: number;
    /** M3-D2b: interim recall degrade switch (false = send-only interims). */
    interimRecall: boolean;
    sendErrorNotice: boolean;
    /** T8/#27: auto-receipt notice switches — boolean, or a custom text string. */
    notices: {
        steerAccepted?: boolean | string;
        queue?: boolean | string;
        answerAccepted?: boolean | string;
        deferredTimeout?: boolean | string;
        rateLimited?: boolean | string;
    };
    /** T14 (#6 补充): qq_send_segments 插件页开关与分段发送间隔（呼吸感）。 */
    segments: {
        enabled: boolean;
        intervalMs: number;
    };
    /** Per-chat per-minute sliding-window cap for normal (non-command) messages; 0 disables. */
    rateLimitPerMinute: number;
    restrictedMemberPrefix: boolean;
    sensitivePatterns: string[];
    mediaDir: string;
    tempTtlHours: number;
    outboundImageMaxBytes: number;
    maxVoiceBytes: number;
    maxFileBytes: number;
    inboundImageMaxPx: number;
    /** @deprecated D4a alias of inboundImageMaxPx; honored for one release. */
    imageMaxSize?: number;
    /** @deprecated D4a alias of outboundImageMaxBytes; honored for one release. */
    maxImageBytes?: number;
    sttEnabled: boolean;
    sttEngine: 'auto' | 'openai' | 'whisper-cpp' | 'custom';
    sttCommand: string;
    sttArgs: string[];
    sttModel: string;
    sttTimeoutMs: number;
    textImageThreshold: number;
    cardFooter: string;
    fontFiles: string[];
    fontFamilies: string[];
    monoFamilies: string[];
    agentPreset: string;
    /** 权限分档 A3: 群聊粗档 preset——设置后群聊会话优先使用该 preset id；空串=现行为。 */
    agentPresetGroup: string;
    /** 权限分档 A2: 成员档位工具权限（none=成员回合禁用全部 qq_* 工具，默认；
     * send=仅放行发往当前会话的内容类工具（qq_send_text/segments/image）；
     * all=不限）。 */
    permissions: {
        memberTools: 'none' | 'send' | 'all';
    };
    workspacePath: string;
    /** T3 (PR port 群工作区)：群聊会话的默认工作区目录；空串=现行为。 */
    groupWorkspacePath: string;
    /** T3 (PR port 退休会话自动恢复)：退休会话自动重绑开关；false=默认关。 */
    sessionAutoRecover: boolean;
    /** T4 (PR port 提示词文件)：私聊（dm:）会话的附加设定文件路径（~/ 展开）；
     * 空 = 不注入（默认）。 */
    dmPromptFile: string;
    /** T4 (PR port 提示词文件)：群聊（group:）会话的附加设定文件路径；空 = 不注入（默认）。 */
    groupPromptFile: string;
    /** T4 (PR port 记忆文件)：记忆文件开关（默认关；只喂私聊）。 */
    memoryFilesEnabled: boolean;
    /** T4 (PR port 记忆文件)：记忆文件路径列表。 */
    memoryFiles: string[];
    /** T4 (PR port 上下文尾巴)：/new 带上一会话最后几句（默认关）。 */
    chatTailsEnabled: boolean;
    /** T24 (PR port 会话标题同步)：QQ 用户消息派发回合后触发宿主会话标题
     * 刷新（每条消息一次）；用户钉住的标题永不覆盖；默认关。 */
    titleSyncEnabled: boolean;
    inboundFileMaxBytes: number;
    /** @deprecated D4a alias of inboundFileMaxBytes; honored for one release. */
    maxInboundFileBytes?: number;
    /** B8c: chats idle longer than this many days are evicted (0 disables). */
    chatIdleEvictDays: number;
    /** Escape hatch: skip the download private-address check (local reverse proxy). */
    allowPrivateHosts: boolean;
    /** Roots allowed for inbound file:// refs; empty rejects all. */
    fileRefRoots: string[];
    /** Optional CIDR allowlist for trusted private download targets. */
    allowCidrs: string[];
    /** W2-②: inbound (chatId, message_id) dedup window in seconds; 0 disables. */
    dedupWindowSeconds: number;
    /** W2-③: bridge-wide proactive-write (qq_send_* tools) cap per minute; 0 disables. */
    actionRatePerMinute: number;
    /** W2-③: bridge-wide proactive-write cap per calendar day; 0 disables. */
    actionRatePerDay: number;
    /** W2-③: proactive-write audit jsonl (mediaDir/qq-actions.log). */
    actionAuditEnabled: boolean;
    /** T2 (PR port): 出站防御总开关——复读/信封清洗、残留标记兜底与
     * [[at:QQ]] 拆段；默认 false（上游 0.9.19 原始行为）。 */
    outboundDefenseEnabled: boolean;
    /** T2 (PR port): 纯括号旁白（如「（嗯……）」）静默丢弃；默认 false。 */
    asideOnlySilentEnabled: boolean;
    /** W1: decision-trace jsonl (mediaDir/qq-trace.jsonl); default off — zero
     * file, zero behavior difference vs 0.6.0. */
    traceEnabled: boolean;
    /** W1: trace level; 'warn' records only ok:false (rejected/failed/dropped) events. */
    traceLevel: 'debug' | 'warn';
    /** W1/T5: record every inbound event into mediaDir/qq-inbox.jsonl (default off). */
    recordInbound: boolean;
    /** W1/T5: mask 6+ digit runs (QQ/group numbers) in the recording (default off). */
    inboxRedact: boolean;
    /** W1/T5 (DEBUG-ONLY): enable the qq-inject.jsonl injection channel (default off). */
    injectEnabled: boolean;
    /** W1/T5: intercept all outbound writes of injected rounds (default true). */
    injectDryRun: boolean;
    /** W1/T5: inject queue poll interval in ms (min 500). */
    injectIntervalMs: number;
    /** Console log gate: messages below this level are dropped (debug < info < warn < error). */
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}
/** Default media dir: <dsh-home>/media/onebot (dsh-home = $DSH_HOME or ~/.dsh). */
export declare function defaultMediaDir(): string;
/** The dsh data home ($DSH_HOME or ~/.dsh); source of the .agent-presets dir. */
export declare function dshHome(): string;
export declare const Config: Z<Config>;
/** Map deprecated config names onto their renamed fields: a legacy value is
 * honored only while the new name still sits at its schema default (the new
 * name wins when both are configured), each legacy use warns once, and the
 * legacy keys never leak into the effective config. */
export declare function resolveDeprecatedConfig(config: Config): Config;
/** Log a meta event; periodic heartbeat events are silenced to keep the log readable. */
export declare function logMetaEvent(selfId: string, event: OneBotEvent, minLevel?: Config['logLevel']): void;
/** Mount the plugin. */
export declare function apply(ctx: Context, config: Config): void;
export {};
