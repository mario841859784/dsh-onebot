/**
 * QQ reply → ask_user_question answer-batch parser (T2-B3). Pure text
 * classification: a plain reply is treated as an answer only when it is a
 * pure option selection, an explicit 答:/answer: free-text prefix, or an
 * explicit skip. Everything else falls through to the normal conversation
 * so ordinary chat is never swallowed.
 * @module dsh-onebot/question-answer
 */
import type { AskUserAnswer } from './ask-tool.js';
import type { RelayQuestion } from './card-relay.js';
/**
 * Parse a QQ reply as an answer to the active question batch.
 * @param text - raw inbound text (trimmed here).
 * @param questions - the active batch (non-empty when a question is outstanding).
 * @returns one answer entry per question, or undefined when the text is not
 *   an answer (caller must let the message flow into the conversation).
 */
export declare function parseQuestionAnswer(text: string, questions: readonly RelayQuestion[]): AskUserAnswer[] | undefined;
