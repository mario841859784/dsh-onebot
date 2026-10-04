/** Trace jsonl file name, appended under the media dir. */
export declare const TRACE_FILE = "qq-trace.jsonl";
/** Rotated file name for one generation (1 → qq-trace.1.jsonl). */
export declare function traceRotatedFile(generation: number): string;
/** Size cap per trace file; at the cap the file is renamed aside (rotation). */
export declare const TRACE_MAX_BYTES: number;
/** How many rotated files are kept (qq-trace.1.jsonl, qq-trace.2.jsonl). */
export declare const TRACE_KEEP_ROTATED = 2;
/** Max events buffered in the async write queue; beyond it the oldest is dropped. */
export declare const TRACE_MAX_QUEUE = 1000;
/** Same-cause (stage + reason) rate-limit window in ms. */
export declare const TRACE_SAME_CAUSE_WINDOW_MS: number;
/** Max tracked same-cause keys (LRU-evicted beyond this). */
export declare const TRACE_MAX_CAUSE_KEYS = 512;
/** Max reason length carried by one event (competitor-aligned). */
export declare const REASON_MAX_LENGTH = 300;
/** Write-failure warn dedup window (same 5-minute discipline). */
export declare const TRACE_WRITE_WARN_WINDOW_MS: number;
/** Stage vocabulary (pipeline-hooks.md §4: competitor table trimmed + this
 * plugin's own branches; `dedup` covers the W2-② window). */
export declare const TRACE_STAGES: {
    readonly inbound: "收到消息";
    readonly normalize: "消息归一化";
    readonly self: "自身消息过滤";
    readonly whitelist: "白名单";
    readonly mention: "群聊 @ 门";
    readonly dedup: "重复投递";
    readonly command: "命令";
    readonly media: "媒体处理";
    readonly quote: "引用解析";
    readonly forward: "合并转发";
    readonly transcribe: "语音转文字";
    readonly ratelimit: "入站限流";
    readonly dispatch: "交给模型";
    readonly agent: "模型回合";
    readonly outbound: "出站发送";
    readonly queue: "离线队列";
    readonly interim: "中间消息";
    readonly notice: "通知";
    readonly inject: "事件注入";
    readonly replay: "离线回放";
};
export type TraceStage = keyof typeof TRACE_STAGES;
/** Central Chinese reason table (pipeline-hooks.md §6: maintained in one
 * place so tests can enumerate every reason exhaustively). Reasons with
 * dynamic detail (error text, ids) are composed at the call sites and reuse
 * these as prefixes. */
export declare const TRACE_REASONS: {
    readonly inboundStopping: "插件停止中，消息丢弃";
    readonly inboundNotChat: "非聊天消息事件，不处理";
    readonly inboundSelf: "机器人自己的消息已忽略";
    readonly inboundDmBlocked: "私聊用户不在允许名单，已忽略";
    readonly inboundGroupBlocked: "群聊不在允许名单，已忽略";
    readonly inboundUnmentioned: "群聊未 @ 机器人，已忽略";
    readonly inboundCommand: "消息已由命令处理";
    readonly inboundDedup: "消息在去重窗口内重复投递，已跳过";
    readonly inboundRateLimited: "消息频率超限，已丢弃";
    readonly inboundRateNoticeFailed: "限流提示发送失败";
    readonly inboundEmptyContent: "消息展开后无有效文本内容，已丢弃";
    readonly mediaResolveFailed: "媒体解析失败，占位符保留原文";
    readonly nasFileTooLarge: "QQ 文件超过大小上限，已跳过获取";
    readonly nasFileFailed: "QQ 文件获取失败：无可用来源";
    readonly sttEmpty: "语音转写结果为空";
    readonly transcriptNoChat: "语音转写结果无处投递";
    readonly outboundQueued: "连接断开，回复已排队等待重连补发";
    readonly outboundNotConnected: "连接断开，发送失败";
    readonly queueFull: "离线回复队列已满，丢弃最旧一条";
    readonly queueTtlExpired: "排队回复超过 5 分钟未送达，已丢弃";
    readonly outboundSensitive: "出站内容命中敏感词审计";
    readonly outboundCardTooLarge: "文字图卡片超过大小上限，已降级为文本";
    readonly outboundEmptyText: "正文为空，未发送";
    readonly noticeErrorSendFailed: "错误通知发送失败";
};
/** Short, sortable trace id (`t-<base36 seconds>-<n>`); form aligned with the
 * MIT competitor (trace.js:44-47). */
export declare function newTraceId(now?: number): string;
/** One event as appended to the jsonl file. */
export interface TraceEvent {
    v: 1;
    ts: number;
    traceId: string;
    stage: TraceStage;
    ok: boolean;
    reason?: string;
    chatId?: string;
    messageId?: string;
    ms?: number;
    data?: Record<string, unknown>;
}
/** The per-message handle the sink hands out: emit() fills the correlation
 * fields (traceId/chatId/messageId) so call sites only name the decision. */
export interface TraceScope {
    readonly traceId: string;
    readonly chatId: string;
    readonly messageId: string | undefined;
    emit(stage: TraceStage, opts?: {
        ok?: boolean;
        reason?: string;
        ms?: number;
        data?: Record<string, unknown>;
    }): void;
}
/** Run `fn` inside a trace scope; with no scope (disabled) this is a plain call. */
export declare function runWithTrace<T>(scope: TraceScope | undefined, fn: () => T): T;
/** The active trace scope, or undefined outside one / when tracing is off. */
export declare function currentTrace(): TraceScope | undefined;
export interface TraceSinkOptions {
    /** Directory the jsonl file lives in (the plugin media dir). */
    dir?: string;
    /** Master switch; false = emit() is a no-op and no file is ever created. */
    enabled?: boolean;
    /** 'debug' records every event; 'warn' records only ok:false events. */
    level?: 'debug' | 'warn';
    /** Rotation size cap (tests shrink it; default 4MiB). */
    maxBytes?: number;
    /** Async queue capacity (tests shrink it; default 1000). */
    maxQueue?: number;
    /** Rotated files kept (tests may use fewer). */
    keepRotated?: number;
    /** Clock override (tests). */
    now?: () => number;
    /** Warn port for write failures. */
    log?: (level: 'warn', message: string) => void;
}
/**
 * The trace sink: async queued JSONL appends with size-cap rename rotation,
 * same-cause 5-minute rate limiting and a level filter. The pipeline only
 * ever calls emit(), which enqueues synchronously (microsecond-scale) and
 * never awaits disk — a burst cannot block message handling, and a full
 * queue drops the oldest events (counted, never thrown).
 */
export declare class TraceSink {
    readonly enabled: boolean;
    private readonly level;
    private readonly dir;
    private readonly maxBytes;
    private readonly maxQueue;
    private readonly keepRotated;
    /** Clock override (tests); shared with scope creators for id minting. */
    private readonly nowFn;
    private readonly log;
    private readonly queue;
    private readonly causes;
    /** Serialized writer chain: flushes never interleave appends. */
    private writeChain;
    private dirEnsured;
    private lastWriteWarnAt;
    private readonly stats;
    constructor(options?: TraceSinkOptions);
    /** The sink's clock (id minting at call sites reads the same clock). */
    now(): number;
    /** Build the per-message scope handle. */
    scope(traceId: string, chatId: string, messageId?: string): TraceScope;
    /**
     * Record one decision event. Synchronous queue push; disk writes happen on
     * the serialized writer chain. Returns the event when it was enqueued,
     * null when it was filtered (disabled / level / same-cause window).
     */
    emit(input: {
        traceId: string;
        stage: TraceStage;
        ok?: boolean;
        reason?: string;
        chatId?: string;
        messageId?: string;
        ms?: number;
        data?: Record<string, unknown>;
    }): TraceEvent | null;
    /** Drain the queue to disk; safe to call concurrently (the writer chain
     * serializes) and cheap when the queue is empty. */
    flush(): Promise<void>;
    private drain;
    private fileAtCap;
    private rotate;
    /** Counters for tests / diagnostics: written / queue-overflow dropped /
     * same-cause suppressed / write failures / rotations. */
    getStats(): {
        written: number;
        dropped: number;
        suppressed: number;
        writeFailures: number;
        rotated: number;
    };
}
