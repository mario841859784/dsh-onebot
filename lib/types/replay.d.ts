import type { AccessPolicyConfig } from './chat.js';
/** One replayed message's summary entry. */
export interface ReplayEntry {
    traceId: string;
    chatId: string;
    kind: string;
    /** The final decision (the last chain event; ok=false = dropped/failed). */
    decision: {
        stage: string;
        ok: boolean;
        reason?: string;
    };
    /** The full decision chain (stage/ok/reason per event). */
    chain: Array<{
        stage: string;
        ok: boolean;
        reason?: string;
    }>;
}
/** The replay report. */
export interface ReplayReport {
    sourceFile: string;
    /** Lines seen in the file. */
    total: number;
    /** Lines replayed through the pipeline. */
    replayed: number;
    /** Lines skipped (unparseable). */
    skipped: number;
    /** Outbound write actions intercepted by the forced dry-run. */
    interceptedOutbound: number;
    entries: ReplayEntry[];
}
export interface ReplayOptions {
    /** Path to the recorded inbox jsonl (or a rotated generation). */
    inboxFile: string;
    /** Directory for the replay's trace sink (sandbox; also the report file dir). */
    traceDir: string;
    /** Media dir for the replay assembly's MediaStore (sandbox). */
    mediaDir?: string;
    /** Max messages to replay (default all). */
    limit?: number;
    /** Policy gates for the replay assembly (defaults fully open). */
    policy?: Partial<AccessPolicyConfig>;
    /** The bot's own QQ (ignoreSelf comparisons). */
    botQQ?: string;
    /** ignoreSelf / requireMention / dedupWindowSeconds overrides. */
    ignoreSelf?: boolean;
    requireMention?: boolean;
    dedupWindowSeconds?: number;
    /** Write the JSON report here when set. */
    outFile?: string;
    /** Log port (default console). */
    log?(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
}
/**
 * Replay a recorded inbox file through the real inbound pipeline with forced
 * dry-run semantics and return the per-message decision summary.
 */
export declare function replayInbox(options: ReplayOptions): Promise<ReplayReport>;
