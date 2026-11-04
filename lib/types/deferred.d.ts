import type { TraceStage } from './trace.js';
import { type NoticeTexts } from './notices.js';
/** The registry file name inside the media dir (one JSON entry per line). */
export declare const DEFERRED_REGISTRY_FILE = "deferred-delivery.jsonl";
/** Default wait-for-model-reply timeout (ms): conservative 10 minutes. */
export declare const DEFAULT_DEFERRED_TIMEOUT_MS = 600000;
/** Max total send attempts per entry（含首次；第 4 次永不尝试）。 */
export declare const DEFERRED_MAX_SEND_ATTEMPTS = 3;
/** Backoff before retry attempts 2 and 3 (ms). */
export declare const DEFERRED_RETRY_BACKOFF_MS: readonly number[];
/** Cap of tracked entries; the oldest terminal entries are pruned beyond it. */
export declare const DEFERRED_MAX_ENTRIES = 200;
/** Pending entries older than this are auto-cancelled at load（宿主进程级
 * 重启后原回合已不存在，超过该时长仍未兑现的条目视为死回合）。 */
export declare const DEFERRED_PENDING_MAX_AGE_MS: number;
/** The「（超时补发）」prefix prepended to every deferred delivery. */
export declare const DEFERRED_PREFIX = "\uFF08\u8D85\u65F6\u8865\u53D1\uFF09\n";
/** Entry states: pending = waiting for the turn to finish; the rest are
 * terminal (all persisted; uncertain/failed records are kept observable). */
export type DeferredEntryState = 'pending' | 'delivered' | 'failed' | 'uncertain' | 'cancelled';
/** One tracked timed-out turn (persisted, one JSON line). */
export interface DeferredEntry {
    chatId: string;
    sessionId: string;
    /** The dispatch traceId of the turn (best-effort; absent when tracing off). */
    traceId?: string;
    /** Epoch ms when the timeout fired and the entry was registered. */
    registeredAt: number;
    /** Epoch ms when the entry reached a terminal state (or registeredAt while pending). */
    updatedAt: number;
    attempts: number;
    state: DeferredEntryState;
    /** Terminal-state reason (Chinese; also set on success as 已送达). */
    reason?: string;
    /** T4 (P3): the fault reference of the turn's error ending（bridge 在错误
     * 回合 mint 的 MF- 参考号；终态补发文本与 trace 事件携带同号）。 */
    ref?: string;
    /** The final text captured after the timeout (last text-only assistant
     * message wins; images/tool calls/cards are never captured). */
    resultText?: string;
}
/** Structural slice of an assistant message the tracker reads. */
export interface DeferredAssistantMessage {
    id?: string;
    content: ReadonlyArray<{
        type: string;
        text?: string;
    }>;
}
/** Structural slice of a turn/end reason. */
export interface DeferredTurnReason {
    kind?: string;
    error?: {
        message?: string;
    };
}
/** The bridge capabilities the deferred tracker touches. */
export interface DeferredContext {
    /** Full outbound pipeline send（超时提醒与补发正文同链路；分段/t2i 规则既有）。 */
    sendToChat(chatId: string, text: string, options?: {
        queuable?: boolean;
    }): Promise<string[]>;
    /** Whether the chat's agent turn is still actually running（超时时刻的防陈旧闸：/stop 后无 turn/end 等情形只解除计时、不登记）。 */
    isTurnRunning(chatId: string): boolean;
    /** Take (and clear) the chat's not-yet-delivered loopPending text at
     * registration time so the normal final path has nothing left to flush. */
    takePendingText(chatId: string): string | null;
    /** The chat's dispatch traceId (chat-level association table; undefined when tracing off). */
    traceIdFor?(chatId: string): string | undefined;
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** W1-style outbound/queue decision events（reason 一律中文）。 */
    trace?(chatId: string, event: {
        stage: TraceStage;
        ok?: boolean;
        reason?: string;
        data?: Record<string, unknown>;
    }): void;
    mediaDir: string;
    /** The resolved timeout window (ms); 0 disables the whole feature. */
    timeoutMs: number;
    /** T1 (#27): notices ride through — the timeout notice text resolves from
     * notices.deferredTimeout (absent/true = default, false/'' = not sent). */
    notices?: NoticeTexts;
    isStopping(): boolean;
}
/** Injectable clock + timer pair (tests inject fake ones). */
export interface DeferredOptions {
    now?: () => number;
    /** Schedule fn after ms; the returned handle goes to cancel(). */
    schedule?: (fn: () => void, ms: number) => unknown;
    cancel?: (handle: unknown) => void;
}
/** Send-failure classification: 'retryable' = the message definitively did
 * NOT reach QQ（断连 / 网关明确拒绝）→ bounded retry; 'uncertain' = the
 * action timed out or failed outside the gateway — the message may still
 * have arrived, so the record is kept and auto-retry stops（防重复消息）. */
export declare function classifySendError(error: unknown): 'retryable' | 'uncertain';
/** Build the deferred delivery text for a finished turn. T4 (P3): an error
 * ending carries the turn's MF- reference so the补发 terminal notice and the
 * trace/log/healthcheck surfaces share one number. */
export declare function buildDeferredText(entry: DeferredEntry, reason: DeferredTurnReason | undefined): string;
/**
 * The deferred-delivery tracker: timeout timers, the JSONL registry, bounded
 * send retries and the restart-recovery load. Created by the ChatBridge
 * constructor; the bridge feeds it session events and the /stop command
 * cancels a chat's tracking.
 */
export declare class DeferredDelivery {
    private readonly ctx;
    private readonly now;
    private readonly scheduleFn;
    private readonly cancelFn;
    /** Tracked entries by session id（一个会话同一时刻至多一个运行回合）。 */
    private readonly entries;
    /** Per-session silent-wait timers（每次模型输出重置；turn/end 解除）。 */
    private readonly timers;
    /** Serialized registry-write chain（并发 save 不交错）。 */
    private saveChain;
    /** Session ids with a delivery loop in flight（防双发 in-flight 守卫：
     * 重试退避窗口内新回合 turn/end 不得再起第二条重试循环）。 */
    private readonly delivering;
    constructor(ctx: DeferredContext, options?: DeferredOptions);
    /** turn/start: arm (or re-arm) the silent-wait window for the session.
     * A session with a pending entry（重启恢复的跟踪中会话）does not re-arm —
     * its next turn/end redeems the entry. */
    onTurnStart(chatId: string, sessionId: string): void;
    /** assistant/message: returns true when the message is consumed by deferred
     * tracking（静音：不插播 interim、不转卡片，只捕获 text 块作为最终文字）。
     * Otherwise resets the silent-wait window（模型有输出 = 用户并非在干等）。 */
    onAssistantMessage(chatId: string, sessionId: string, message: DeferredAssistantMessage): boolean;
    /** turn/end: cancel the silent-wait timer; complete a pending entry by
     * delivering the final text (async, bounded retries). `ref` is the turn's
     * fault reference（T4：bridge 在错误回合 mint 的 MF- 号——终态补发文本与
     * trace 携带同号；正常回合为 undefined）. Returns true when
     * the turn was under deferred tracking AND its ending is success-class
     * （bridge 据此抑制常规错误通知——终态通知由补发通道送达，避免同一故障
     * 双消息）。两类例外一律返回 false、错误照常走基线 ⚠️ 通知（不静默吞
     * 掉）：terminal entries（delivered/failed/uncertain/cancelled，只是可
     * 观测快照）；以及 in-flight 让位路径上的错误/取消类收尾——在途补发循环
     * 只持有回合 A 的 text 副本，回合 B 的错误 reason 不会被它送达。 */
    onTurnEnd(chatId: string, sessionId: string, reason: DeferredTurnReason | undefined, ref?: string): boolean;
    /** /stop：显式终止该聊天的补发跟踪（pending 条目转 cancelled、计时器解除）；
     * 其他聊天不受影响。无运行中生成时也安全（清理陈旧条目）。 */
    cancelChat(chatId: string): void;
    /** Plugin stop: disarm every timer; entries stay as-is（pending 条目已
     * 落盘，重启后恢复跟踪）。 */
    stopAll(): void;
    private armTimer;
    private clearTimer;
    /** The silent window elapsed while the turn is still running: register the
     * entry, tell the chat, and mute the turn（takePendingText 清空 loopPending，
     * 正常终局路径不再有内容可刷）。 */
    private onTimeout;
    private deliverWithRetry;
    private sleep;
    /** Prune the oldest terminal entries beyond the cap（pending 永不裁剪）。 */
    private prune;
    private registryPath;
    /** Atomic full rewrite（唯一 tmp 后缀 + rename，对齐 registry.ts 纪律）。 */
    save(): Promise<void>;
    /** Startup recovery: load every persisted entry; pending ones resume
     * tracking（该会话的下一次 turn/end 兑现）。Per-line corrupt degrade:
     * 坏行跳过并告警，其余条目照常恢复；文件缺失 = 全新启动。 */
    loadPersisted(): Promise<void>;
    /** Test/diagnostic snapshot: the live entries (registry order). */
    snapshot(): DeferredEntry[];
}
