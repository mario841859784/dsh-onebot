/**
 * Interim domain (M2-D1-PR5): the loop-merge outbound mode — live interim
 * sends with per-message auto-recall timers, the turn/end settlement (one t2i
 * summary card → immediate recall of the still-on-screen originals → the
 * deferred final), and the assistant/message interim routing (id dedupe,
 * deferred-text flush, tool-call short-circuit). Extracted verbatim from
 * bridge.ts — method signatures and statement order are unchanged. The interim
 * state stays on ChatAgent (registry.ts): the inbound residue reset, the
 * /stop /retry manual clears and the registry dispose paths read and write
 * those fields directly, so the tracker operates on the same per-chat object
 * through the narrow InterimChat view.
 * @module dsh-onebot/interim
 */
import type { AssistantMessage } from '@deepseek-ai/dsh-llm';
import type { BridgeConfig } from './bridge.js';
import type { ChatId } from './chat.js';
import type { OutboundSegment, SendOptions } from './outbound.js';
/** Narrow view of a live chat the interim tracker may touch — the structural
 * subset of the bridge's ChatAgent carrying the interim state. The storage
 * itself stays on ChatAgent: the inbound pipeline's residue reset, the /stop
 * /retry manual clears and the registry dispose paths touch the same fields. */
export interface InterimChat {
    /** Buffered last-step text when interimMessages is off. */
    pendingFinal: string;
    /** Text deferred one step, awaiting the next assistant/message to prove it
     * interim — the last one is the final. */
    loopPending: string | null;
    /** Sent interim messages awaiting turn/end summary (text kept for the recap
     * t2i card). `sentAt` drives the per-message auto-recall scheduled after
     * each interim's send completes. */
    loopBuffer: Array<{
        id: string;
        text: string;
        sentAt: number;
    }>;
    /** Per-interim 90s (config interimRecallMs) auto-recall timers, keyed by
     * message id; cleared when turn/end recalls the originals immediately. */
    recallTimers: Map<string, ReturnType<typeof setTimeout>>;
    /** Interim message ids already auto-revoked by their 90s timer during a long
     * turn — skipped by the turn/end immediate recall (already gone from QQ). */
    recalledInterimIds: Set<string>;
    /** Last assistant message id already handled — duplicate session events
     * (streaming/usage re-emits of the same message) must not re-send it. */
    lastHandledMessageId: string | undefined;
}
/** The bridge capabilities the interim tracker touches. Deliberately narrower
 * than BridgeDeps: the outbound send paths as callbacks (the PR2 facade
 * contract — zero direct dependency on the outbound internals), the raw
 * OneBot action gate (delete_msg recalls), the send-chain tail settleLoop
 * drains, the host-card relay and the per-chat outbound-mode resolver the
 * assistant/message branch reads, the log, and the config subset the interim
 * domain actually reads. */
export interface InterimContext {
    /** Full outbound pipeline send (interim lines, summary-card text fallback,
     * deferred finals). */
    sendToChat(chatId: ChatId, text: string, options?: SendOptions): Promise<string[]>;
    /** Raw segment send (the summary t2i card). */
    sendMsg(chatId: ChatId, segments: OutboundSegment[], options: SendOptions): Promise<string | undefined>;
    /** Raw OneBot action invocation (delete_msg recalls). */
    call(action: string, params: Record<string, unknown>): Promise<unknown>;
    /** The chat's outbound send-chain tail (settleLoop drains it before
     * snapshotting the interim trail). */
    chainTail(chatId: ChatId): Promise<unknown>;
    /** Host-plane card relay (assistant/message branch, before any early return). */
    relayHostCards(chatId: ChatId, content: readonly unknown[]): void;
    /** Per-chat effective outbound mode (/mode override → global config). */
    effectiveInterim(chatId: ChatId): boolean;
    /** Bridge log line callback. */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** The only config fields the interim domain reads. */
    config: Pick<BridgeConfig, 'interimRecallMs' | 'maxImageBytes' | 'cardFooter' | 'fontFiles' | 'fontFamilies'>;
}
/**
 * The interim tracker: one per bridge, operating on the per-chat state through
 * InterimChat. The methods keep receiving chatId + chat exactly as their
 * pre-split bridge signatures did.
 */
export declare class InterimTracker {
    private readonly ctx;
    constructor(ctx: InterimContext);
    /**
     * turn/start (B8): prune the previous turn's recalled-id residue. Message
     * ids are per-send unique, so a pruned id can never be consulted by a later
     * turn/end recall — those reads only see the current turn's own buf. The
     * one benign race: a follow-up turn starting while the previous turn's
     * settleLoop recall is still draining loses the skip entries recorded
     * before the prune, so an already-revoked id gets one extra delete_msg that
     * fails and is logged at debug — no user-visible change.
     */
    onTurnStart(chat: InterimChat): void;
    /** The onSessionEvent assistant/message branch: dedupe, host-card relay,
     * then the interim/deferred routing. Verbatim from the pre-split bridge. */
    onAssistantMessage(chatId: ChatId, chat: InterimChat, message: AssistantMessage): void;
    /** The onSessionEvent turn/end interim part: settle the trail when the
     * effective mode is interim, else flush the deferred final. The rest of
     * the branch (error notice, typing, busy, flush) stays bridge-resident. */
    onTurnEnd(chatId: ChatId, chat: InterimChat): void;
    /** Cancel a message's pending 90s auto-recall timer. */
    private clearInterimTimer;
    /**
     * Recall the still-on-screen interim originals (turn/end step 2). Ids the
     * 90s timer already revoked during the turn are skipped (already gone).
     * Recall failure is logged only — the summary card still carries the text.
     */
    private recallLoopMessages;
    /** Fire when an interim's own 90s timer elapses mid-turn: revoke it alone. */
    private revokeInterim;
    /** Render this turn's interims into one t2i image (summary card, before final). */
    private sendInterimSummary;
    /** Send one interim live and record it: text for the turn/end summary card,
     * plus a per-message auto-recall timer (config interimRecallMs) so long turns
     * clean up their early messages even before the summary arrives. */
    private sendInterim;
    /**
     * Settle a finished turn's interim trail (interimMessages on): drain the send
     * chain so every interim id is recorded, then render ONE t2i summary card of
     * all interims, immediately recall the still-on-screen originals, and finally
     * send the deferred final text. No merged-forward any more — QQ refuses to
     * recall messages older than ~2 min, and a forward of aged interims would
     * leave the originals plus a duplicate card, so interims are surfaced live
     * and auto-revoked per message (90s) during long turns.
     */
    private settleLoop;
}
