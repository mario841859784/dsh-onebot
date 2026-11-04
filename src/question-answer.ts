/**
 * QQ reply → ask_user_question answer-batch parser (T2-B3). Pure text
 * classification: a plain reply is treated as an answer only when it is a
 * pure option selection, an explicit 答:/answer: free-text prefix, or an
 * explicit skip. Everything else falls through to the normal conversation
 * so ordinary chat is never swallowed.
 * @module dsh-onebot/question-answer
 */
import type { AskUserAnswer } from './ask-tool.js'
import type { RelayQuestion } from './card-relay.js'

/** Exact-match skip words (case-insensitive for the latin one). */
const SKIP_WORDS = new Set(['跳过', 'skip'])

/**
 * Parse a QQ reply as an answer to the active question batch.
 * @param text - raw inbound text (trimmed here).
 * @param questions - the active batch (non-empty when a question is outstanding).
 * @returns one answer entry per question, or undefined when the text is not
 *   an answer (caller must let the message flow into the conversation).
 */
export function parseQuestionAnswer(
  text: string,
  questions: readonly RelayQuestion[],
): AskUserAnswer[] | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  // 显式放弃：selected 为空的回答项表示用户跳过（宿主语义：continue without it）。
  if (SKIP_WORDS.has(trimmed) || SKIP_WORDS.has(trimmed.toLowerCase())) {
    return questions.map((question) => ({ id: question.id, selected: [] }))
  }
  // 显式自由回答前缀：答:… / answer:…（大小写、全半角冒号均可）。
  const customMatch = /^(?:答|answer)\s*[:：]\s*([\s\S]+)$/i.exec(trimmed)
  if (customMatch !== null) {
    const custom = customMatch[1].trim()
    if (custom === '') return undefined
    return questions.map((question) => ({ id: question.id, selected: [], custom }))
  }
  // 纯选项选择：仅对单题批次无歧义（多题时一串编号无法映射到各题）。
  if (questions.length !== 1) return undefined
  const question = questions[0]
  if (question.options.length === 0) return undefined
  if (!/^[\dA-Za-z]+(?:[,，、\s]+[\dA-Za-z]+)*$/.test(trimmed)) return undefined
  const selected: string[] = []
  for (const token of trimmed.split(/[,，、\s]+/)) {
    const label = optionLabel(token, question.options)
    if (label === undefined) return undefined
    if (!selected.includes(label)) selected.push(label)
  }
  return [{ id: question.id, selected }]
}

/** Map one selection token (1-based number or letter) to an option label. */
function optionLabel(token: string, options: readonly string[]): string | undefined {
  if (/^\d+$/.test(token)) {
    const index = Number(token) - 1
    return index >= 0 && index < options.length ? options[index] : undefined
  }
  if (/^[A-Za-z]$/.test(token)) {
    const index = token.toLowerCase().charCodeAt(0) - 'a'.charCodeAt(0)
    return index >= 0 && index < options.length ? options[index] : undefined
  }
  return undefined
}
