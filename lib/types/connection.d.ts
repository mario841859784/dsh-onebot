/**
 * OneBot 11 WebSocket transport: reverse server (NapCat ws-reverse dials in)
 * and forward client (we dial NapCat's ws server), frame handling, echo
 * correlation for action calls, heartbeat, and reconnect-with-backoff.
 * Ported from the Hermes OneBotAdapter connection half.
 * @module dsh-onebot/connection
 */
/** OneBot 11 event payload (loose: implementations vary). */
export interface OneBotEvent {
    post_type?: string;
    message_type?: string;
    notice_type?: string;
    request_type?: string;
    user_id?: number | string;
    group_id?: number | string;
    self_id?: number | string;
    message_id?: number | string;
    message?: unknown;
    raw_message?: string;
    sender?: {
        user_id?: number | string;
        nickname?: string;
        card?: string;
        role?: string;
    };
    [key: string]: unknown;
}
/** Action-call result from the OneBot endpoint. */
export interface ActionResult {
    status: string;
    retcode: number;
    data: unknown;
    wording?: string;
}
/** Connection mode. */
export type OneBotMode = 'reverse' | 'forward';
/** Transport configuration. */
export interface ConnectionConfig {
    mode: OneBotMode;
    host: string;
    port: number;
    url: string;
    accessToken: string;
    /** Per-action call timeout in ms. */
    callTimeoutMs: number;
    /**
     * Forward-mode reconnect attempt limit before giving up with a recovery
     * hint. Undefined keeps the built-in default (100); 0 retries forever (the
     * backoff ladder still caps the delay at its last value).
     */
    reconnectMaxAttempts?: number;
    /**
     * M3-E3b: injected log sink (level, message). Absent → a console fallback
     * keeps the transport independently usable; index.ts wires the same
     * deps.log the bridge uses.
     */
    log?: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
}
/** Error thrown for action calls that fail or time out. */
export declare class OneBotActionError extends Error {
    constructor(message: string);
}
/** Error thrown when the transport is not connected. */
export declare class OneBotNotConnectedError extends Error {
    constructor(message?: string);
}
/**
 * OneBot 11 transport. One instance handles exactly one peer: either a
 * reverse server accepting NapCat's dial-in or a forward client dialing out.
 * All frames share the same correlation table.
 */
export declare class OneBotConnection {
    readonly config: ConnectionConfig;
    /** Inbound message event handler; the bridge/plugin wires this. */
    onMessage: (event: OneBotEvent) => void;
    /** Meta event handler (self_id learning). */
    onMeta: (event: OneBotEvent) => void;
    /** Connection-state callback. */
    onStatus: (connected: boolean) => void;
    private server;
    private socket;
    private lastPongAt;
    private heartbeatTimer;
    private pending;
    private stopping;
    private reconnectPromise;
    private reconnectTimer;
    private reconnectAttempts;
    private connectedFlag;
    /** Reverse churn guard: timestamps (ms) of recent healthy-socket replacements. */
    private reverseReplaces;
    /** W2-①: pending EADDRINUSE bind retry timer (reverse mode). */
    private reverseRetryTimer;
    /** W2-①: bind failures since the last successful listen (log dedup + takeover count). */
    private reverseRetryAttempts;
    /** W2-④: pending self-heal dial timer (forward mode, after the ladder gave up). */
    private selfHealTimer;
    /** W2-④: true from a self-heal dial start until it succeeds (routes failures back to self-heal). */
    private selfHealing;
    /** W2-④: start timestamps (ms) of self-heal dials within the rolling hour. */
    private selfHealTimes;
    /** The bot's own QQ id, learned from meta events (or config botQQ). */
    selfId: string;
    constructor(config: ConnectionConfig);
    /** Whether the transport currently has a live socket. */
    get connected(): boolean;
    /** The reverse server's bound address (for tests / diagnostics), if any. */
    address(): {
        host: string;
        port: number;
    } | undefined;
    /**
     * M3-E3b: the transport's single log exit. The injected config.log is the
     * production sink (index.ts wires the same deps.log the bridge uses); the
     * console fallback keeps the class independently usable. Messages carry no
     * '[dsh-onebot] ' prefix — the sink owns prefixing.
     */
    private log;
    /** Start the transport (server or client) without blocking. */
    start(): void;
    /** Stop the transport: close sockets, cancel reconnects, fail pending calls. */
    stop(): Promise<void>;
    /**
     * Call a OneBot action and await its data payload.
     * @param action - OneBot 11 action name.
     * @param params - action parameters (plain object).
     * @returns the action data payload (object or array).
     * @throws OneBotNotConnectedError / OneBotActionError on failure or timeout.
     */
    call(action: string, params: Record<string, unknown>): Promise<unknown>;
    private startReverseServer;
    /**
     * W2-①: EADDRINUSE is no longer a dead end. ws does not emit 'close' after
     * a failed bind, so the failed instance would hang on this.server forever —
     * and the start() reentrancy guard would then block even a manual restart.
     * This handler (1) closes and detaches the dead instance, (2) logs with
     * steady-state dedup (first failure + one line per 10 minutes), and
     * (3) schedules a fixed 15s re-bind until the port is released or stop()
     * is called. No attempt cap; the timer is unref'd and the retry is never
     * awaited, so host startup stays unblocked and the loop cannot keep the
     * process alive on its own.
     */
    private scheduleReverseRetry;
    private connectForwardOnce;
    private scheduleReconnect;
    /**
     * Failure-path dispatcher: while a self-heal dial is in flight (selfHealing),
     * failures route back to the self-heal scheduler instead of the ladder, so
     * the give-up state is not silently rebuilt. Anything else keeps the ladder
     * semantics untouched.
     */
    private scheduleForwardRetry;
    /**
     * W2-④: long-period recovery after the reconnect ladder gave up. Dials every
     * 15s, but a rolling-hour budget of SELF_HEAL_HOURLY_CAP attempts applies;
     * once exhausted the interval stretches to 60s, so a multi-hour outage dials
     * at most 15s×budget + 60/hour afterwards instead of hammering the peer.
     * The ladder state (reconnectAttempts) stays frozen at its give-up value; a
     * successful dial clears everything (see the 'open' handler).
     */
    private scheduleSelfHeal;
    private attachSocket;
    private startHeartbeat;
    private stopHeartbeat;
    private setConnected;
    private failAllPending;
    /** One JSON frame: an action response (has echo) or an inbound event. */
    private onFrame;
}
