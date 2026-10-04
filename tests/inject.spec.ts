/**
 * W1/T5 injection channel tests: config defaults (injectEnabled false /
 * injectDryRun true), zero behavior when disabled (queue file ignored),
 * dry-run interception of ALL outbound writes of an injected round including
 * the asynchronous agent reply (zero send frames on the real socket, original
 * text in the trace stream), historical-line skip at startup, dry-run=false
 * real-send escape hatch, the interval floor, and recorder bypass for
 * injected frames.
 * @module dsh-onebot/tests/inject
 */
import { existsSync, mkdtempSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { Config } from '../src/index.js'
import { InjectChannel, INJECT_FILE, INTERCEPTED_MESSAGE_ID, MIN_INJECT_INTERVAL_MS } from '../src/inject.js'
import { InboundRecorder, INBOX_FILE } from '../src/record.js'
import { TraceSink } from '../src/trace.js'
import type { TraceEvent } from '../src/trace.js'

import { makeHarness, makeEvent } from './helpers/bridge-harness.js'

const CJK = /[\u4e00-\u9fff]/

const writeInjectLine = (dir: string, line: unknown): void => {
  appendFileSync(join(dir, INJECT_FILE), JSON.stringify(line) + '\n', 'utf8')
}

const readTraceLines = (dir: string): TraceEvent[] => {
  const file = join(dir, 'qq-trace.jsonl')
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8').trim()
  return text === '' ? [] : text.split('\n').map(line => JSON.parse(line) as TraceEvent)
}

describe('inject config defaults (schema)', () => {
  it('injectEnabled defaults false, injectDryRun defaults true, interval defaults 2000', () => {
    const config = Config({ mediaDir: join(tmpdir(), 'onebot-inject-defaults') } as never)
    expect(config.injectEnabled).toBe(false)
    expect(config.injectDryRun).toBe(true)
    expect(config.injectIntervalMs).toBe(2000)
    expect(config.recordInbound).toBe(false)
    expect(config.inboxRedact).toBe(false)
  })

  it('the poll interval floor is 500ms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-inject-'))
    const channel = new InjectChannel({ dir, dryRun: true, intervalMs: 10, handleEvent: async () => undefined, log: () => undefined })
    expect(channel.intervalMs).toBe(MIN_INJECT_INTERVAL_MS)
    expect(channel.intercepting).toBe(true)
  })
})

describe('inject disabled (zero behavior)', () => {
  it('a pre-existing queue file is never read when no channel is wired', async () => {
    const h = await makeHarness()
    writeInjectLine(h.mediaDir, {
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002, message_id: 9001,
      message: [{ type: 'text', data: { text: '注入消息' } }], raw_message: '注入消息',
      sender: { user_id: 10001, nickname: '小明' },
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(h.captured.followups).toHaveLength(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('a wired-but-not-started channel never polls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-inject-'))
    const h = await makeHarness({
      mediaDir: dir,
      inject: new InjectChannel({ dir, dryRun: true, intervalMs: 50, handleEvent: async () => undefined, log: () => undefined }),
    })
    writeInjectLine(dir, { post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002, message: [{ type: 'text', data: { text: 'x' } }] })
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(h.captured.followups).toHaveLength(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)
})

describe('inject dry-run interception', () => {
  it('feeds the queue through the real pipeline and intercepts every outbound write including the async agent reply', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-inject-'))
    const sink = new TraceSink({ dir, log: () => undefined })
    const channel = new InjectChannel({
      dir, dryRun: true, intervalMs: 50,
      handleEvent: event => h.bridge.handleInbound(event, { injected: true }),
      trace: sink,
      log: () => undefined,
    })
    const h = await makeHarness({ mediaDir: dir, trace: sink, inject: channel })
    channel.start()
    writeInjectLine(h.mediaDir, {
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002, message_id: 9001,
      message: [{ type: 'text', data: { text: '注入消息' } }], raw_message: '注入消息',
      sender: { user_id: 10001, nickname: '小明' },
    })
    // The injected event goes through the REAL pipeline (trace minted, turn
    // dispatched) — but through the inject channel, not the socket.
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1), { timeout: 15_000 })
    expect(h.captured.followups[0]!.text).toContain('注入消息')
    // Drive the agent round: the final reply after turn/end must ALSO be
    // intercepted (v0.4.0 阶段 3 lesson — the async reply would otherwise reach QQ).
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('turn/start', { turn: 1 }))
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '注入回合的最终回复' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => expect(channel.getStats().intercepted).toBeGreaterThanOrEqual(2), { timeout: 15_000 })
    // Zero outbound frames on the real socket: nothing was ever sent to QQ.
    const sendFrames = h.outbound.filter(f => String(f.action).startsWith('send_'))
    expect(sendFrames).toHaveLength(0)
    await sink.flush()
    const lines = readTraceLines(dir)
    const injectEvents = lines.filter(e => e.stage === 'inject')
    expect(injectEvents.some(e => e.reason === '注入事件已进入真实管线')).toBe(true)
    const intercepted = injectEvents.filter(e => e.reason.includes('出站调用已拦截'))
    expect(intercepted.length).toBeGreaterThanOrEqual(2)
    for (const event of intercepted) {
      expect(event.reason).toMatch(CJK)
    }
    // The final reply's original text rode the trace event.
    expect(intercepted.some(e => (e.data as { text?: string }).text === '注入回合的最终回复')).toBe(true)
    expect(intercepted.some(e => (e.data as { text?: string }).text === '注入消息' || e.reason.includes('send_'))).toBe(true)
    await channel.stop()
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('skips historical lines at startup and reports the count (trace + log)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-inject-'))
    const sink = new TraceSink({ dir, log: () => undefined })
    // History written BEFORE the channel starts.
    writeInjectLine(dir, {
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002, message_id: 8001,
      message: [{ type: 'text', data: { text: '历史行' } }], raw_message: '历史行',
      sender: { user_id: 10001, nickname: '小明' },
    })
    const h = await makeHarness({ mediaDir: dir, trace: sink })
    const logs: string[] = []
    const channel = new InjectChannel({
      dir, dryRun: true, intervalMs: 50,
      handleEvent: event => h.bridge.handleInbound(event, { injected: true }),
      trace: sink,
      log: (_level, message) => logs.push(message),
    })
    channel.start()
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(channel.getStats().skippedHistory).toBe(1)
    expect(channel.getStats().consumed).toBe(0)
    expect(h.captured.followups).toHaveLength(0)
    expect(logs.some(l => l.includes('已跳过历史行 1 条'))).toBe(true)
    await sink.flush()
    expect(readTraceLines(dir).some(e => e.stage === 'inject' && e.reason.includes('已跳过历史行'))).toBe(true)
    // A line appended AFTER startup is consumed normally.
    writeInjectLine(h.mediaDir, {
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002, message_id: 8002,
      message: [{ type: 'text', data: { text: '新行' } }], raw_message: '新行',
      sender: { user_id: 10001, nickname: '小明' },
    })
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1), { timeout: 15_000 })
    expect(channel.getStats().consumed).toBe(1)
    await channel.stop()
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('dry-run=false lets injected rounds really send (documented escape hatch)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-inject-'))
    const channel = new InjectChannel({
      dir, dryRun: false, intervalMs: 50,
      handleEvent: event => h.bridge.handleInbound(event, { injected: true }),
      log: () => undefined,
    })
    const h = await makeHarness({ mediaDir: dir, inject: channel })
    channel.start()
    writeInjectLine(h.mediaDir, {
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002, message_id: 9002,
      message: [{ type: 'text', data: { text: '真发消息' } }], raw_message: '真发消息',
      sender: { user_id: 10001, nickname: '小明' },
    })
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1), { timeout: 15_000 })
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '真发回复' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('真发回复'))).toBe(true)
    }, { timeout: 15_000 })
    expect(channel.getStats().intercepted).toBe(0)
    await channel.stop()
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('a real message dispatched to the same chat clears the injected round (no collateral interception)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-inject-'))
    const channel = new InjectChannel({
      dir, dryRun: true, intervalMs: 50,
      handleEvent: event => h.bridge.handleInbound(event, { injected: true }),
      log: () => undefined,
    })
    const h = await makeHarness({ mediaDir: dir, inject: channel })
    channel.start()
    // ① Injected round dispatches.
    writeInjectLine(h.mediaDir, {
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002, message_id: 9003,
      message: [{ type: 'text', data: { text: '注入先行' } }], raw_message: '注入先行',
      sender: { user_id: 10001, nickname: '小明' },
    })
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1), { timeout: 15_000 })
    // ② A REAL message arrives through the socket for the same chat → the
    // injected round association must be cleared.
    h.sendText('真人消息')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2), { timeout: 15_000 })
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '真人回复' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('真人回复'))).toBe(true)
    }, { timeout: 15_000 })
    await channel.stop()
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('injected frames are never recorded (no inject→record→replay loop)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-inject-'))
    const recorder = new InboundRecorder({ dir })
    const channel = new InjectChannel({
      dir, dryRun: true, intervalMs: 50,
      handleEvent: event => h.bridge.handleInbound(event, { injected: true }),
      log: () => undefined,
    })
    const h = await makeHarness({ mediaDir: dir, recorder, inject: channel })
    channel.start()
    writeInjectLine(h.mediaDir, {
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002, message_id: 9004,
      message: [{ type: 'text', data: { text: '不该被录制' } }], raw_message: '不该被录制',
      sender: { user_id: 10001, nickname: '小明' },
    })
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1), { timeout: 15_000 })
    await new Promise(resolve => setTimeout(resolve, 150))
    await recorder.flush()
    expect(existsSync(join(dir, INBOX_FILE))).toBe(false)
    await channel.stop()
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('bad queue lines degrade to a rate-limited warn and are counted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-inject-'))
    // The queue path is a REGULAR FILE → read fails (not ENOENT).
    writeFileSync(join(dir, INJECT_FILE), 'not json\n')
    const warns: string[] = []
    const channel = new InjectChannel({ dir, dryRun: true, intervalMs: 50, handleEvent: async () => undefined, log: (_l, m) => warns.push(m) })
    // Bad line → parse error warn; a read failure (not ENOENT) → warn.
    await (channel as unknown as { tick(): Promise<void> }).tick()
    expect(channel.getStats().parseErrors).toBe(1)
    expect(warns.some(w => w.includes('注入行解析失败'))).toBe(true)
    await channel.stop()
  })

  it('intercepted sends carry the marker message id so their recalls are intercepted too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-inject-'))
    const channel = new InjectChannel({ dir, dryRun: true, intervalMs: 50, handleEvent: async () => undefined, log: () => undefined })
    const round = { traceId: 't-x', intercepted: 0 }
    const result = await channel.intercept(round, 'send_msg', { message: [{ type: 'text', data: { text: '原文' } }] }) as { data: { message_id: number } }
    expect(result.data.message_id).toBe(INTERCEPTED_MESSAGE_ID)
    expect(round.intercepted).toBe(1)
    await channel.stop()
  })
})
