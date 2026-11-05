/**
 * Timed ask_user_question tool for the QQ channel (T2-B1): a self-contained
 * re-implementation of the host @deepseek-ai/dsh-tool-ask-user timed variant
 * (that package is not resolvable from this plugin's node_modules). Registered
 * per agent scope from installChannelScope, so only QQ sessions expose it; the
 * scoped registration shadows any global host registration. When a deployment
 * preset already mounted the host tool into the same scope, the duplicate
 * registration error is tolerated (debug log, no disposer).
 * @module dsh-onebot/ask-tool
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { describeError } from './errors.js'

/** Default foreground wait (task板 T2-B1): 300s before the tool returns pending. */
export const ASK_USER_TIMEOUT_SECONDS = 300

/** Upper bound mirrored from the host timed tool's validateTimeout. */
const MAX_TIMEOUT_SECONDS = 2147483

/** One question option as accepted from the model (schema case, snake_case). */
export interface AskQuestionOptionInput {
  label: string
  description?: string
}

/** One question as accepted from the model (schema case, snake_case). */
export interface AskQuestionInput {
  id: string
  question: string
  header?: string
  options?: AskQuestionOptionInput[]
  multi_select?: boolean
}

/** camelCase projection sent to the host userQuestions service. */
export interface AskQuestionRequest {
  id: string
  question: string
  header?: string
  options?: AskQuestionOptionInput[]
  multiSelect?: boolean
}

/** One per-question answer entry as returned/accepted by the host service. */
export interface AskUserAnswer {
  id: string
  selected: string[]
  custom?: string
}

/** The slice of the host userQuestions service the timed tool calls. */
export interface AskUserQuestionsPort {
  askTimed(
    request: { questions: AskQuestionRequest[]; agent?: unknown; signal?: AbortSignal },
    callId: string,
    timeoutMs: number,
  ): Promise<{ pending: true; callId: string } | { answers: AskUserAnswer[] }>
}

/** The slice of the host userQuestions service the inbound answer path calls (T2-B3). */
export interface UserQuestionAnswerPort {
  /** Resolves true when the batch was accepted into a continued-state question. */
  answer(agent: unknown, callId: string, payload: { answers: AskUserAnswer[] }): Promise<boolean>
}

/** The full host userQuestions surface the bridge uses (B1 tool + B3 answer). */
export type UserQuestionsPort = AskUserQuestionsPort & UserQuestionAnswerPort

/**
 * Resolve the host userQuestions service from a context without declaring it
 * in the plugin's inject list (dsh-base always registers it, but a missing
 * service must degrade to "no ask tool", never block plugin load).
 *
 * Goes through ctx.get: without inject, cordis throws on the property read from
 * any child fiber (the plugin itself, an agent scope) even though a sibling
 * plugin provides the service. Plain-object test fakes have no get.
 * @param ctx - cordis context (host or agent scope).
 * @returns the service, or undefined when unavailable.
 */
export function resolveUserQuestions(ctx: Context): UserQuestionsPort | undefined {
  try {
    const host = ctx as unknown as { get?: (name: string) => unknown; userQuestions?: UserQuestionsPort }
    const service = typeof host.get === 'function' ? host.get('userQuestions') as UserQuestionsPort | undefined : host.userQuestions
    return service ?? undefined
  } catch {
    return undefined
  }
}

/** Validate a per-call timeout: positive integer up to the host bound.
 *
 * 有意偏离（deliberate deviation）：宿主 dsh-tool-ask-user 的 timed 变体接受
 * -1 表示无限前台等待；本复刻不接受——QQ 桥接的结算主路径依赖「前台等待
 * 超时 → 转 pending → 用户后续回复经 inbound 拦截由 answer() 结算」。若
 * 无限等待，问题将永停 open 态而无法从 QQ 侧结算，故非正数一律拒绝。
 *
 * 宿主升级同步点：本文件是宿主 dsh-tool-ask-user 协议的内联复刻（宿主包
 * 不可解析所致，见评审 R4）；升级宿主时须将本函数与宿主 timed ask 的
 * timeout 语义逐形状重对照，确认偏离仍成立或恢复宿主语义。
 */
export function validateTimeout(timeout: unknown): number {
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) {
    throw new Error('timeout must be a positive integer up to ' + MAX_TIMEOUT_SECONDS
      + ' seconds；无限等待（-1）在 QQ 桥接下不可结算，请传有限秒数')
  }
  return timeout
}

/** Validate that question ids are unique within the call (host parity). */
export function validateQuestionIds(questions: readonly AskQuestionInput[]): void {
  const seen = new Set<string>()
  for (const question of questions) {
    if (seen.has(question.id)) {
      throw new Error('question id ' + JSON.stringify(question.id) + ' must be unique within this call')
    }
    seen.add(question.id)
  }
}

/** Map a schema-case question to the service camelCase request shape. */
function toRequest(question: AskQuestionInput): AskQuestionRequest {
  const options = Array.isArray(question.options)
    ? question.options
      .filter((option): option is AskQuestionOptionInput =>
        typeof option === 'object' && option !== null && typeof option.label === 'string')
      .map((option) => option.description === undefined ? { label: option.label } : { label: option.label, description: option.description })
    : undefined
  return {
    id: question.id,
    question: question.question,
    ...(question.header !== undefined ? { header: question.header } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(question.multi_select === true ? { multiSelect: true } : {}),
  }
}

/** Copy an answer batch verbatim (host answerResult parity). */
function answerResult(result: { answers: AskUserAnswer[] }): { answers: AskUserAnswer[] } {
  return {
    answers: result.answers.map((answer) => ({
      id: answer.id,
      selected: [...answer.selected],
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    })),
  }
}

/** Model-facing pending notice (host pendingNotice parity). */
const PENDING_NOTICE = 'No answer batch arrived before the timeout. This is pending, not a skipped answer. '
  + 'Continue useful independent work. The user can still answer; their reply will be a user message '
  + 'identified as answer_to_pending_question with this callId and the original questions. '
  + 'Do not treat this as permission. '
  + '（QQ 端：用户随后的回复若匹配该问题，插件会自动结算并把答案回传给你。）'

export interface AskUserToolOptions {
  /** Foreground wait seconds; defaults to ASK_USER_TIMEOUT_SECONDS. */
  timeoutSeconds?: number
  /** Registration outcome logger (duplicate-mount tolerance is silent at info level). */
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void
}

/**
 * Register the timed ask_user_question tool on an agent-scope context.
 * @param ctx - the agent scope context (installChannelScope's argument).
 * @param options - timeout and logger.
 * @returns the tool disposer, or undefined when the host service is absent or
 *   the tool is already registered in this scope (e.g. preset-mounted).
 */
export function registerAskUserTool(ctx: Context, options: AskUserToolOptions = {}): (() => void) | undefined {
  const log = options.log ?? (() => {})
  const userQuestions = resolveUserQuestions(ctx)
  if (userQuestions === undefined) {
    log('debug', '宿主无 userQuestions 服务，跳过 ask_user_question 注册')
    return undefined
  }
  const defaultTimeout = validateTimeout(options.timeoutSeconds ?? ASK_USER_TIMEOUT_SECONDS)
  const tool = defineTool({
    name: 'ask_user_question',
    description: 'Ask brief, direct, self-contained questions about missing information before you continue. '
      + 'Each question is answered exactly once; a response item with empty selected and no custom means the user '
      + 'skipped that question: continue without it, do not ask it again, and do not treat the skip as permission. '
      + 'A pending result instead means no answer batch arrived before the timeout and the user can still answer.',
    parameters: {
      questions: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Unique id for this question within the call.' },
            question: { type: 'string', description: 'The question text.' },
            header: { type: 'string', description: 'Optional short header shown before the question.' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
              },
              description: 'Fixed options; omit for a free-form question.',
            },
            multi_select: { type: 'boolean', description: 'Allow multiple options per answer.' },
          },
        },
        description: 'Questions to ask. Keep each self-contained: the user replies from QQ without seeing the conversation.',
      },
      timeout: {
        type: 'integer',
        description: 'Seconds to wait for an answer before returning pending. Default ' + defaultTimeout + '.',
      },
    },
    output: {
      schema: { type: 'json' as const },
      render: (_args: unknown, value: unknown) => {
        const result = value as { pending?: boolean; answers?: AskUserAnswer[] }
        if (result !== null && typeof result === 'object' && result.pending === true) {
          return [{ type: 'text' as const, text: JSON.stringify(result) }]
        }
        const answers = result?.answers ?? []
        const lines = answers.map((answer) => {
          const parts = [answer.id + ': ' + (answer.selected.length > 0 ? answer.selected.join(', ') : '（未选选项）')]
          if (answer.custom !== undefined && answer.custom !== '') parts.push('补充: ' + answer.custom)
          return parts.join('；')
        })
        return [{ type: 'text' as const, text: '用户已回答：\n' + lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const input = args as { questions?: unknown; timeout?: unknown }
      const questions = Array.isArray(input.questions) ? input.questions as AskQuestionInput[] : []
      if (questions.length === 0) throw new Error('ask_user_question: questions 不能为空')
      for (const question of questions) {
        if (typeof question.id !== 'string' || question.id === '') throw new Error('ask_user_question: 每个问题必须有非空 id')
        if (typeof question.question !== 'string' || question.question.trim() === '') throw new Error('ask_user_question: 每个问题必须有 question 文本')
      }
      validateQuestionIds(questions)
      const timeout = input.timeout === undefined || input.timeout === null ? defaultTimeout : validateTimeout(input.timeout)
      if (exec.agent === undefined) throw new Error('timed questions require a live agent')
      const result = await userQuestions.askTimed(
        { questions: questions.map(toRequest), agent: exec.agent, signal: exec.signal },
        exec.callId,
        timeout * 1000,
      )
      if ('pending' in result) return { ...result, message: PENDING_NOTICE } as unknown as JsonValue
      return answerResult(result) as unknown as JsonValue
    },
  })
  try {
    const disposer = ctx.tools.register(tool)
    log('debug', 'ask_user_question 已注册（timed，默认 ' + defaultTimeout + 's）')
    return disposer
  } catch (error) {
    // Preset already mounted the host tool into this scope — its tool wins.
    log('debug', 'ask_user_question 注册跳过（本 scope 已有同名工具）: ' + describeError(error))
    return undefined
  }
}
