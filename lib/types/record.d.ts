import type { OneBotEvent } from './connection.js';
import type { TraceScope } from './trace.js';
/** Recorded inbox file name, appended under the media dir. */
export declare const INBOX_FILE = "qq-inbox.jsonl";
/** Rotated file name for one generation (1 → qq-inbox.1.jsonl). */
export declare function inboxRotatedFile(generation: number): string;
/** Size cap per inbox file (competitor-aligned 2 MiB); at the cap the file is renamed aside. */
export declare const INBOX_MAX_BYTES: number;
/** How many rotated files are kept. */
export declare const INBOX_KEEP_ROTATED = 2;
/** Sender-controlled text is truncated to this length before serialization. */
export declare const INBOX_TEXT_MAX_CHARS = 2000;
/** Write-failure warn dedup window. */
export declare const INBOX_WRITE_WARN_WINDOW_MS: number;
/** One frame's recorded business fields (socket/unknown fields dropped). */
export interface InboxFrame {
    post_type?: string;
    message_type?: string;
    sub_type?: string;
    notice_type?: string;
    request_type?: string;
    user_id?: string;
    group_id?: string;
    self_id?: string;
    message_id?: string;
    message?: unknown;
    raw_message?: string;
    sender?: {
        user_id?: string;
        nickname?: string;
        card?: string;
        role?: string;
    };
}
/** The decision captured while the bridge settled the event. */
export interface InboxDecision {
    stage: string;
    ok: boolean;
    reason?: string;
}
/** One line as appended to the jsonl file. */
export interface InboxLine {
    v: 1;
    ts: number;
    kind: string;
    frame: InboxFrame;
    decision?: InboxDecision;
}
export interface InboundRecorderOptions {
    /** Directory the jsonl file lives in (the plugin media dir). */
    dir: string;
    /** Mask 6+ digit runs before serialization (default false). */
    redact?: boolean;
    /** Rotation size cap (tests shrink it; default 2 MiB). */
    maxBytes?: number;
    /** Rotated files kept (tests may use fewer). */
    keepRotated?: number;
    /** Clock override (tests). */
    now?: () => number;
    /** Warn port for write failures. */
    log?: (level: 'warn', message: string) => void;
}
/** Mask every digit run of length ≥6 (the first three digits stay readable). */
export declare function redactDigits(text: string): string;
/** Deep-redact a frame: strings get redactDigits, numeric/other id values are
 * converted to their redacted string form, unknown fields are dropped. */
export declare function redactFrame(frame: InboxFrame): InboxFrame;
/** Reduce one raw event to the replayable business frame; sender-controlled
 * text fields are truncated to INBOX_TEXT_MAX_CHARS. */
export declare function toInboxFrame(event: OneBotEvent): InboxFrame;
/** Per-event session: the bridge fills the decision through the scope while
 * the pipeline settles, then calls end() exactly once. */
export interface InboundRecordSession {
    /** The capture scope handed to runWithTrace when the trace sink is off:
     * it only records the decision chain, never writes a trace file. */
    captureScope(): TraceScope;
    /** Wrap an existing (trace-enabled) scope so decisions are captured too. */
    wrapScope(scope: TraceScope): TraceScope;
    /** Write the line (frame + last captured decision) on the writer chain. */
    end(): void;
}
/**
 * The inbound recorder. Default OFF — constructed only when recordInbound is
 * enabled; the bridge skips it entirely otherwise (zero overhead, zero files).
 */
export declare class InboundRecorder {
    private readonly dir;
    /** Whether 6+ digit runs are masked before serialization (health reads this). */
    readonly redact: boolean;
    private readonly maxBytes;
    private readonly keepRotated;
    private readonly nowFn;
    private readonly log;
    private writeChain;
    private dirEnsured;
    private lastWriteWarnAt;
    private readonly stats;
    constructor(options: InboundRecorderOptions);
    /** Begin one inbound event's record; the returned session must be ended by
     * the bridge once the synchronous decision settled. */
    begin(event: OneBotEvent): InboundRecordSession;
    /** Enqueue one line on the serialized writer chain; never awaited by the
     * pipeline, never throws. */
    private write;
    private fileAtCap;
    private rotate;
    /** Flush the writer chain (tests). */
    flush(): Promise<void>;
    /** Counters for tests / diagnostics. */
    getStats(): {
        written: number;
        dropped: number;
        writeFailures: number;
        rotated: number;
    };
}
