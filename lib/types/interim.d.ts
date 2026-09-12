/**
 * Interim domain (M2-D1-PR5 extraction; M3-D2a explicit machine): the
 * loop-merge outbound mode — live interim sends with per-message auto-recall
 * timers, the turn/end settlement (one t2i summary card → immediate recall
 * of the still-on-screen originals → the deferred final), and the
 * assistant/message interim routing (id dedupe, deferred-text flush,
 * tool-call short-circuit). M3-D2a: the per-chat cycle runs an explicit
 * idle/accumulating/settling state machine and every interim is booked at
 * SEND ENQUEUE time (placeholder entry, message ids backfilled on send
 * completion) — settlement drains enqueue-count == completion-count and no
 * longer depends on microtask registration order. The interim fields stay
 * on ChatAgent (registry.ts): the inbound residue reset, the /stop /retry
 * manual clears and the registry dispose paths read and write those fields
 * directly, so the tracker operates on the same per-chat object through the
 * narrow InterimChat view (the machine state itself lives in a WeakMap
 * keyed by the chat object — no registry field, dies with the chat).
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
    /** Text deferred one step in either outbound mode — proven interim by the
     * next assistant/message (flushed live), else the final at turn/end.
     * M3-D2a: the former instant-mode-only pendingFinal folded in. */
    loopPending: string | null;
    /** Sent interim messages awaiting turn/end summary (text kept for the recap
     * t2i card). M3-D2a: booked at send-enqueue time as a placeholder entry;
     * `id` is backfilled per QQ message id when the send completes and `sentAt`
     * is stamped then. */
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
/** The explicit per-chat cycle state (M3-D2a). 'idle': nothing deferred or
 * in flight. 'accumulating': a turn is producing text (interims booking,
 * deferred text awaiting proof). 'settling': turn/end started the settlement
 * drain. Transitions live only in the entry methods (onAssistantMessage /
 * onTurnEnd / onNewUserTurn, plus the turn/start normalization). */
export type InterimState = 'idle' | 'accumulating' | 'settling';
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
    config: Pick<BridgeConfig, 'interimRecallMs' | 'interimRecall' | 'maxImageBytes' | 'cardFooter' | 'fontFiles' | 'fontFamilies'>;
}
/**
 * The interim tracker: one per bridge, operating on the per-chat state through
 * InterimChat. The methods keep receiving chatId + chat exactly as their
 * pre-split bridge signatures did.
 */
export declare class InterimTracker {
    private readonly ctx;
    /** Per-chat machine records (see InterimCycle). */
    private readonly cycles;
    constructor(ctx: InterimContext);
    /** The (lazy-created) machine record for one chat. */
    private cycle;
    /**
     * turn/start (B8): prune the previous turn's recalled-id residue. Message
     * ids are per-send unique, so a pruned id can never be consulted by a later
     * turn/end recall — those reads only see the current turn's own buf. The
     * one benign race: a follow-up turn starting while the previous turn's
     * settleLoop recall is still draining loses the skip entries recorded
     * before the prune, so an already-revoked id gets one extra delete_msg that
     * fails and is logged at debug — no user-visible change. Machine: the new
     * turn normalizes the cycle to idle (it accumulates from scratch).
     */
    onTurnStart(chat: InterimChat): void;
    /** Diagnostic read of one chat's machine state (the state-machine unit
     * tests drive the transition table through this seam). */
    stateOf(chat: InterimChat): InterimState;
    /** A new user turn starts (wired from dispatchFollowup): the inbound
     * pipeline has already reset the residue fields directly; the machine
     * normalizes to idle so the new cycle accumulates from scratch. */
    onNewUserTurn(chat: InterimChat): void;
    /** The onSessionEvent assistant/message branch: dedupe, host-card relay,
     * then the interim/deferred routing. Machine: every handled text message
     * starts or continues accumulation — accepted from every state (a late
     * message during settlement behaved unguarded before the rewrite; the
     * permissive semantics are kept). */
    onAssistantMessage(chatId: ChatId, chat: InterimChat, message: AssistantMessage): void;
    /** The onSessionEvent turn/end interim part: settle the trail when the
     * effective mode is interim, else flush the deferred final. The rest of
     * the branch (error notice, typing, busy, flush) stays bridge-resident.
     * Machine: idle/accumulating → settling (interim) or idle (instant); a
     * turn/end while a settlement is already draining is skipped — the second
     * pass found only a drained trail before the rewrite (a harmless no-op),
     * and skipping it keeps the two passes from racing. */
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
    /** Send one interim live and book it SYNCHRONOUSLY (M3-D2a): a placeholder
     * entry enters the loop buffer at enqueue time; when the send completes it
     * is backfilled in place with one entry per QQ message id and the
     * per-message auto-recall timer (config interimRecallMs) is armed, so long
     * turns clean up their early messages even before the summary arrives. The
     * send's settled promise joins the cycle's in-flight set — the trail no
     * longer depends on a push callback racing the turn/end snapshot. */
    private sendInterim;
    /** Send completion: backfill the placeholder in place with one entry per
     * message id (a placeholder already dropped from the buffer — the inbound
     * residue reset swapped the array — is never re-added) and arm the per-id
     * auto-recall timers (skipped when the interimRecall degrade switch is
     * false): the messages are on screen. */
    private completeInterim;
    /** Send failure: drop the placeholder so the cycle never summarizes or
     * recalls a message that never reached QQ (the pre-rewrite code simply
     * never pushed an entry on failure). */
    private dropInterim;
    /**
     * Settle a finished turn's interim trail (interimMessages on): drain the
     * send chain (cross-send ordering, as before) and the cycle's in-flight
     * set (bookkeeping: enqueue count == completion count — no reliance on
     * microtask registration order), then render ONE t2i summary card of
     * all interims, immediately recall the still-on-screen originals, and finally
     * send the deferred final text. With the interimRecall degrade switch off,
     * the summary card and the immediate recall are skipped — the turn ends
     * with the final text only. No merged-forward any more — QQ refuses to
     * recall messages older than ~2 min, and a forward of aged interims would
     * leave the originals plus a duplicate card, so interims are surfaced live
     * and auto-revoked per message (90s) during long turns.
     */
    private settleLoop;
}
