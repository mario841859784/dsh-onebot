import type { FailureRefRecord } from './ref.js';
/** How many recent ok:false events the report lists. */
export declare const HEALTH_RECENT_FAILURES = 5;
export interface HealthDeps {
    /** The plugin media dir (artifact source + archive destination). */
    mediaDir: string;
    /** Connection snapshot. */
    connection: {
        connected: boolean;
        selfId: string;
    };
    /** Transport config summary (mode/host/port) for the connection line. */
    transport: {
        mode: string;
        host: string;
        port: number;
    };
    /** Runtime transport retry/self-heal counters (defensive read of the
     * connection's internal state; undefined fields render as 未知). */
    retryState: {
        reverseRetryAttempts?: number;
        reconnectAttempts?: number;
        selfHealing?: boolean;
    };
    /** Dedup window snapshot. */
    dedup: {
        entries: number;
        windowSeconds: number;
    };
    /** Write-gate snapshot. */
    writeGate: {
        minuteUsed: number;
        minuteLimit: number;
        dayUsed: number;
        dayLimit: number;
    };
    /** Recorder state (absent = recording off). */
    recorder?: {
        enabled: boolean;
        redact: boolean;
        written: number;
    } | undefined;
    /** Inject channel state (absent = channel off). */
    inject?: {
        enabled: boolean;
        dryRun: boolean;
        consumed: number;
        intercepted: number;
        skippedHistory: number;
    } | undefined;
    /** #61: the live trace sink (structural — the report only reads its
     * counters). Absent = tracing off (traceEnabled=false leaves the sink
     * unconstructed); the report renders a visible off state instead of
     * silently omitting the section, so "trace on but zero records" after an
     * abnormal restart is diagnosable from /healthcheck. */
    trace?: {
        getStats(): {
            written: number;
            dropped: number;
            suppressed: number;
            writeFailures: number;
            rotated: number;
        };
    } | undefined;
    /** The already-redacted config snapshot (see redactSnapshot). */
    configSnapshot: Record<string, unknown>;
    /** Secret VALUES to scrub from every packed artifact (e.g. accessToken). */
    secrets?: readonly string[];
    /** How many recent ok:false events to include (default HEALTH_RECENT_FAILURES). */
    recentFailures?: number;
    /** W3/T4 (P3): the recent fault references (resolved live by the bridge);
     * absent = the report omits the reference section. */
    failureRefs?: () => FailureRefRecord[];
    /** W3/T4 (P3): the reference stamped into the exported archive file name
     * (explicit /healthcheck export argument, or the latest recorded fault). */
    triggerRef?: string;
    log(level: 'info' | 'warn', message: string): void;
}
/** Redact a config snapshot: secret-looking keys become 已配置/未配置, nested
 * objects are walked. Returns a new object (never mutates the input). */
export declare function redactSnapshot(config: Record<string, unknown>): Record<string, unknown>;
/** The secret scrub applied to every packed text artifact. */
export declare function scrubSecrets(text: string, secrets: readonly string[]): string;
/** One-line-per-artifact file size summary helper (human readable). */
export declare function formatBytes(size: number): string;
/** Render the healthcheck summary (plain text, one ▍ block). */
export declare function healthReport(deps: HealthDeps): Promise<string>;
interface TraceLine {
    ts: number;
    traceId: string;
    stage: string;
    ok: boolean;
    reason?: string;
    data?: {
        ref?: unknown;
    };
}
/** The most recent ok:false trace events (file order, newest last). */
export declare function recentFailures(file: string, count: number): Promise<TraceLine[]>;
/** Export the diagnostics archive; returns the archive path. */
export declare function exportDiagnostics(deps: HealthDeps): Promise<string>;
/** CRC-32 (IEEE 0xEDB88320, as required by the ZIP APPENDIX format). */
export declare function crc32(buf: Buffer): number;
/** Pack entries into a ZIP archive (method=stored, UTF-8 names). */
export declare function buildZip(entries: Array<{
    name: string;
    data: Buffer;
}>): Buffer;
export {};
