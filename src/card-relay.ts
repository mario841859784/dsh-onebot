/**
 * Host-plane card relay (M2-D1-PR2): tool calls whose host-plane UI has no
 * QQ equivalent (exit_plan_mode plan books, ask_user_question option cards)
 * are rendered to plain-text cards and relayed through the outbound pipeline.
 * Extracted verbatim from bridge.ts; the bridge keeps a thin relayHostCards
 * delegation so the onSessionEvent call site is unchanged.
 * @module dsh-onebot/card-relay
 */
import type { ChatId } from './chat.js'

/** The capabilities the card relay touches: the outbound send path and the
 * bridge log (render failures are debug lines, relay failures warn lines). */
export interface CardRelayContext {
  /** Outbound pipeline send (bridge facade). */
  sendToChat(chatId: ChatId, text: string): Promise<string[]>
  /** Bridge log line callback. */
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
}

/** Tool calls whose host-plane UI has no QQ equivalent; relay them to the chat. */
export function relayHostCards(ctx: CardRelayContext, chatId: ChatId, content: readonly unknown[]): void {
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const call = block as { type?: string; name?: string; arguments?: string }
    if (call.type !== 'tool-call') continue
    if (call.name === 'exit_plan_mode') {
      const text = renderPlanCard(call.arguments, ctx.log)
      if (text !== undefined) {
        ctx.sendToChat(chatId, text).catch((error: unknown) => {
          ctx.log('warn', 'plan card relay failed: ' + String(error))
        })
      }
    } else if (call.name === 'ask_user_question') {
      const text = renderQuestionCard(call.arguments, ctx.log)
      if (text !== undefined) {
        ctx.sendToChat(chatId, text).catch((error: unknown) => {
          ctx.log('warn', 'question card relay failed: ' + String(error))
        })
      }
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

/** Render an ask_user_question tool-call's questions for QQ, or undefined when unusable. */
export function renderQuestionCard(rawArguments: string | undefined, log: CardRelayContext['log']): string | undefined {
  if (typeof rawArguments !== 'string' || rawArguments === '') return undefined
  try {
    const parsed = JSON.parse(rawArguments) as { questions?: unknown }
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return undefined
    const lines: string[] = ['【❓ 提问】请回答以下问题（可回复选项/文字）：']
    parsed.questions.forEach((q, index) => {
      const question = q as { header?: unknown; question?: unknown; options?: unknown; multi_select?: boolean }
      const header = typeof question.header === 'string' && question.header !== '' ? question.header : ''
      const body = typeof question.question === 'string' ? question.question : ''
      lines.push((index + 1) + '. ' + (header !== '' ? '[' + header + '] ' : '') + body)
      if (Array.isArray(question.options)) {
        question.options.forEach((opt, i) => {
          const label = (opt as { label?: unknown })?.label
          const labelText = typeof label === 'string' ? label : ''
          lines.push('   ' + 'abcd'.charAt(i) + ') ' + labelText)
        })
      }
      if (question.multi_select === true) lines.push('   （可多选）')
    })
    return lines.join('\n')
  } catch {
    log('debug', 'question card parse failed')
    return undefined
  }
}
