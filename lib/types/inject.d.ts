import type { OneBotEvent } from './connection.js';
import type { ChatId } from './chat.js';
import type { TraceSink } from './trace.js';
/** Inject queue file name, polled under the media dir. */
export declare const INJECT_FILE = "qq-inject.jsonl";
/** message id returned for intercepted sends; recalls of such sends carry
 * this marker and are intercepted on sight (a real OneBot id is never negative). */
export declare const INTERCEPTED_MESSAGE_ID = -1;
/** Poll interval floor (ms). */
export declare const MIN_INJECT_INTERVAL_MS = 500;
/** Warn dedup window for read failures. */
export declare const INJECT_WARN_WINDOW_MS: number;
/** One injected round: minted per consumed line, shared with the whole
 * round's async chain so every interception is attributable. */
export interface InjectRound {
    traceId: string;
    intercepted: number;
}
/** Run `fn` inside an injected round (the bridge wraps injected handleInbound calls). */
export declare function runInjectRound<T>(round: InjectRound, fn: () => T): T;
/** The active injected round inside the current async chain, if any. */
export declare function currentInjectRound(): InjectRound | undefined;
/** Whether one OneBot action mutates remote state (the dry-run intercept class). */
export declare function isWriteAction(action: string): boolean;
/** Extract the human-readable original text of an outbound action payload
 * (text segments joined; used for the trace event's original copy). */
export declare function outboundTextOf(params: Record<string, unknown>): string;
export interface InjectChannelOptions {
    /** Directory the inject file lives in (the plugin media dir). */
    dir: string;
    /** Intercept all outbound writes of injected rounds (default true). */
    dryRun: boolean;
    /** Poll interval in ms (floored at MIN_INJECT_INTERVAL_MS). */
    intervalMs: number;
    /** Feed one consumed event into the real inbound pipeline. */
    handleEvent(event: OneBotEvent): Promise<void>;
    /** Optional trace sink (stage=inject events); absent → log only. */
    trace?: TraceSink | undefined;
    /** Log port. */
    log(level: 'info' | 'warn', message: string): void;
}
/**
 * The injection channel. Constructed only when injectEnabled is on; start()
 * skips historical lines (reporting the count), then polls for new complete
 * lines. Read/parse failures degrade to rate-limited warns — never thrown.
 */
export declare class InjectChannel {
    private readonly dryRun;
    /** The effective poll interval (floored at MIN_INJECT_INTERVAL_MS). */
    readonly intervalMs: number;
    private readonly opts;
    /** chatId → the unsettled injected round (async-reply guard); cleared by a
     * real dispatch to the same chat (never collaterally intercepting real users). */
    private readonly activeRounds;
    private timer;
    private consumedBytes;
    private lastWarnAt;
    private stopped;
    private readonly stats;
    constructor(options: InjectChannelOptions);
    /** Whether this channel intercepts outbound writes (dry-run mode). */
    get intercepting(): boolean;
    /** Skip the lines that already existed at startup (recorded + reported),
     * then start polling. */
    start(): void;
    stop(): Promise<void>;
    private skipHistory;
    private tick;
    /** Feed one consumed event through the real pipeline inside its round. */
    consume(event: OneBotEvent): Promise<void>;
    /** Bridge hook: register the current ALS round for a chat at dispatch time
     * so the async agent reply is attributable; a real dispatch clears the
     * chat's injected round instead. */
    noteDispatch(chatId: ChatId): void;
    /** The chat's unsettled injected round, if any. */
    activeRoundFor(chatId: ChatId): InjectRound | undefined;
    /** Forget a chat's round (chat removed / stop). */
    clearChat(chatId: ChatId): void;
    /**
     * Intercept one outbound write of an injected round (the outbound action
     * layer): count it, record the original text into the trace stream and
     * resolve with a marker message id so the pipeline proceeds error-free.
     */
    intercept(round: InjectRound | undefined, action: string, params: Record<string, unknown>): Promise<unknown>;
    /** Counters for tests / diagnostics. */
    getStats(): {
        consumed: number;
        skippedHistory: number;
        intercepted: number;
        parseErrors: number;
        readFailures: number;
    };
    private emitInjectEvent;
    private warnOnce;
}
