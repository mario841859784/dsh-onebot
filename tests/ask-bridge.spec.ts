/**
 * T2「ask_user_question QQ 桥接」三段测试：
 * - B1 registerAskUserTool（timed 变体注册 / 容错 / execute pending 与 answers 路径）
 * - B2 parseQuestionCall + renderQuestionCard（callId/题目提取、卡片文案）
 * - B3 parseQuestionAnswer（纯选项/答:前缀/跳过/多题回落）+ 桥级拦截闭环
 * @module dsh-onebot/tests/ask-bridge
 */
import { describe, expect, it, vi } from 'vitest'

import {
  ASK_USER_TIMEOUT_SECONDS,
  registerAskUserTool,
  validateQuestionIds,
  validateTimeout,
  type AskQuestionInput,
  type AskUserQuestionsPort,
} from '../src/ask-tool.js'
import { parseQuestionCall, relayHostCards, renderQuestionCard, type CardRelayContext, type RelayQuestionCall } from '../src/card-relay.js'
import { parseQuestionAnswer } from '../src/question-answer.js'
import { ANSWER_ACCEPTED_NOTICE } from '../src/bridge.js'
import { makeCmdHarness, makeEvent, makeHarness, sentTexts } from './helpers/bridge-harness.js'

const noopLog: CardRelayContext['log'] = () => undefined

/** A fake host userQuestions port with per-test resolution control. */
function makeUserQuestions(overrides?: Partial<AskUserQuestionsPort>) {
  const calls: Array<{ request: unknown; callId: string; timeoutMs?: number }> = []
  const port: AskUserQuestionsPort = {
    askTimed: vi.fn(async (request: unknown, callId: string, timeoutMs?: number) => {
      calls.push({ request, callId, timeoutMs })
      return { pending: true, callId }
    }),
    ...overrides,
  }
  return { port, calls }
}

/** A minimal cordis-like ctx that only registerAskUserTool touches. */
function makeFakeCtx(userQuestions: unknown) {
  const registered: Array<{ name: string }> = []
  const ctx = {
    tools: { register: (tool: { name: string }) => { registered.push(tool); return () => undefined } },
    userQuestions,
  }
  return { ctx: ctx as never, registered }
}

/** Minimal ToolRunContext stub for direct execute() invocation. */
const fakeExec = { callId: 'call-1', agent: { id: 'a1' }, signal: new AbortController().signal } as never

const questions: AskQuestionInput[] = [
  { id: 'q1', question: '选哪个方案？', options: [{ label: '方案A' }, { label: '方案B' }], multi_select: true },
]

describe('T2-B1 registerAskUserTool', () => {
  it('registers the timed ask_user_question tool and forwards the batch to askTimed', async () => {
    const { port, calls } = makeUserQuestions()
    const { ctx, registered } = makeFakeCtx(port)
    const disposer = registerAskUserTool(ctx, {})
    expect(disposer).toBeTypeOf('function')
    expect(registered.map(t => t.name)).toEqual(['ask_user_question'])
    const tool = registered[0] as unknown as {
      execute: (args: unknown, exec: unknown) => Promise<unknown>
    }
    // Default timeout rides ASK_USER_TIMEOUT_SECONDS (300s) into askTimed (ms).
    await tool.execute({ questions }, fakeExec)
    expect(calls).toHaveLength(1)
    expect(calls[0].callId).toBe('call-1')
    expect(calls[0].timeoutMs).toBe(ASK_USER_TIMEOUT_SECONDS * 1000)
    const request = calls[0].request as { questions: Array<{ id: string; multiSelect?: boolean }> }
    expect(request.questions[0].id).toBe('q1')
    expect(request.questions[0].multiSelect).toBe(true)
  })

  it('returns the pending payload with the pendingNotice message on timeout', async () => {
    const { port } = makeUserQuestions({
      askTimed: vi.fn(async (_request: unknown, callId: string) => ({ pending: true as const, callId })),
    })
    const { ctx, registered } = makeFakeCtx(port)
    const tool = (registerAskUserTool(ctx, {}) && registered[0]) as unknown as {
      execute: (args: unknown, exec: unknown) => Promise<{ pending?: boolean; message?: string; answers?: unknown }>
    }
    const result = await tool.execute({ questions }, fakeExec)
    expect(result.pending).toBe(true)
    expect(result.message).toContain('answer_to_pending_question')
    expect(result.message).toContain('pending')
  })

  it('returns the copied answer batch on settlement', async () => {
    const { port } = makeUserQuestions({
      askTimed: vi.fn(async () => ({ answers: [{ id: 'q1', selected: ['方案A', '方案B'], custom: '都要' }] })),
    })
    const { ctx, registered } = makeFakeCtx(port)
    const tool = (registerAskUserTool(ctx, {}) && registered[0]) as unknown as {
      execute: (args: unknown, exec: unknown) => Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>
    }
    const result = await tool.execute({ questions }, fakeExec)
    expect(result.answers).toEqual([{ id: 'q1', selected: ['方案A', '方案B'], custom: '都要' }])
  })

  it('honors the per-call timeout override', async () => {
    const { port, calls } = makeUserQuestions()
    const { ctx, registered } = makeFakeCtx(port)
    const tool = (registerAskUserTool(ctx, {}) && registered[0]) as unknown as {
      execute: (args: unknown, exec: unknown) => Promise<unknown>
    }
    await tool.execute({ questions, timeout: 5 }, fakeExec)
    expect(calls[0].timeoutMs).toBe(5000)
  })

  it('skips registration when the host service is absent and tolerates duplicates', () => {
    const { ctx: emptyCtx, registered: empty } = makeFakeCtx(undefined)
    expect(registerAskUserTool(emptyCtx, {})).toBeUndefined()
    expect(empty).toHaveLength(0)
    // A preset-mounted same-name tool in this scope must not break chat creation.
    const { ctx: dupCtx, registered: dup } = makeFakeCtx(makeUserQuestions().port)
    dupCtx.tools.register = () => { throw new Error('tool "ask_user_question" is already registered in this scope') }
    expect(registerAskUserTool(dupCtx, {})).toBeUndefined()
  })

  it('validates timeout and question ids (host parity)', async () => {
    expect(() => validateTimeout(0)).toThrow()
    expect(() => validateTimeout(1.5)).toThrow()
    expect(() => validateTimeout(2147484)).toThrow()
    expect(validateTimeout(1)).toBe(1)
    // 有意偏离宿主 -1 无限等待：QQ 桥接结算主路径依赖超时转 pending，报错须说明原因
    expect(() => validateTimeout(-1)).toThrow('无限等待（-1）在 QQ 桥接下不可结算，请传有限秒数')
    expect(() => validateTimeout(0)).toThrow('请传有限秒数')
    expect(() => validateQuestionIds([{ id: 'a', question: 'x' }, { id: 'a', question: 'y' }])).toThrow('must be unique')
    const { port } = makeUserQuestions()
    const { ctx, registered } = makeFakeCtx(port)
    const tool = (registerAskUserTool(ctx, {}) && registered[0]) as unknown as {
      execute: (args: unknown, exec: unknown) => Promise<unknown>
    }
    await expect(tool.execute({ questions: [] }, fakeExec)).rejects.toThrow('questions 不能为空')
    await expect(tool.execute({ questions: [{ id: '', question: 'x' }] }, fakeExec)).rejects.toThrow('id')
    await expect(tool.execute({ questions, timeout: 0 }, fakeExec)).rejects.toThrow('timeout')
  })
})

describe('T2-B2 card relay question extraction', () => {
  const toolCallBlock = {
    type: 'tool-call',
    id: 'c2',
    name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [
      { id: 'q1', question: '选哪个方案？', header: '方案', options: [{ label: '方案A' }, { label: '方案B' }], multi_select: true },
    ] }),
  }

  it('renders the T2 card text with selection/skip/free-form guidance', () => {
    const parsed = parseQuestionCall(toolCallBlock.arguments, 'c2', noopLog)
    expect(parsed).toBeDefined()
    const text = renderQuestionCard(parsed!)
    expect(text).toContain('回复编号或字母选择，多选用逗号，回复『跳过』放弃')
    expect(text).toContain('答:内容')
    expect(text).toContain('1. [方案] 选哪个方案？')
    expect(text).toContain('a) 方案A')
    expect(text).toContain('（可多选）')
  })

  it('single question with no options guides 答:/跳过 instead of numbered selection (T2-board)', () => {
    const parsed = parseQuestionCall(JSON.stringify({ questions: [
      { id: 'q1', question: '说说你的想法' },
    ] }), 'c6', noopLog)
    expect(parsed).toBeDefined()
    const text = renderQuestionCard(parsed!)
    // 与解析端对称：options 为空时 parseQuestionAnswer 必拒纯编号，头行不得再引导编号选择
    expect(text).toContain('本题没有候选项：回复「答:内容」自由作答，或回复『跳过』放弃')
    expect(text).not.toContain('回复编号或字母选择')
    expect(text).toContain('1. 说说你的想法')
  })

  it('multi-question batch renders whole-batch 答:/跳过 guidance without the numbered-selection mislead', () => {
    const parsed = parseQuestionCall(JSON.stringify({ questions: [
      { id: 'q1', question: '第一题', options: [{ label: '甲' }, { label: '乙' }] },
      { id: 'q2', question: '第二题', options: [{ label: '丙' }] },
    ] }), 'c3', noopLog)
    expect(parsed).toBeDefined()
    const text = renderQuestionCard(parsed!)
    // 与解析端对称：questions.length !== 1 时纯编号/字母选择不可解析，文案不得再引导
    expect(text).toContain('2 道题：回复『答:内容』整体回答（应用于全部题目），或回复『跳过』放弃')
    expect(text).toContain('纯编号选择仅单题支持')
    expect(text).not.toContain('多选用逗号')
  })

  it('renders option letters past d and falls back to numbers past z', () => {
    const five = parseQuestionCall(JSON.stringify({ questions: [
      { id: 'q1', question: '五选项', options: [{ label: 'o1' }, { label: 'o2' }, { label: 'o3' }, { label: 'o4' }, { label: 'o5' }] },
    ] }), 'c4', noopLog)
    expect(renderQuestionCard(five!)).toContain('e) o5')

    const twentySeven = parseQuestionCall(JSON.stringify({ questions: [
      { id: 'q1', question: '二十七选项', options: Array.from({ length: 27 }, (_, i) => ({ label: '选项' + (i + 1) })) },
    ] }), 'c5', noopLog)
    const text = renderQuestionCard(twentySeven!)
    expect(text).toContain('z) 选项26')
    expect(text).toContain('27) 选项27') // >26 回退 1-based 数字编号，optionLabel 同样接受
  })

  it('calls onQuestionCall with the callId and parsed batch', () => {
    const seen: Array<{ chatId: string; call: RelayQuestionCall }> = []
    const ctx: CardRelayContext = {
      sendToChat: async () => [],
      log: noopLog,
      onQuestionCall: (chatId, call) => { seen.push({ chatId, call }) },
    }
    relayHostCards(ctx, 'private:10001', [toolCallBlock])
    expect(seen).toHaveLength(1)
    expect(seen[0].chatId).toBe('private:10001')
    expect(seen[0].call.callId).toBe('c2')
    expect(seen[0].call.questions).toEqual([
      { id: 'q1', question: '选哪个方案？', header: '方案', options: ['方案A', '方案B'], multiSelect: true },
    ])
  })

  it('still relays the card but registers nothing when the callId is missing', () => {
    const seen: RelayQuestionCall[] = []
    const sent: string[] = []
    const ctx: CardRelayContext = {
      sendToChat: async (_chatId, text) => { sent.push(text); return [] },
      log: noopLog,
      onQuestionCall: (_chatId, call) => { seen.push(call) },
    }
    const block = { ...toolCallBlock, id: undefined }
    relayHostCards(ctx, 'private:10001', [block])
    expect(seen).toHaveLength(0)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('选哪个方案？')
  })

  it('drops malformed batches without registering or sending', () => {
    const seen: RelayQuestionCall[] = []
    const sent: string[] = []
    const ctx: CardRelayContext = {
      sendToChat: async (_chatId, text) => { sent.push(text); return [] },
      log: noopLog,
      onQuestionCall: (_chatId, call) => { seen.push(call) },
    }
    relayHostCards(ctx, 'private:10001', [
      { type: 'tool-call', id: 'c3', name: 'ask_user_question', arguments: '{not json' },
      { type: 'tool-call', id: 'c4', name: 'ask_user_question', arguments: JSON.stringify({ questions: [] }) },
    ])
    expect(seen).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })
})

describe('T2-B3 parseQuestionAnswer', () => {
  const one: RelayQuestionCall['questions'] = [
    { id: 'q1', question: '选哪个方案？', header: '', options: ['方案A', '方案B', '方案C'], multiSelect: true },
  ]
  const two: RelayQuestionCall['questions'] = [
    { id: 'q1', question: '第一题', header: '', options: ['甲', '乙'], multiSelect: false },
    { id: 'q2', question: '第二题', header: '', options: ['丙', '丁'], multiSelect: false },
  ]

  it('maps pure option selections (numbers/letters, multi, whitespace variants)', () => {
    expect(parseQuestionAnswer('1', one)).toEqual([{ id: 'q1', selected: ['方案A'] }])
    expect(parseQuestionAnswer('2', one)).toEqual([{ id: 'q1', selected: ['方案B'] }])
    expect(parseQuestionAnswer('a', one)).toEqual([{ id: 'q1', selected: ['方案A'] }])
    expect(parseQuestionAnswer('A', one)).toEqual([{ id: 'q1', selected: ['方案A'] }])
    expect(parseQuestionAnswer('1,3', one)).toEqual([{ id: 'q1', selected: ['方案A', '方案C'] }])
    expect(parseQuestionAnswer('a、c', one)).toEqual([{ id: 'q1', selected: ['方案A', '方案C'] }])
    expect(parseQuestionAnswer(' 1 , 3 ', one)).toEqual([{ id: 'q1', selected: ['方案A', '方案C'] }])
    expect(parseQuestionAnswer('1,1', one)).toEqual([{ id: 'q1', selected: ['方案A'] }])
  })

  it('falls through for non-answer text and out-of-range selections', () => {
    expect(parseQuestionAnswer('你好', one)).toBeUndefined()
    expect(parseQuestionAnswer('4', one)).toBeUndefined()
    expect(parseQuestionAnswer('0', one)).toBeUndefined()
    expect(parseQuestionAnswer('d', one)).toBeUndefined()
    expect(parseQuestionAnswer('第1个和第3个', one)).toBeUndefined()
    expect(parseQuestionAnswer('', one)).toBeUndefined()
    expect(parseQuestionAnswer('1', [])).toBeUndefined()
  })

  it('falls through on multi-question batches (pure selection is ambiguous)', () => {
    expect(parseQuestionAnswer('1', two)).toBeUndefined()
    // …but skip and the free-form prefix still map per question.
    expect(parseQuestionAnswer('跳过', two)).toEqual([
      { id: 'q1', selected: [] },
      { id: 'q2', selected: [] },
    ])
    expect(parseQuestionAnswer('answer: 都行', two)).toEqual([
      { id: 'q1', selected: [], custom: '都行' },
      { id: 'q2', selected: [], custom: '都行' },
    ])
  })

  it('maps the explicit skip and the 答:/answer: free-form prefix', () => {
    expect(parseQuestionAnswer('跳过', one)).toEqual([{ id: 'q1', selected: [] }])
    expect(parseQuestionAnswer('SKIP', one)).toEqual([{ id: 'q1', selected: [] }])
    expect(parseQuestionAnswer('skip', one)).toEqual([{ id: 'q1', selected: [] }])
    expect(parseQuestionAnswer('答:我觉得方案A更好', one)).toEqual([{ id: 'q1', selected: [], custom: '我觉得方案A更好' }])
    expect(parseQuestionAnswer('答：用方案B', one)).toEqual([{ id: 'q1', selected: [], custom: '用方案B' }])
    expect(parseQuestionAnswer('Answer: go with A', one)).toEqual([{ id: 'q1', selected: [], custom: 'go with A' }])
    expect(parseQuestionAnswer('答:', one)).toBeUndefined()
    // A prefix that is part of a sentence is NOT an answer.
    expect(parseQuestionAnswer('答案在下面', one)).toBeUndefined()
  })
})

describe('T2-B1/B3 bridge integration (tool registration + answer interception)', () => {
  const questionBlock = (messageId: string) => ({
    turn: 1, step: 2, message: { role: 'assistant', id: messageId, content: [
      { type: 'tool-call', id: 'c2', name: 'ask_user_question', arguments: JSON.stringify({ questions: [
        { id: 'q1', question: '选哪个方案？', options: [{ label: '方案A' }, { label: '方案B' }], multi_select: true },
      ] }) },
    ] },
  })

  it('registers ask_user_question into the agent scope (installChannelScope)', async () => {
    // makeHarness's captured.channelTools observes the agent-scope registrations.
    const h = await makeHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.channelTools).toContain('ask_user_question')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('intercepts a pure option reply, settles it via userQuestions, receipts, and does not dispatch', async () => {
    const answer = vi.fn(async () => true)
    const h = await makeCmdHarness({ userQuestions: { askTimed: async () => ({ pending: true, callId: 'c2' }), answer } })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', questionBlock('relay-q-2')))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('回复编号或字母选择'))).toBe(true))

    h.sendText('1,2')
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('已提交回答'))).toBe(true))
    expect(answer).toHaveBeenCalledTimes(1)
    const [agentArg, callId, payload] = answer.mock.calls[0] as [unknown, string, { answers: unknown }]
    expect(callId).toBe('c2')
    expect(payload).toEqual({ answers: [{ id: 'q1', selected: ['方案A', '方案B'] }] })
    // The live root agent (the chat's agent), not a wrapper.
    expect((agentArg as { session: { id: string } }).session.id).toBe(h.sessionIds[0])
    // The answer was consumed — no followup dispatch, no queue notice.
    expect(h.captured.followups).toHaveLength(1)
    // Settled → later plain text flows into the conversation normally.
    h.sendText('随便聊聊')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(answer).toHaveBeenCalledTimes(1)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('intercepts 跳过 as an all-skipped batch and 答:… as the custom answer', async () => {
    const answer = vi.fn(async () => true)
    const h = await makeCmdHarness({ userQuestions: { askTimed: async () => ({ pending: true, callId: 'c2' }), answer } })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', questionBlock('relay-q-3')))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('回复编号或字母选择'))).toBe(true))

    h.sendText('答:就用方案A')
    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledTimes(1)
      expect((answer.mock.calls[0] as unknown[])[2]).toEqual({ answers: [{ id: 'q1', selected: [], custom: '就用方案A' }] })
    })

    // The bridge re-arms on a NEW question relay (the model asked again).
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', questionBlock('relay-q-4')))
    await new Promise(resolve => setTimeout(resolve, 50))
    h.sendText('跳过')
    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledTimes(2)
      expect((answer.mock.calls[1] as unknown[])[2]).toEqual({ answers: [{ id: 'q1', selected: [] }] })
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('falls through when the settle fails (throw / false) and lets the user/message settle event clear the batch', async () => {
    const answer = vi.fn(async () => true)
    const h = await makeCmdHarness({ userQuestions: { askTimed: async () => ({ pending: true, callId: 'c2' }), answer } })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', questionBlock('relay-q-5')))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('回复编号或字母选择'))).toBe(true))

    // REPLY_QUEUED-style false → not consumed, message dispatched normally.
    answer.mockImplementationOnce(async () => false)
    h.sendText('1')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(sentTexts(h.outbound).some(t => t.includes(ANSWER_ACCEPTED_NOTICE))).toBe(false)

    // The batch stays active (the failed attempt is still outstanding) — a
    // user-question-reply settle event (web-side answer / retry) clears it.
    h.ctx.emit('session/event', session as never, makeEvent('user/message', {
      role: 'user', id: 'u-settle', content: [], source: { kind: 'user-question-reply', callId: 'c2' },
    }))
    await new Promise(resolve => setTimeout(resolve, 50))
    h.sendText('1')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))
    expect(answer).toHaveBeenCalledTimes(1)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('never intercepts when no question batch is outstanding', async () => {
    const answer = vi.fn(async () => true)
    const h = await makeCmdHarness({ userQuestions: { askTimed: async () => ({ pending: true, callId: 'c2' }), answer } })
    h.sendText('1')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(answer).not.toHaveBeenCalled()

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('T3-board foreground instant settle (user-questions/request waterfall)', () => {
  // Fake-host replica of the timed ask dispatch, mirroring the verified
  // dsh-user-questions semantics: askTimed wraps the request with
  // { signal: wait.signal, wait: { callId, timed: true } } and dispatches
  // 'user-questions/request' as a waterfall whose innermost next() is the
  // NO_PROVIDER noAnswerer; NO_PROVIDER → the wait deadline maps the
  // rejection to { pending: true, callId }. attachWait yields exactly one
  // { remainingMs } frame while the wait is live (a claim that suppresses
  // the host deadline timer) and resolves its second next() when the wait
  // closes.
  function makeForegroundHost(opts?: { attachMode?: 'hold' | 'zero' | 'throw'; fallbackTimeoutMs?: number; holdRemainingMs?: number; /** T1-board: park the attach before its first frame (the registration window). */ attachGate?: Promise<void> }) {
    const NO_PROVIDER = Object.assign(new Error('no user-questions answerer accepted the request'), { code: 'NO_PROVIDER' })
    const ASK_TIMED_OUT = Object.assign(new Error('ask_user_question timed out before the user answered'), { code: 'ASK_TIMED_OUT' })
    type Listener = (request: unknown, next: () => Promise<unknown>) => Promise<unknown>
    let listener: Listener | undefined
    const waits = new Map<string, AbortController>()
    const claims: AbortSignal[] = []
    const attachWait = vi.fn(async function * (_agent: unknown, callId: string, signal: AbortSignal) {
      if (opts?.attachMode === 'throw') throw new Error('attach refused')
      if (opts?.attachMode === 'zero') return
      if (opts?.attachGate !== undefined) await opts.attachGate
      claims.push(signal)
      const wait = waits.get(callId)
      yield { remainingMs: opts?.holdRemainingMs ?? 5_000 }
      // Second next(): resolves when the host wait closes (askTimed finally).
      if (wait === undefined) return
      await new Promise<void>(resolve => {
        if (wait.signal.aborted) resolve()
        else wait.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    })
    const answer = vi.fn(async () => false)
    const askTimedImpl = async (request: { questions?: unknown; agent?: unknown; signal?: AbortSignal }, callId: string, _timeoutMs: number) => {
      const wait = new AbortController()
      waits.set(callId, wait)
      const noAnswerer = () => Promise.reject(NO_PROVIDER)
      try {
        const result = await listener?.({ ...request, signal: wait.signal, wait: { callId, timed: true } }, noAnswerer)
        if (result !== undefined) return result
        throw NO_PROVIDER
      } catch (error) {
        if ((error as { code?: string }).code === 'NO_PROVIDER') {
          // Host parity: await wait.done → the deadline closes it.
          await new Promise(resolve => setTimeout(resolve, opts?.fallbackTimeoutMs ?? 40))
          throw ASK_TIMED_OUT
        }
        throw error
      } finally {
        wait.abort()
        waits.delete(callId)
      }
    }
    // Host parity: the askTimed catch maps ASK_TIMED_OUT to the pending payload.
    const askTimed = vi.fn(async (request: { questions?: unknown; agent?: unknown; signal?: AbortSignal }, callId: string, timeoutMs: number) => {
      try {
        return await askTimedImpl(request, callId, timeoutMs)
      } catch (error) {
        if ((error as { code?: string }).code === 'ASK_TIMED_OUT') return { pending: true, callId }
        throw error
      }
    })
    return {
      service: { askTimed, answer, attachWait },
      claims,
      setListener: (next: Listener) => { listener = next },
    }
  }

  const fgQuestionBlock = (messageId: string) => ({
    turn: 1, step: 2, message: { role: 'assistant', id: messageId, content: [
      { type: 'tool-call', id: 'c2', name: 'ask_user_question', arguments: JSON.stringify({ questions: [
        { id: 'q1', question: '选哪个方案？', options: [{ label: '方案A' }, { label: '方案B' }], multi_select: true },
      ] }) },
    ] },
  })

  /** Boot + relay the ask card + wire the fake host to the bridge listener. */
  async function bootForegroundRelay(host: ReturnType<typeof makeForegroundHost>) {
    const h = await makeCmdHarness({ userQuestions: host.service })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const relay = h.captured.agentListeners.find(l => l.event === 'user-questions/request')
    expect(relay).toBeDefined()
    host.setListener(relay!.listener)
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', fgQuestionBlock('relay-fg')))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('回复编号或字母选择'))).toBe(true))
    return { h, session }
  }

  it('settles the ask tool instantly from a QQ reply while the foreground wait is live', async () => {
    const host = makeForegroundHost()
    const { h } = await bootForegroundRelay(host)
    const ask = host.service.askTimed(
      { questions: [{ id: 'q1', question: '选哪个方案？', options: [] }], agent: { session: { id: h.sessionIds[0] } } },
      'c2', 300_000,
    )
    // The bridge took the host wait claim (hold = deadline suppression).
    await vi.waitFor(() => expect(host.service.attachWait).toHaveBeenCalledTimes(1))
    h.sendText('1,2')
    await expect(ask).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案A', '方案B'] }] })
    // Settled on the waterfall — the pending answer() path stayed idle.
    expect(host.service.answer).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes(ANSWER_ACCEPTED_NOTICE))).toBe(true))

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it.each(['zero', 'throw'] as const)('still settles instantly with a degraded attach (%s) — fail-open holds the race without a claim', async (mode) => {
    const host = makeForegroundHost({ attachMode: mode })
    const { h } = await bootForegroundRelay(host)
    const ask = host.service.askTimed(
      { questions: [{ id: 'q1', question: '选哪个方案？', options: [] }], agent: { session: { id: h.sessionIds[0] } } },
      'c2', 300_000,
    )
    await vi.waitFor(() => expect(host.service.attachWait).toHaveBeenCalledTimes(1))
    // No claim is held, but the QQ answer still settles the tool inside its
    // wait window (the host 300s timer remains the only deadline).
    h.sendText('1')
    await expect(ask).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案A'] }] })
    expect(host.service.answer).not.toHaveBeenCalled()

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('releases the claim on the hold deadline → pending, and later replies go through answer()', async () => {
    const host = makeForegroundHost({ holdRemainingMs: 80, fallbackTimeoutMs: 20 })
    const { h } = await bootForegroundRelay(host)
    const ask = host.service.askTimed(
      { questions: [{ id: 'q1', question: '选哪个方案？', options: [] }], agent: { session: { id: h.sessionIds[0] } } },
      'c2', 300_000,
    )
    await vi.waitFor(() => expect(host.service.attachWait).toHaveBeenCalledTimes(1))
    await expect(ask).resolves.toEqual({ pending: true, callId: 'c2' })
    // The claim was released when the hold deadline fired.
    expect(host.claims[0]!.aborted).toBe(true)
    // The wait is gone → a later QQ reply takes the pending answer() path.
    h.sendText('1')
    await vi.waitFor(() => expect(host.service.answer).toHaveBeenCalledTimes(1))

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('bridge stop releases every claim — no wait outlives the plugin unload', async () => {
    const host = makeForegroundHost({ holdRemainingMs: 30_000 })
    const { h } = await bootForegroundRelay(host)
    const ask = host.service.askTimed(
      { questions: [{ id: 'q1', question: '选哪个方案？', options: [] }], agent: { session: { id: h.sessionIds[0] } } },
      'c2', 300_000,
    )
    await vi.waitFor(() => expect(host.service.attachWait).toHaveBeenCalledTimes(1))
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
    // Unload resolved the wait → the listener fell through → pending.
    await expect(ask).resolves.toEqual({ pending: true, callId: 'c2' })
    expect(host.claims[0]!.aborted).toBe(true)
  })

  // T1-board discriminator: a QQ reply landing INSIDE the attach window.
  // The pre-fix order (await attach → Map.set) had no entry registered while
  // the attach was in flight, so deliverForegroundAnswer missed it and the
  // reply degraded to the answer()/followup path (notice never sent, ask
  // → pending). The fixed order registers the wait synchronously before the
  // await, so the in-window reply settles instantly. Mutation check: restore
  // the set-after-await order → the ANSWER_ACCEPTED_NOTICE waitFor fails.
  it('settles a QQ reply that lands inside the attach window (registration precedes the attach await)', async () => {
    let releaseAttach!: () => void
    const attachGate = new Promise<void>(resolve => { releaseAttach = resolve })
    const host = makeForegroundHost({ attachGate })
    const { h } = await bootForegroundRelay(host)
    const ask = host.service.askTimed(
      { questions: [{ id: 'q1', question: '选哪个方案？', options: [] }], agent: { session: { id: h.sessionIds[0] } } },
      'c2', 300_000,
    )
    // The listener is parked inside the attach await — the old set-after-
    // await order leaves the wait unregistered exactly here.
    await vi.waitFor(() => expect(host.service.attachWait).toHaveBeenCalledTimes(1))
    h.sendText('1,2')
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes(ANSWER_ACCEPTED_NOTICE))).toBe(true))
    releaseAttach()
    await expect(ask).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案A', '方案B'] }] })
    // Settled on the waterfall — the pending answer() path stayed idle.
    expect(host.service.answer).not.toHaveBeenCalled()

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  // T2-board discriminator: a foreground wait that registers WHILE the
  // registry is unloading. stop() order = registry.stop (per-chat abandon
  // pass, then dispose) → deferred.stopAll → the release loop. A waterfall
  // request landing between the abandon pass and chats.clear() is invisible
  // to the abandon pass — only the stop() release loop drains it. Mutation
  // check: remove the release loop (bridge.ts stop()) → the ask never
  // resolves and the claim never aborts → this test times out.
  it('stop() drains a foreground wait that registers during the registry teardown', async () => {
    const host = makeForegroundHost({ holdRemainingMs: 30_000 })
    const { h } = await bootForegroundRelay(host)
    // Park stop() inside the chat dispose: onChatRemoved (the abandon pass)
    // has already run for this chat, but registry.stop has not finished.
    let disposeEntered = false
    let releaseDispose!: () => void
    const disposeGate = new Promise<void>(resolve => { releaseDispose = resolve })
    const chat = h.chats().get('private:10001') as unknown as { dispose: () => Promise<void> }
    chat.dispose = async () => { disposeEntered = true; await disposeGate }
    const stop = h.bridge.stop()
    await vi.waitFor(() => expect(disposeEntered).toBe(true))
    // The ask races the unload: the chat is still indexed (chats.clear()
    // runs after the loop), so chatIdForAgent resolves it and the listener
    // registers a wait the abandon pass will never revisit.
    const ask = host.service.askTimed(
      { questions: [{ id: 'q1', question: '选哪个方案？', options: [] }], agent: { session: { id: h.sessionIds[0] } } },
      'c3', 300_000,
    )
    await vi.waitFor(() => expect(host.service.attachWait).toHaveBeenCalledTimes(1))
    releaseDispose()
    await stop
    // stop() drained the late wait → the listener fell through → pending,
    // and the claim did not outlive the unload.
    await expect(ask).resolves.toEqual({ pending: true, callId: 'c3' })
    expect(host.claims[0]!.aborted).toBe(true)

    h.client.close()
    await h.connection.stop()
  })
})
