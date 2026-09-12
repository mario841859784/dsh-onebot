/**
 * Outbound delivery pipeline (M2-D1-PR2): the per-chat serial send chain,
 * sendToChat (sensitive audit → [[qq_forward]] blocks → t2i card / split
 * text), raw OneBot segment sends, merged forwards, and the M1-B6 offline
 * resend queue (per-chat FIFO, cap 20, TTL 5 min, drained on reconnect).
 * Extracted verbatim from bridge.ts — send order, queueing, TTL/cap and
 * fallback behavior are byte-identical; the bridge keeps same-name facade
 * methods so tools.ts, the command table and the interim domain (still
 * bridge-resident) keep working unchanged.
 * @module dsh-onebot/outbound
 */
import type { BridgeConfig } from './bridge.js';
import type { ChatId } from './chat.js';
/** One OneBot message segment for outbound sends. */
export interface OutboundSegment {
    type: string;
    data: Record<string, unknown>;
}
/** Options for an explicit outbound send (from tools). */
export interface SendOptions {
    replyTo?: string;
    /** Queue the send for resend on reconnect instead of failing while the
     * connection is down. Only for model final replies; interim sends carry
     * recall timers + bookkeeping and must never be replayed. */
    queuable?: boolean;
}
/** Narrow view of a live chat the outbound pipeline may touch — the
 * structural subset of the bridge's ChatAgent the pipeline reads: the
 * nickname used as the t2i card title. Re-evaluated for B8d: the per-chat
 * send chain now lives in the pipeline itself (sendChains), so the chat view
 * no longer carries the queue field. */
export interface OutboundChat {
    lastNickname: string;
}
/** The bridge capabilities the outbound pipeline touches. Deliberately
 * narrower than BridgeDeps: the connection call gate, the live chat lookup
 * for the per-chat send chain, the stop flag guarding the B6 drain, and the
 * config subset the pipeline reads — never the agent registry, media store,
 * or policy. */
export interface OutboundContext {
    /** Live chat lookup (card-title nickname). */
    getChat(chatId: ChatId): OutboundChat | undefined;
    /** Whether the OneBot connection currently accepts sends. */
    connected(): boolean;
    /** The connection's own QQ id (forward-node uin). */
    selfId(): string;
    /** Raw OneBot action invocation (send_msg / send_*_forward_msg). */
    call(action: string, params: Record<string, unknown>): Promise<unknown>;
    /** Bridge stop flag: the B6 drain must never run while stopping. */
    isStopping(): boolean;
    /** Bridge log line callback. */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** The only config fields the outbound pipeline reads. */
    config: Pick<BridgeConfig, 'botQQ' | 'sensitivePatterns' | 'splitLength' | 'textImageThreshold' | 'maxImageBytes' | 'cardFooter' | 'fontFiles' | 'fontFamilies'>;
}
/**
 * The outbound pipeline. Owns the B6 pendingSends state; the bridge keeps
 * same-name delegating facades and wires the reconnect drain trigger.
 */
export declare class OutboundPipeline {
    private readonly ctx;
    /** Per-chat FIFO of model final replies parked while disconnected; drained
     * oldest-first on reconnect (M1-B6). */
    private readonly pendingSends;
    constructor(ctx: OutboundContext);
    /**
     * Send plain text to a chat with the full outbound pipeline (forward
     * blocks, Markdown strip, sentence splitting).
     * @param chatId - target chat.
     * @param text - model-produced text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    sendToChat(chatId: ChatId, text: string, options?: SendOptions): Promise<string[]>;
    /** Park one queuable send for a chat while disconnected (M1-B6):
     * per-chat FIFO, capped — the oldest entry is dropped beyond the cap. */
    private queuePendingSend;
    /** Resend parked final replies oldest-first after a reconnect (M1-B6).
     * Per-chat send chains keep the order; a send that hits a fresh
     * disconnection re-queues itself via the queuable gate. Expired entries
     * (TTL) are dropped. Never runs while stopping. Wired from the bridge's
     * onStatus(true) handler (bridge.start). */
    drainPendingSends(): void;
    /**
     * Send raw OneBot segments (used by the media tools).
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId: ChatId, segments: OutboundSegment[]): Promise<string | undefined>;
    /** B8d: per-chat send chains owned by the pipeline (decoupled from the
     * registry's chat lifecycle — unregistered chats serialize too, the
     * original C6b ask). Entries clean themselves up once settled so evicted
     * chats do not accumulate. */
    private readonly sendChains;
    /** Serialize work on one chat's send chain. */
    private enqueue;
    /** The chat's send-chain tail; resolves once every queued send has settled
     * (settleLoop snapshots the interim trail after it, preserving order). */
    chainTail(chatId: ChatId): Promise<unknown>;
    /** Send one message to a chat and return its message id. */
    sendMsg(chatId: ChatId, segments: OutboundSegment[], options: SendOptions): Promise<string | undefined>;
    /** Send [[qq_forward]] nodes as a merged-forward message. */
    sendForward(chatId: ChatId, nodes: Array<{
        name: string;
        content: string;
    }>): Promise<void>;
}
