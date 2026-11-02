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
