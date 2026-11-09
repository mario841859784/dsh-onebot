import { describe, expect, it, vi } from 'vitest'
import type { OneBotEvent } from '../src/connection.js'
import type { OneBotSegment } from '../src/cq.js'
import { InboundPipeline, normalizeOneBot11 } from '../src/inbound.js'
import type { InboundChat, InboundContext, QuotedMessageData } from '../src/inbound.js'
import { runWithTrace, TRACE_REASONS } from '../src/trace.js'
import type { TraceScope } from '../src/trace.js'

const BOT = '10002'
const OTHER = '10003'
const reply: OneBotSegment = { type: 'reply', data: { id: '123' } }
const body: OneBotSegment = { type: 'text', data: { text: 'reply body' } }
const atBot: OneBotSegment = { type: 'at', data: { qq: BOT } }
const atOther: OneBotSegment = { type: 'at', data: { qq: OTHER } }

interface HarnessOptions {
  author?: string | number
  response?: unknown
  error?: string
  selfId?: string
  busy?: boolean
  command?: boolean
  config?: Partial<InboundContext['config']>
  policy?: Partial<InboundContext['policy']>
  replyMessageId?: number
}

/** Build an isolated pipeline with in-memory API, command and dispatch stubs. */
function makeHarness(options: HarnessOptions = {}) {
  const response = Object.hasOwn(options, 'response') ? options.response : {
    sender: { user_id: options.author ?? OTHER, nickname: 'original author' },
    message: [{ type: 'text', data: { text: 'original &amp; text' } }],
  }
  const call = vi.fn(async (action: string, params: Record<string, unknown>) => {
    // No real OneBot server or outbound write action is reachable from this stub.
    expect(action).toBe('get_msg')
    expect(params).toEqual({ message_id: options.replyMessageId ?? 123 })
    if (options.error) throw new Error(options.error)
    return response
  })
  const chat: InboundChat = {
    loopBuffer: [{ id: 'old', text: 'previous cycle', sentAt: 0 }],
    loopPending: 'old', dispatchTimes: [], rateLimitNoticeAt: undefined,
  }
  const sweepIdleChats = vi.fn(async () => undefined)
  const tryHandleCommand = vi.fn(async () => options.command === true)
  const buildBody = vi.fn(async (text: string) => text)
  const interceptBusyTurn = vi.fn(async (_id: string, _text: string, _role: string, _nickname: string | undefined, _plain: boolean) => options.busy === true)
  const dispatchFollowup = vi.fn(async (_id: string, _text: string) => undefined)
  const cleanupExpired = vi.fn(async () => undefined)
  const emit = vi.fn<TraceScope['emit']>()
  const trace: TraceScope = { traceId: 't-reply', chatId: 'group:888', messageId: '456', emit }
  let pipeline: InboundPipeline
  const expandQuote = vi.fn((id: string, verified?: QuotedMessageData) => pipeline.expandQuote(id, verified))
  pipeline = new InboundPipeline({
    call,
    selfId: () => options.selfId ?? BOT,
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: [OTHER], allowAllUsers: false, requireMention: true, ...options.policy,
    },
    getChat: () => chat,
    getSettings: () => ({}) as never,
    sweepIdleChats,
    media: { cleanupExpired } as never,
    transcriber: { enabled: false } as never,
    steerTranscript: () => undefined,
    tryHandleCommand, buildBody, expandQuote, interceptBusyTurn, dispatchFollowup,
    sendToChat: async () => { throw new Error('real outbound messages are forbidden in this test') },
    log: vi.fn(),
    config: {
      botQQ: BOT, ignoreSelf: true, requireMention: true, rateLimitPerMinute: 0,
      restrictedMemberPrefix: false, maxInboundFileBytes: 0, ...options.config,
    },
  })
  return { pipeline, response, call, chat, sweepIdleChats, tryHandleCommand, buildBody,
    expandQuote, interceptBusyTurn, dispatchFollowup, cleanupExpired, trace, emit }
}

/** Normalize a fake array/CQ event; raw_message mirrors string payloads. */
function inbound(message: OneBotSegment[] | string, overrides: Partial<OneBotEvent> = {}) {
  return normalizeOneBot11({
    post_type: 'message', message_type: 'group', user_id: Number(OTHER), group_id: 888,
    self_id: Number(BOT), message_id: 456, sender: { user_id: Number(OTHER), nickname: 'sender' },
    message, raw_message: typeof message === 'string' ? message : '', ...overrides,
  })!
}

describe('reply-only group mention verification', () => {
  const blocked: Array<{ name: string; message: OneBotSegment[] | string; options?: HarnessOptions; reason?: string }> = [
    { name: 'reply id without an @', message: [reply, body] },
    { name: 'reply id plus @another member', message: [reply, atOther, body] },
    { name: 'reply.qq claims bot but get_msg names another author', message: [{ type: 'reply', data: { id: '123', qq: BOT } }, body] },
    { name: 'CQ reply id without an @', message: '[CQ:reply,id=123] body' },
    { name: 'CQ reply id plus @another member', message: `[CQ:reply,id=123][CQ:at,qq=${OTHER}] body` },
    { name: '@bot inside the quoted original only', message: [reply, body], options: { response: { sender: { user_id: OTHER }, message: [atBot, body] } } },
    { name: 'deleted or unknown message', message: [reply, body], options: { error: 'message not found' }, reason: TRACE_REASONS.inboundReplyLookupFailed },
    { name: 'lookup timeout', message: [reply, body], options: { error: 'OneBot call timed out' }, reason: TRACE_REASONS.inboundReplyLookupFailed },
    { name: 'missing sender id', message: [reply, body], options: { response: { message: [body] } }, reason: TRACE_REASONS.inboundReplyAuthorUnknown },
    { name: 'null lookup response', message: [reply, body], options: { response: null }, reason: TRACE_REASONS.inboundReplyLookupFailed },
  ]

  for (const item of blocked) {
    it('blocks ' + item.name + ' before command/media/busy-turn side effects', async () => {
      const h = makeHarness(item.options)
      await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound(item.message)))
      expect(h.call).toHaveBeenCalledTimes(1)
      expectBlocked(h)
      expect(h.emit).toHaveBeenCalledExactlyOnceWith('mention', {
        ok: false, reason: item.reason ?? TRACE_REASONS.inboundReplyOtherAuthor,
      })
    })
  }

  const allowed: Array<{ name: string; message: OneBotSegment[] | string; options?: HarnessOptions }> = [
    { name: 'string author id', message: [reply, body] },
    { name: 'numeric author id', message: [reply, body], options: { author: Number(BOT) } },
    { name: 'reply to bot plus @another member', message: [reply, atOther, body] },
    { name: 'get_msg overrides an incorrect reply.qq', message: [{ type: 'reply', data: { id: '123', qq: OTHER } }, body] },
    { name: 'CQ reply to bot', message: '[CQ:reply,id=123] body' },
    { name: 'configured botQQ when learned selfId is absent', message: [reply, body], options: { selfId: '' } },
  ]

  for (const item of allowed) {
    it('allows verified ' + item.name + ' and reuses the lookup through the quote seam', async () => {
      const h = makeHarness({ author: BOT, ...item.options })
      await h.pipeline.processInbound(inbound(item.message))
      expect(h.call).toHaveBeenCalledTimes(1)
      expect(h.expandQuote).toHaveBeenCalledExactlyOnceWith('123', h.response)
      expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
      const text = h.dispatchFollowup.mock.calls[0][1]
      expect(text).toContain('[@我]')
      expect(text).toContain('[引用]original author: original & text')
      expect(h.interceptBusyTurn).toHaveBeenCalledWith('group:888', expect.any(String), 'admin', 'sender', false)
    })
  }

  it('does not query when bot identity is completely unknown', async () => {
    const h = makeHarness({ selfId: '', config: { botQQ: '' } })
    await h.pipeline.processInbound(inbound([reply, body]))
    expect(h.call).not.toHaveBeenCalled()
    expect(h.dispatchFollowup).not.toHaveBeenCalled()
  })

  it('keeps the group policy gate before reply lookup', async () => {
    const h = makeHarness({ policy: { groupPolicy: 'disabled' } })
    await h.pipeline.processInbound(inbound([reply, body]))
    expect(h.call).not.toHaveBeenCalled()
  })

  it('never queues or steers a reply to another member while busy', async () => {
    const h = makeHarness({ busy: true })
    await h.pipeline.processInbound(inbound([reply, body]))
    expect(h.interceptBusyTurn).not.toHaveBeenCalled()
    expect(h.dispatchFollowup).not.toHaveBeenCalled()
  })

  it('retains busy-turn queue eligibility for a verified reply to bot', async () => {
    const h = makeHarness({ author: BOT, busy: true })
    await h.pipeline.processInbound(inbound([reply, body]))
    expect(h.interceptBusyTurn).toHaveBeenCalledWith('group:888', expect.any(String), 'admin', 'sender', false)
    expect(h.dispatchFollowup).not.toHaveBeenCalled()
  })

  it('deduplicates before the lookup and subsequent dispatch', async () => {
    const h = makeHarness({ author: BOT })
    const event = inbound([reply, body])
    await h.pipeline.processInbound(event)
    await h.pipeline.processInbound(event)
    expect(h.call).toHaveBeenCalledTimes(1)
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
  })

  it('verifies reply-only commands but skips subsequent media and quote expansion', async () => {
    const h = makeHarness({ author: BOT, command: true })
    await h.pipeline.processInbound(inbound([reply, body]))
    expect(h.call).toHaveBeenCalledTimes(1)
    expect(h.tryHandleCommand).toHaveBeenCalledTimes(1)
    expect(h.buildBody).not.toHaveBeenCalled()
    expect(h.expandQuote).not.toHaveBeenCalled()
    expect(h.dispatchFollowup).not.toHaveBeenCalled()
  })
})

describe('existing non-reply-trigger entry points', () => {
  it('does not add lookup I/O to an unmentioned ordinary group message', async () => {
    const h = makeHarness()
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([body])))
    expect(h.call).not.toHaveBeenCalled()
    expect(h.dispatchFollowup).not.toHaveBeenCalled()
    expect(h.emit).toHaveBeenCalledExactlyOnceWith('mention', { ok: false, reason: TRACE_REASONS.inboundUnmentioned })
  })

  const explicit: Array<{ message: OneBotSegment[] | string; options?: HarnessOptions }> = [
    { message: [atBot, body] },
    { message: `[CQ:at,qq=${BOT}] body` },
    // T1 (PR port): @all wakes only with the atAllCountsAsMention switch on
    // (default off — the upstream closed semantics).
    { message: [{ type: 'at', data: { qq: 'all' } }, body], options: { config: { atAllCountsAsMention: true } } },
  ]
  for (const item of explicit) {
    it('keeps explicit @ triggers independent of quote lookup', async () => {
      const h = makeHarness(item.options)
      await h.pipeline.processInbound(inbound(item.message))
      expect(h.call).not.toHaveBeenCalled()
      expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
    })
  }

  it('T1: @all does not wake with atAllCountsAsMention off (default)', async () => {
    const h = makeHarness()
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([{ type: 'at', data: { qq: 'all' } }, body])))
    expect(h.dispatchFollowup).not.toHaveBeenCalled()
    expect(h.emit).toHaveBeenCalledExactlyOnceWith('mention', { ok: false, reason: TRACE_REASONS.inboundUnmentioned })
  })

  for (const error of [undefined, 'message not found']) {
    it('allows explicit @bot with a quote to another member even if expansion fails', async () => {
      const h = makeHarness({ error })
      await h.pipeline.processInbound(inbound([reply, atBot, body]))
      expect(h.call).toHaveBeenCalledTimes(1)
      expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
    })
  }

  it('does not add lookup I/O to explicitly mentioned commands', async () => {
    const h = makeHarness({ command: true })
    await h.pipeline.processInbound(inbound([reply, atBot, body]))
    expect(h.call).not.toHaveBeenCalled()
    expect(h.dispatchFollowup).not.toHaveBeenCalled()
  })

  it('preserves private reply handling and the one-argument expandQuote entry point', async () => {
    const h = makeHarness()
    await h.pipeline.processInbound(inbound([reply, body], { message_type: 'private' }))
    expect(h.call).toHaveBeenCalledTimes(1)
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
    expect(await h.pipeline.expandQuote('123')).toContain('[引用]original author:')
    expect(h.call).toHaveBeenCalledTimes(2)
  })

  it('preserves group handling when requireMention is disabled', async () => {
    const h = makeHarness({ config: { requireMention: false } })
    await h.pipeline.processInbound(inbound([reply, body]))
    expect(h.call).toHaveBeenCalledTimes(1)
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
  })
})

/** Assert that a rejected reply never reaches any downstream state or I/O seam. */
function expectBlocked(h: ReturnType<typeof makeHarness>): void {
  expect(h.tryHandleCommand).not.toHaveBeenCalled()
  expect(h.buildBody).not.toHaveBeenCalled()
  expect(h.expandQuote).not.toHaveBeenCalled()
  expect(h.sweepIdleChats).not.toHaveBeenCalled()
  expect(h.cleanupExpired).not.toHaveBeenCalled()
  expect(h.interceptBusyTurn).not.toHaveBeenCalled()
  expect(h.dispatchFollowup).not.toHaveBeenCalled()
  expect(h.chat.loopPending).toBe('old')
  expect(h.chat.loopBuffer).toHaveLength(1)
}

describe('reply id validation', () => {
  // Exercise both wire formats; Number() alone accepts several of these inputs
  // or silently rounds them, so no get_msg request may escape for any of them.
  for (const id of ['', 'abc', '1.5', '1e3', '0x7b', ' 123 ', '123\n', 'NaN', 'Infinity', '9007199254740993', '9'.repeat(400)]) {
    for (const format of ['array', 'CQ']) {
      it(`rejects invalid ${format} reply id ${JSON.stringify(id)} without API or downstream effects`, async () => {
        const h = makeHarness({ author: BOT })
        const message = format === 'array'
          ? [{ type: 'reply', data: { id } }, body] : `[CQ:reply,id=${id}] body`
        await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound(message)))
        expect(h.call).not.toHaveBeenCalled()
        expectBlocked(h)
        expect(h.emit).toHaveBeenCalledExactlyOnceWith('mention', { ok: false, reason: TRACE_REASONS.quoteInvalidId })
      })
    }
  }

  for (const id of ['-123', '-2147483648', '9007199254740991']) {
    for (const format of ['array', 'CQ']) {
      it(`keeps valid ${format} signed/safe adapter id ${id} and reuses its single lookup`, async () => {
        const h = makeHarness({ author: BOT, replyMessageId: Number(id) })
        const message = format === 'array'
          ? [{ type: 'reply', data: { id } }, body] : `[CQ:reply,id=${id}] body`
        await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound(message)))
        expect(h.call).toHaveBeenCalledTimes(1)
        expect(h.expandQuote).toHaveBeenCalledExactlyOnceWith(id, h.response)
        expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
        expect(h.emit).not.toHaveBeenCalled()
      })
    }
  }

  const existingEntries: Array<{ name: string; message: OneBotSegment[]; overrides?: Partial<OneBotEvent>; config?: HarnessOptions['config'] }> = [
    { name: 'explicit @bot', message: [{ type: 'reply', data: { id: 'abc' } }, atBot, body] },
    { name: 'private message', message: [{ type: 'reply', data: { id: 'abc' } }, body], overrides: { message_type: 'private' } },
    { name: 'requireMention disabled', message: [{ type: 'reply', data: { id: 'abc' } }, body], config: { requireMention: false } },
  ]
  for (const id of [123, -123]) {
    it(`accepts numeric adapter reply field ${id} before checking its author`, async () => {
      const h = makeHarness({ author: BOT, replyMessageId: id })
      // Real adapters may emit number-valued segment data; preserve that wire
      // shape through normalization instead of casting it to a string fixture.
      await h.pipeline.processInbound(inbound([body], {
        message: [{ type: 'reply', data: { id } }, body],
      }))
      expect(h.call).toHaveBeenCalledTimes(1)
      expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
    })
  }
  for (const entry of existingEntries) {
    it(`omits only the invalid quote for ${entry.name}, preserving the message entry point`, async () => {
      const h = makeHarness({ config: entry.config })
      await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound(entry.message, entry.overrides)))
      expect(h.call).not.toHaveBeenCalled()
      expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
      expect(h.dispatchFollowup.mock.calls[0][1]).toContain('reply body')
      expect(h.emit).toHaveBeenCalledExactlyOnceWith('quote', { ok: false, reason: TRACE_REASONS.quoteInvalidId })
    })
  }

  it('keeps the one-argument expansion entry point but skips invalid-id queries', async () => {
    const h = makeHarness()
    expect(await runWithTrace(h.trace, () => h.pipeline.expandQuote('abc'))).toBe('')
    expect(h.call).not.toHaveBeenCalled()
    expect(h.emit).toHaveBeenCalledExactlyOnceWith('quote', { ok: false, reason: TRACE_REASONS.quoteInvalidId })
  })
})

describe('wake-name gate (T1 PR port: 唤醒词)', () => {
  const wakeText: OneBotSegment = { type: 'text', data: { text: '小雪 帮我看看这个' } }
  const midText: OneBotSegment = { type: 'text', data: { text: '帮我看看小雪这个' } }

  it('wakes a group message that starts with a member wake name (no @ needed)', async () => {
    // The default harness policy marks OTHER as the admin — demote the sender
    // to a member so the member wake list is the one consulted.
    const h = makeHarness({ config: { wakeNamesMember: ['小雪'] }, policy: { adminUsers: ['99999'] } })
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([wakeText])))
    expect(h.call).not.toHaveBeenCalled()
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
    expect(h.emit).toHaveBeenCalledExactlyOnceWith('mention', {
      ok: true,
      reason: TRACE_REASONS.inboundWakeName,
      data: { names: ['小雪'], textLen: expect.any(Number), preview: expect.any(String), role: 'member' },
    })
  })

  it('does not wake on a wake-name substring inside the message body', async () => {
    const h = makeHarness({ config: { wakeNamesMember: ['小雪'] } })
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([midText])))
    expect(h.dispatchFollowup).not.toHaveBeenCalled()
    expect(h.emit).toHaveBeenCalledExactlyOnceWith('mention', { ok: false, reason: TRACE_REASONS.inboundUnmentioned })
  })

  it('picks the tier list: admin sender uses wakeNamesAdmin, member sender does not', async () => {
    // The harness policy marks OTHER (10003) as the admin.
    const h = makeHarness({ config: { wakeNamesAdmin: ['小雪'], wakeNamesMember: ['阿蜜'] } })
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([wakeText])))
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)

    const h2 = makeHarness({ config: { wakeNamesAdmin: ['小雪'], wakeNamesMember: ['阿蜜'] } })
    await runWithTrace(h2.trace, () => h2.pipeline.processInbound(inbound([{ type: 'text', data: { text: '小雪 在吗' } }], { user_id: Number(BOT) })))
    expect(h2.dispatchFollowup).not.toHaveBeenCalled()
  })

  it('does not override an explicit @ (mentioned stays true, recheck skipped via wakeNameHit)', async () => {
    const h = makeHarness({ config: { wakeNamesMember: ['小雪'] } })
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([atBot, wakeText])))
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
    // No wake-name trace: the explicit @ path produced the mention.
    expect(h.emit).not.toHaveBeenCalled()
  })

  it('stays silent for private messages and when no wake names are configured', async () => {
    const h = makeHarness({ config: { wakeNamesMember: ['小雪'] } })
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([wakeText], { message_type: 'private' })))
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
    expect(h.emit).not.toHaveBeenCalled()

    const h2 = makeHarness()
    await runWithTrace(h2.trace, () => h2.pipeline.processInbound(inbound([wakeText])))
    expect(h2.dispatchFollowup).not.toHaveBeenCalled()
  })

  it('replyCountsAsMention: a reply to another member wakes without the author lookup', async () => {
    const h = makeHarness({ config: { replyCountsAsMention: true }, policy: { adminUsers: ['99999'] } })
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([reply, body])))
    // The skipped author verification must not emit a mention-drop trace; the
    // single get_msg below is the ordinary quote expansion, not the verify.
    expect(h.emit).not.toHaveBeenCalled()
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
  })
})
