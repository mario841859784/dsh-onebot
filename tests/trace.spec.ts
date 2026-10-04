/**
 * W1 core-observability tests (T4): traceId propagation across the inbound →
 * agent → outbound chain, jsonl field completeness + rename rotation, the
 * Chinese reason matrix, the default-off zero-difference guarantee, the
 * async write guardrails (burst without loss / without blocking), the
 * same-cause 5-minute rate limit and the traceLevel=warn filter.
 * @module dsh-onebot/tests/trace
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { newTraceId, TRACE_REASONS, TRACE_STAGES, TraceSink } from '../src/trace.js'
import type { TraceEvent } from '../src/trace.js'

import { disconnect, inboundAndDisconnect, makeEvent, makeHarness, reconnect } from './helpers/bridge-harness.js'

const CJK = /[\u4e00-\u9fff]/

/** Parse every jsonl line of one trace file (missing file → []). */
const readLines = (file: string): TraceEvent[] => {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8').trim()
  return text === '' ? [] : text.split('\n').map(line => JSON.parse(line) as TraceEvent)
}

const current = (dir: string): string => join(dir, 'qq-trace.jsonl')

describe('trace sink (src/trace.ts)', () => {
  it('mints short sortable trace ids', () => {
    const a = newTraceId(1_760_000_000_000)
    const b = newTraceId(1_760_000_000_000)
    expect(a).toMatch(/^t-[0-9a-z]+-[0-9a-z]+$/)
    expect(a).not.toBe(b)
    expect(newTraceId(1_760_000_000_001) > a).toBe(true) // sortable
  })

  it('writes complete jsonl fields and rotates by rename at the size cap, keeping old files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-trace-'))
    const sink = new TraceSink({ dir, maxBytes: 600, log: () => undefined })
    // One event with every schema field, one with an oversized reason.
    sink.emit({ traceId: 't-complete', stage: 'inbound', ok: true, chatId: 'private:10001', messageId: '5001', ms: 3.4, data: { messageType: 'private' } })
    sink.emit({ traceId: 't-long', stage: 'whitelist', ok: false, reason: '长'.repeat(400) })
    for (let i = 0; i < 40; i++) {
      sink.emit({ traceId: 't-' + i, stage: 'agent', ok: true, reason: '事件' + i })
    }
    await sink.flush()
    // Rotation triggered: the renamed-aside file exists and is valid jsonl.
    expect(existsSync(join(dir, 'qq-trace.1.jsonl'))).toBe(true)
    const rotated = readLines(join(dir, 'qq-trace.1.jsonl'))
    expect(rotated.length).toBeGreaterThan(0)
    for (const event of rotated) {
      expect(event.v).toBe(1)
      expect(typeof event.ts).toBe('number')
      expect(typeof event.traceId).toBe('string')
      expect(Object.keys(TRACE_STAGES)).toContain(event.stage)
      expect(typeof event.ok).toBe('boolean')
      if (event.ok === false) expect(event.reason?.length).toBeGreaterThan(0)
    }
    // The oversized reason was sliced to the documented cap.
    const long = [...rotated, ...readLines(current(dir))].find(event => event.traceId === 't-long')
    expect(long?.reason).toBe('长'.repeat(300))
    // The all-fields event kept them (ms rounded to integer).
    const complete = [...rotated, ...readLines(current(dir))].find(event => event.traceId === 't-complete')
    expect(complete).toMatchObject({ v: 1, stage: 'inbound', ok: true, chatId: 'private:10001', messageId: '5001', ms: 3, data: { messageType: 'private' } })
    expect(sink.getStats().rotated).toBeGreaterThan(0)
  })

  it('keeps every reason non-empty Chinese and capped', () => {
    for (const [key, reason] of Object.entries(TRACE_REASONS)) {
      expect(reason.length, key).toBeGreaterThan(0)
      expect(reason, key).toMatch(CJK)
      expect(reason.length, key).toBeLessThanOrEqual(300)
    }
  })

  it('survives a burst of 1000 events without loss and without blocking the caller, dropping oldest beyond the queue cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-trace-'))
    const sink = new TraceSink({ dir, log: () => undefined })
    const started = Date.now()
    for (let i = 0; i < 1000; i++) {
      sink.emit({ traceId: 't-burst-' + i, stage: 'agent', ok: true, reason: '压测' + i })
    }
    const syncMs = Date.now() - started
    // 1000 synchronous queue pushes: microseconds-scale, never awaited disk.
    expect(syncMs).toBeLessThan(500)
    expect(sink.getStats().dropped).toBe(0)
    await sink.flush()
    const lines = readLines(current(dir))
    expect(lines).toHaveLength(1000)
    // Beyond the cap: the oldest is dropped (counted), the pipeline unaffected.
    for (let i = 0; i < 50; i++) {
      sink.emit({ traceId: 't-over-' + i, stage: 'agent', ok: true, reason: '超压' + i })
    }
    expect(sink.getStats().dropped).toBe(0) // queue drained by the first flush
    const sink2 = new TraceSink({ dir: join(dir, 'cap'), maxQueue: 10, log: () => undefined })
    for (let i = 0; i < 25; i++) {
      sink2.emit({ traceId: 't-cap-' + i, stage: 'agent', ok: true, reason: '限队' + i })
    }
    expect(sink2.getStats().dropped).toBe(15)
    await sink2.flush()
    expect(readLines(join(dir, 'cap', 'qq-trace.jsonl'))).toHaveLength(10)
  })

  it('rate-limits the same cause (stage+reason) to one line per 5 minutes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-trace-'))
    let now = 1_760_000_000_000
    const sink = new TraceSink({ dir, now: () => now, log: () => undefined })
    const reason = TRACE_REASONS.sttEmpty
    sink.emit({ traceId: 't1', stage: 'transcribe', ok: false, reason })
    sink.emit({ traceId: 't2', stage: 'transcribe', ok: false, reason })
    sink.emit({ traceId: 't3', stage: 'transcribe', ok: false, reason })
    // A different reason is a different cause: written immediately.
    sink.emit({ traceId: 't4', stage: 'transcribe', ok: false, reason: '语音转写失败: boom' })
    expect(sink.getStats().suppressed).toBe(2)
    await sink.flush()
    expect(readLines(current(dir))).toHaveLength(2)
    // After the window the same cause is recorded again.
    now += 5 * 60_000 + 1
    sink.emit({ traceId: 't5', stage: 'transcribe', ok: false, reason })
    await sink.flush()
    const lines = readLines(current(dir))
    expect(lines).toHaveLength(3)
    expect(lines.filter(event => event.reason === reason)).toHaveLength(2)
  })

  it('traceLevel=warn records only ok:false events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-trace-'))
    const sink = new TraceSink({ dir, level: 'warn', log: () => undefined })
    sink.emit({ traceId: 't-ok', stage: 'inbound', ok: true, reason: '收到消息' })
    sink.emit({ traceId: 't-drop', stage: 'whitelist', ok: false, reason: TRACE_REASONS.inboundDmBlocked })
    await sink.flush()
    const lines = readLines(current(dir))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ traceId: 't-drop', ok: false, stage: 'whitelist' })
  })

  it('an explicitly disabled sink never creates a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-trace-'))
    const sink = new TraceSink({ dir, enabled: false })
    sink.emit({ traceId: 't1', stage: 'inbound', ok: true, reason: '收到' })
    sink.scope('t2', 'private:1').emit('dispatch', { ok: false, reason: 'x' })
    await sink.flush()
    expect(existsSync(current(dir))).toBe(false)
  })
})

describe('traceId propagation through the bridge (traceEnabled on)', () => {
  it('keeps one traceId from inbound to outbound for the whole message round', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-trace-'))
    const sink = new TraceSink({ dir, log: () => undefined })
    const h = await makeHarness({ trace: sink })
    // message_id included so the scope's messageId propagation is observable.
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002, message_id: 5001,
      message: [{ type: 'text', data: { text: '你好' } }], raw_message: '你好',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('turn/start', { turn: 1 }))
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '最终回复' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('最终回复'))).toBe(true)
    })
    await sink.flush()
    const lines = readLines(current(dir))
    expect(lines.length).toBeGreaterThan(0)
    // ① Every event of the round shares the single minted traceId — inbound,
    // dispatch, agent (turn/start + turn/end) and outbound all joined.
    const traceIds = new Set(lines.map(event => event.traceId))
    expect(traceIds.size).toBe(1)
    const stages = new Set(lines.map(event => event.stage))
    expect(stages.has('inbound')).toBe(true)
    expect(stages.has('dispatch')).toBe(true)
    expect(stages.has('agent')).toBe(true)
    expect(stages.has('outbound')).toBe(true)
    // Correlation fields propagated from the raw event.
    const first = lines.find(event => event.stage === 'inbound')!
    expect(first.chatId).toBe('private:10001')
    expect(first.messageId).toBe('5001')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('attributes the final settle-loop reply after turn/end to the initiating traceId too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-trace-'))
    const sink = new TraceSink({ dir, log: () => undefined })
    const h = await makeHarness({ trace: sink })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '最终答案' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    // The settle loop parks the final after turn/end; wait until it reached QQ.
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('最终答案'))).toBe(true)
    })
    await sink.flush()
    const lines = readLines(current(dir))
    const traceIds = new Set(lines.map(event => event.traceId))
    expect(traceIds.size).toBe(1)
    expect(lines.some(event => event.stage === 'outbound' && event.reason === '回复已发送')).toBe(true)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('records Chinese reasons for the silent-drop branches (ignoreSelf …)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-trace-'))
    const sink = new TraceSink({ dir, log: () => undefined })
    const h = await makeHarness({ trace: sink, ignoreSelf: true })
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10002, self_id: 10002,
      message: [{ type: 'text', data: { text: '自言自语' } }], raw_message: '自言自语',
      sender: { user_id: 10002, nickname: '自己' },
    }))
    await vi.waitFor(() => expect(readLines(current(dir)).some(event => event.stage === 'self')).toBe(true))
    await sink.flush()
    const lines = readLines(current(dir))
    const self = lines.find(event => event.stage === 'self')!
    expect(self.ok).toBe(false)
    expect(self.reason).toBe(TRACE_REASONS.inboundSelf)
    expect(self.reason).toMatch(CJK)
    expect(self.chatId).toBe('private:10002')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('every ok:false event in a live round carries a non-empty Chinese reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-trace-'))
    const sink = new TraceSink({ dir, log: () => undefined })
    const h = await makeHarness({ trace: sink, textImageThreshold: 0 })
    // Whitelisted user, but the message expands to no effective content and
    // the round still runs: drive one full round + a mention-less group drop.
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'group', user_id: 10001, group_id: 999, self_id: 10002,
      message: [{ type: 'text', data: { text: '没有 at' } }], raw_message: '没有 at',
      sender: { user_id: 10001, nickname: '路人' },
    }))
    await vi.waitFor(() => expect(readLines(current(dir)).some(event => event.stage === 'mention')).toBe(true))
    await sink.flush()
    const lines = readLines(current(dir))
    const drops = lines.filter(event => event.ok === false)
    expect(drops.length).toBeGreaterThan(0)
    for (const event of drops) {
      expect(event.reason ?? '', event.stage).toBeTruthy()
      expect(event.reason!, event.stage).toMatch(CJK)
    }
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)
})

describe('traceEnabled default off (zero difference)', () => {
  it('writes no trace file and dispatches identically without the sink', async () => {
    const h = await makeHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('turn/start', { turn: 1 }))
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回复' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('回复'))).toBe(true)
    })
    await new Promise(resolve => setTimeout(resolve, 150))
    // Zero files: no trace jsonl anywhere in the media dir.
    expect(existsSync(join(h.mediaDir, 'qq-trace.jsonl'))).toBe(false)
    expect(existsSync(join(h.mediaDir, 'qq-trace.1.jsonl'))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)
})

describe('offline queue + proactive write trace events', () => {
  it('the queuable park, the gate rejection and proactive writes all carry trace events with reasons', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-trace-'))
    const sink = new TraceSink({ dir, log: () => undefined })
    const h = await makeHarness({ trace: sink })
    const session = await inboundAndDisconnect(h)
    void session
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    // A queuable send while disconnected parks with a trace event (was silent).
    await expect(h.bridge.sendToChat('private:10001', '排队回复', { queuable: true })).resolves.toEqual([])
    // A proactive write while disconnected fails and is traced with a reason.
    await expect(h.bridge.sendSegments('private:10001', [{ type: 'text', data: { text: '主动写' } }]))
      .rejects.toThrow()
    const { client: client2, outbound: outbound2 } = await reconnect(h)
    await vi.waitFor(() => {
      expect(outbound2.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('排队回复'))).toBe(true)
    })
    client2.close()
    await sink.flush()
    const lines = readLines(current(dir))
    const parked = lines.find(event => event.stage === 'queue' && event.reason === TRACE_REASONS.outboundQueued)
    expect(parked).toBeDefined()
    expect(parked!.ok).toBe(true)
    const proactive = lines.find(event => event.stage === 'outbound' && event.ok === false && event.reason!.match(CJK))
    expect(proactive).toBeDefined()
    expect(proactive!.traceId).toMatch(/^t-/)
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)
})
