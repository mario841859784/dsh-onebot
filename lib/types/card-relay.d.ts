/**
 * Host-plane card relay (M2-D1-PR2): tool calls whose host-plane UI has no
 * QQ equivalent (exit_plan_mode plan books, ask_user_question option cards)
 * are rendered to plain-text cards and relayed through the outbound pipeline.
 * Extracted verbatim from bridge.ts; the bridge keeps a thin relayHostCards
 * delegation so the onSessionEvent call site is unchanged.
 * @module dsh-onebot/card-relay
 */
import type { ChatId } from './chat.js';
/** The capabilities the card relay touches: the outbound send path and the
 * bridge log (render failures are debug lines, relay failures warn lines). */
export interface CardRelayContext {
    /** Outbound pipeline send (bridge facade). */
    sendToChat(chatId: ChatId, text: string): Promise<string[]>;
    /** Bridge log line callback. */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
}
/** Tool calls whose host-plane UI has no QQ equivalent; relay them to the chat. */
export declare function relayHostCards(ctx: CardRelayContext, chatId: ChatId, content: readonly unknown[]): void;
/** Render an exit_plan_mode tool-call's plan for QQ, or undefined when unusable. */
export declare function renderPlanCard(rawArguments: string | undefined, log: CardRelayContext['log']): string | undefined;
/** Render an ask_user_question tool-call's questions for QQ, or undefined when unusable. */
export declare function renderQuestionCard(rawArguments: string | undefined, log: CardRelayContext['log']): string | undefined;
