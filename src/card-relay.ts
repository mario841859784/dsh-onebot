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
import type { ChatId } from './chat.js'

/** The capabilities the card relay touches: the outbound send path and the
 * bridge log (render failures are debug lines, relay failures warn lines).
 * T2-B2 adds the optional onQuestionCall hook for the answer-bridge state. */
export interface CardRelayContext {
  /** Outbound pipeline send (bridge facade). */
  sendToChat(chatId: ChatId, text: string): Promise<string[]>
  /** Bridge log line callback. */
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
  /** T2-B2: called once per relayed ask_user_question call with the parsed batch. */
  onQuestionCall?(chatId: ChatId, call: RelayQuestionCall): void
}

/** One parsed question ready for the QQ answer loop. */
export interface RelayQuestion {
  /** Question id as given by the model (falls back to a positional q1/q2/...). */
  id: string
  /** The question body text. */
  question: string
  /** Optional short header ('' when absent). */
  header: string
  /** Option labels in display order (positional 1/a/b/c mapping). */
  options: string[]
  /** Whether the model allowed multiple selections. */
  multiSelect: boolean
}

/** A parsed ask_user_question tool call: callId + question batch. */
export interface RelayQuestionCall {
  /** ToolCallBlock.id — the host callId used to settle the answer batch. */
  callId: string
  questions: RelayQuestion[]
}

/** Tool calls whose host-plane UI has no QQ equivalent; relay them to the chat. */
export function relayHostCards(ctx: CardRelayContext, chatId: ChatId, content: readonly unknown[]): void {
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const call = block as { type?: string; name?: string; id?: string; arguments?: string }
    if (call.type !== 'tool-call') continue
    if (call.name === 'exit_plan_mode') {
      const text = renderPlanCard(call.arguments, ctx.log)
      if (text !== undefined) {
        ctx.sendToChat(chatId, text).catch((error: unknown) => {
          ctx.log('warn', 'plan card relay failed: ' + String(error))
        })
      }
    } else if (call.name === 'ask_user_question') {
      const parsed = parseQuestionCall(call.arguments, typeof call.id === 'string' ? call.id : undefined, ctx.log)
      if (parsed === undefined) continue
      if (ctx.onQuestionCall !== undefined && parsed.callId !== '') {
        try {
          ctx.onQuestionCall(chatId, parsed)
        } catch (error: unknown) {
          ctx.log('debug', 'question state update failed: ' + String(error))
        }
      }
      ctx.sendToChat(chatId, renderQuestionCard(parsed)).catch((error: unknown) => {
        ctx.log('warn', 'question card relay failed: ' + String(error))
      })
    }
  }
}

/** Render an exit_plan_mode tool-call's plan for QQ, or undefined when unusable. */
export function renderPlanCard(rawArguments: string | undefined, log: CardRelayContext['log']): string | undefined {
  if (typeof rawArguments !== 'string' || rawArguments === '') return undefined
  try {
    const parsed = JSON.parse(rawArguments) as { plan?: unknown }
    if (typeof parsed.plan !== 'string' || parsed.plan.trim() === '') return undefined
    return '【📋 计划书】请确认以下计划——可在 Web 卡片确认，或直接回复「确认/继续」供参考：\n' + parsed.plan.trim()
  } catch {
    log('debug', 'plan card parse failed')
    return undefined
  }
}

/**
 * Parse an ask_user_question tool-call block into a RelayQuestionCall (T2-B2).
 * @param rawArguments - the block's raw JSON arguments.
 * @param callId - the block's provider-issued call id (missing → '' and the
 *   caller must not register the batch, since it can never be settled).
 * @param log - bridge log for parse failures.
 */
export function parseQuestionCall(
  rawArguments: string | undefined,
  callId: string | undefined,
  log: CardRelayContext['log'],
): RelayQuestionCall | undefined {
  if (typeof rawArguments !== 'string' || rawArguments === '') return undefined
  let parsed: { questions?: unknown }
  try {
    parsed = JSON.parse(rawArguments) as { questions?: unknown }
  } catch {
    log('debug', 'question card parse failed')
    return undefined
  }
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return undefined
  const questions: RelayQuestion[] = []
  parsed.questions.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return
    const question = entry as {
      id?: unknown; question?: unknown; header?: unknown; options?: unknown; multi_select?: unknown
    }
    if (typeof question.question !== 'string') return
    const id = typeof question.id === 'string' && question.id !== '' ? question.id : 'q' + (index + 1)
    const header = typeof question.header === 'string' ? question.header : ''
    const options = Array.isArray(question.options)
      ? question.options
        .map((option) => (typeof option === 'object' && option !== null ? (option as { label?: unknown }).label : undefined))
        .filter((label): label is string => typeof label === 'string')
      : []
    questions.push({
      id,
      question: question.question,
      header,
      options,
      multiSelect: question.multi_select === true,
    })
  })
  if (questions.length === 0) return undefined
  return { callId: callId ?? '', questions }
}

/** Render a parsed ask_user_question call as the QQ option card (T2-B2 text). */
export function renderQuestionCard(call: RelayQuestionCall): string {
  const lines: string[] = ['【❓ 提问】回复编号或字母选择，多选用逗号，回复『跳过』放弃；自由回答用「答:内容」：']
  call.questions.forEach((question, index) => {
    lines.push((index + 1) + '. ' + (question.header !== '' ? '[' + question.header + '] ' : '') + question.question)
    question.options.forEach((label, i) => {
      lines.push('   ' + 'abcd'.charAt(i) + ') ' + label)
    })
    if (question.multiSelect) lines.push('   （可多选）')
  })
  return lines.join('\n')
}
