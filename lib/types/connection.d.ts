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
    private heartbeatTimer;
    private pending;
    private stopping;
    private reconnectPromise;
    private reconnectAttempts;
    private connectedFlag;
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
    private connectForwardOnce;
    private scheduleReconnect;
    private attachSocket;
    private startHeartbeat;
    private stopHeartbeat;
    private setConnected;
    private failAllPending;
    /** One JSON frame: an action response (has echo) or an inbound event. */
    private onFrame;
}
