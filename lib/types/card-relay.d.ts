/**
 * Host-plane card relay (M2-D1-PR2): tool calls whose host-plane UI has no
 * QQ equivalent (exit_plan_mode plan books, ask_user_question option cards)
 * are rendered to plain-text cards and relayed through the outbound pipeline.
 * Extracted verbatim from bridge.ts; the bridge keeps a thin relayHostCards
 * delegation so the onSessionEvent call site is unchanged.
 * T2-B2: ask_user_question calls additionally carry their tool callId and a
 * parsed question batch back to the bridge (onQuestionCall) so inbound plain
 * replies can be intercepted as answers (question-answer.ts).
 * @module dsh-onebot/card-relay
 */
import type { ChatId } from './chat.js';
/** The capabilities the card relay touches: the outbound send path and the
 * bridge log (render failures are debug lines, relay failures warn lines).
 * T2-B2 adds the optional onQuestionCall hook for the answer-bridge state. */
export interface CardRelayContext {
    /** Outbound pipeline send (bridge facade). */
    sendToChat(chatId: ChatId, text: string): Promise<string[]>;
    /** Bridge log line callback. */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** T2-B2: called once per relayed ask_user_question call with the parsed batch. */
    onQuestionCall?(chatId: ChatId, call: RelayQuestionCall): void;
}
/** One parsed question ready for the QQ answer loop. */
export interface RelayQuestion {
    /** Question id as given by the model (falls back to a positional q1/q2/...). */
    id: string;
    /** The question body text. */
    question: string;
    /** Optional short header ('' when absent). */
    header: string;
    /** Option labels in display order (positional 1/a/b/c mapping). */
    options: string[];
    /** Whether the model allowed multiple selections. */
    multiSelect: boolean;
}
/** A parsed ask_user_question tool call: callId + question batch. */
export interface RelayQuestionCall {
    /** ToolCallBlock.id — the host callId used to settle the answer batch. */
    callId: string;
    questions: RelayQuestion[];
}
/** Tool calls whose host-plane UI has no QQ equivalent; relay them to the chat. */
export declare function relayHostCards(ctx: CardRelayContext, chatId: ChatId, content: readonly unknown[]): void;
/** Render an exit_plan_mode tool-call's plan for QQ, or undefined when unusable. */
export declare function renderPlanCard(rawArguments: string | undefined, log: CardRelayContext['log']): string | undefined;
/**
 * Parse an ask_user_question tool-call block into a RelayQuestionCall (T2-B2).
 * @param rawArguments - the block's raw JSON arguments.
 * @param callId - the block's provider-issued call id (missing → '' and the
 *   caller must not register the batch, since it can never be settled).
 * @param log - bridge log for parse failures.
 */
export declare function parseQuestionCall(rawArguments: string | undefined, callId: string | undefined, log: CardRelayContext['log']): RelayQuestionCall | undefined;
/** Render a parsed ask_user_question call as the QQ option card (T2-B2 text).
 * The header line mirrors question-answer.ts's parse contract: pure numbered
 * selection is only unambiguous for single-question batches (parseQuestionAnswer
 * returns undefined when questions.length !== 1), so multi-question batches
 * steer the user to the whole-batch 答:/跳过 forms instead. T2-board: a
 * single question with NO options rejects pure numbering too (parseQuestionAnswer
 * returns undefined when options.length === 0), so its header guides the
 * 答:/跳过 forms instead of the numbered-selection mislead. */
export declare function renderQuestionCard(call: RelayQuestionCall): string;
