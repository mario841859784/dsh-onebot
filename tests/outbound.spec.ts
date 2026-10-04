/**
 * Outbound-domain tests (M2-D1-PR2): cases migrated from bridge.spec.ts per
 * the tests/README.md migration map (§3.3 outbound + §3.6 card-relay, the
 * latter co-located here per the PR's file ownership). Assertions are
 * unchanged; the two t2i inline harnesses converged onto the shared
 * makeHarness (maxImageBytes opt added). The three golden end-to-end cases
 * stay in bridge.spec.ts — they are the cross-module full-pipeline gate.
 * @module dsh-onebot/tests/outbound
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OneBotActionError, OneBotNotConnectedError } from '../src/connection.js'
import { ACTION_AUDIT_FILE, OutboundPipeline } from '../src/outbound.js'

import { inboundAndDisconnect, makeCmdHarness, makeEvent, makeHarness, reconnect, sentTexts } from './helpers/bridge-harness.js'

// Test isolation (0.6.0 flake hygiene): a test failing mid-way must never leak
// fake timers into the rest of the file (mirrors connection.spec.ts).
afterEach(() => {
  vi.useRealTimers()
})

describe('outbound pipeline', () => {
  it('renders a t2i card for long replies (image segment)', async () => {
    const h = await makeHarness({ textImageThreshold: 10 })
    h.sendText('hi')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    const longText = '这是一段非常长的回复内容，长度超过了阈值十，因此应该渲染成文字图卡片发送，而不是分段文本。'.repeat(2)
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('base64://'))).toBe(true)
    })
    const imageFrame = h.outbound.find(f => f.action === 'send_msg')!
    const segments = imageFrame.params.message as Array<{ type: string }>
    expect(segments.some(s => s.type === 'image')).toBe(true)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('falls back to a single plain text message when the card exceeds maxImageBytes', async () => {
    const h = await makeHarness({ textImageThreshold: 10, maxImageBytes: 500 })
    h.sendText('hi')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    const longText = '这是一段非常长的回复内容，图片超限，应该回退为分段文本发送。'.repeat(2)
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.filter(f => f.action === 'send_msg')).toHaveLength(1)
    })
    const textFrame = h.outbound.find(f => f.action === 'send_msg')!
    const segments = textFrame.params.message as Array<{ type: string; data: { text: string } }>
    expect(segments.filter(s => s.type === 'text').map(s => s.data.text).join('')).toBe(longText)
    expect(h.outbound.some(f => JSON.stringify(f.params).includes('base64://'))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('queues interim-mode final flushes while disconnected and resends them in order on reconnect (M1-B6)', async () => {
    const h = await makeHarness()
    const session = await inboundAndDisconnect(h)
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '最终回复一' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    // Let settle-loop #1 park its final before the next cycle starts, or the
    // next assistant/message proves it interim (bridge semantics) and drops it.
    await new Promise(resolve => setTimeout(resolve, 50))
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '最终回复二' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }))
    const { client: client2, outbound: outbound2 } = await reconnect(h)
    await vi.waitFor(() => {
      const texts = sentTexts(outbound2)
      expect(texts.some(t => t.includes('最终回复一'))).toBe(true)
      expect(texts.some(t => t.includes('最终回复二'))).toBe(true)
    })
    const texts = sentTexts(outbound2)
    expect(texts.findIndex(t => t.includes('最终回复一'))).toBeLessThan(texts.findIndex(t => t.includes('最终回复二')))
    client2.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('queues instant finals and error notices while disconnected and resends them in order (M1-B6)', async () => {
    const h = await makeHarness({ interimMessages: false })
    const session = await inboundAndDisconnect(h)
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '最终答案' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', {
      turn: 2, reason: { kind: 'error', error: { code: 'E_TEST', message: '模型炸了' } },
    }))
    const { client: client2, outbound: outbound2 } = await reconnect(h)
    await vi.waitFor(() => {
      const texts = sentTexts(outbound2)
      expect(texts.some(t => t.includes('最终答案'))).toBe(true)
      expect(texts.some(t => t.includes('运行出错'))).toBe(true)
    })
    const texts = sentTexts(outbound2)
    expect(texts.findIndex(t => t.includes('最终答案'))).toBeLessThan(texts.findIndex(t => t.includes('运行出错')))
    client2.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('does not queue interim sends while disconnected (M1-B6)', async () => {
    const h = await makeHarness()
    const session = await inboundAndDisconnect(h)
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'tool-call', toolName: 'x' }, { type: 'text', text: '中间过程' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const { client: client2, outbound: outbound2 } = await reconnect(h)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(sentTexts(outbound2)).toHaveLength(0)
    client2.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('caps the per-chat queue at 20 and drops the oldest while disconnected (M1-B6)', async () => {
    const h = await makeHarness({ interimMessages: false })
    const session = await inboundAndDisconnect(h)
    for (let i = 1; i <= 21; i++) {
      h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
        turn: i, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '最终答案' + i }] },
      }))
      h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: i, reason: { kind: 'completed' } }))
    }
    const { client: client2, outbound: outbound2 } = await reconnect(h)
    await vi.waitFor(() => expect(sentTexts(outbound2).some(t => t.includes('最终答案21"'))).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 200))
    const finals = sentTexts(outbound2).filter(t => t.includes('最终答案'))
    expect(finals).toHaveLength(20)
    expect(finals.some(t => t.includes('最终答案1"'))).toBe(false)
    expect(finals[0].includes('最终答案2"')).toBe(true)
    client2.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('drops queued finals older than the TTL instead of resending them (M1-B6)', async () => {
    const h = await makeHarness()
    const session = await inboundAndDisconnect(h)
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '过期回复' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    // Deterministic isolation fix (0.6.0 flake): wait until the settle loop has
    // actually PARKED the final itself before jumping the clock — the former
    // fixed 50ms sleep raced the park; a park landing after the jump stamped a
    // post-jump sentAt and the entry then never expired (resent, test failed).
    // The queue holds the summary card too, so match the final's text, not a
    // count.
    const parkedTexts = (): string[] =>
      ((h.bridge as unknown as { outbound: { pendingSends: Map<string, Array<{ text: string }>> } }).outbound)
        .pendingSends.get('private:10001')?.map(item => item.text) ?? []
    await vi.waitFor(() => expect(parkedTexts().some(t => t.includes('过期回复'))).toBe(true))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      vi.advanceTimersByTime(5 * 60_000 + 1_000)
      const { client: client2, outbound: outbound2 } = await reconnect(h)
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(sentTexts(outbound2).some(t => t.includes('过期回复'))).toBe(false)
      client2.close()
    } finally {
      vi.useRealTimers()
    }
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('sendToChat while disconnected: queuable final parks and drains on reconnect, non-queuable throws (M2-T0 outbound gate)', async () => {
    const h = await makeHarness()
    await inboundAndDisconnect(h)
    await expect(h.bridge.sendToChat('private:10001', '排队最终回复', { queuable: true })).resolves.toEqual([])
    await expect(h.bridge.sendToChat('private:10001', '即时回复')).rejects.toThrow(OneBotNotConnectedError)
    const { client: client2, outbound: outbound2 } = await reconnect(h)
    await vi.waitFor(() => {
      expect(sentTexts(outbound2).some(t => t.includes('排队最终回复'))).toBe(true)
    })
    expect(sentTexts(outbound2).some(t => t.includes('即时回复'))).toBe(false)
    client2.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('relays host plan books and option cards to the chat (exit_plan_mode / ask_user_question)', async () => {
    const h = await makeCmdHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }

    // A plan review tool call (empty text block) must still reach QQ.
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', id: 'relay-plan-1', content: [
        { type: 'text', text: '' },
        { type: 'tool-call', id: 'c1', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 测试计划\n\n实现 A 与 B。' }) },
      ] },
    }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('计划书'))).toBe(true)
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('实现 A 与 B'))).toBe(true)
    })

    // Re-emitting the same message id consecutively (streaming/usage) must not
    // double-relay — dedupe keys on the latest handled id, re-emits arrive in order.
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', id: 'relay-plan-1', content: [
        { type: 'tool-call', id: 'c1', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 测试计划\n\n实现 A 与 B。' }) },
      ] },
    }))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(h.outbound.filter(f => JSON.stringify(f.params).includes('计划书'))).toHaveLength(1)

    // An option card (ask_user_question) with questions/options.
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 2, message: { role: 'assistant', id: 'relay-q-1', content: [
        { type: 'tool-call', id: 'c2', name: 'ask_user_question', arguments: JSON.stringify({ questions: [
          { id: 'q1', question: '选哪个方案？', options: [{ label: '方案A' }, { label: '方案B' }], multi_select: true },
        ] }) },
      ] },
    }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('选哪个方案？'))).toBe(true)
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('方案A'))).toBe(true)
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('可多选'))).toBe(true)
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('outbound proactive-write gate (W2-③)', () => {
  /** Minimal OutboundPipeline harness: a connected fake transport capturing
   * every send action, config limits injected per test, optional audit dir.
   * Isolation (0.6.0 flake hygiene): the pipeline gets a monotonic injected
   * clock instead of the wall clock, so gate windows can never be perturbed
   * by real-time minute/day boundaries or worker clock jumps. */
  const makeGateHarness = (opts?: {
    actionRatePerMinute?: number
    actionRatePerDay?: number
    mediaDir?: string
  }) => {
    const sent: Array<{ action: string; params: Record<string, unknown> }> = []
    const logs: string[] = []
    let clock = 1_700_000_000_000
    const pipeline = new OutboundPipeline({
      getChat: () => ({ lastNickname: '' }),
      connected: () => true,
      selfId: () => '10002',
      call: async (action, params) => {
        sent.push({ action, params: params as Record<string, unknown> })
        return { message_id: 7 }
      },
      isStopping: () => false,
      log: (level, message) => { logs.push(level + ':' + message) },
      config: {
        botQQ: '10002', sensitivePatterns: [], textImageThreshold: 0, maxImageBytes: 8 * 1024 * 1024,
        cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
        ...(opts?.actionRatePerMinute !== undefined ? { actionRatePerMinute: opts.actionRatePerMinute } : {}),
        ...(opts?.actionRatePerDay !== undefined ? { actionRatePerDay: opts.actionRatePerDay } : {}),
        ...(opts?.mediaDir !== undefined ? { mediaDir: opts.mediaDir } : {}),
      },
    }, { now: () => (clock += 25) })
    return { pipeline, sent, logs }
  }

  const readAudit = (mediaDir: string): Array<Record<string, unknown>> =>
    readFileSync(join(mediaDir, ACTION_AUDIT_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)

  it('rejects proactive writes beyond actionRatePerMinute with a Chinese warn carrying chatId and limit name', async () => {
    const { pipeline, sent, logs } = makeGateHarness({ actionRatePerMinute: 2, actionRatePerDay: 0 })
    expect(await pipeline.sendSegments('group:888', [{ type: 'text', data: { text: '一' } }])).toBe('7')
    expect(await pipeline.sendSegments('group:888', [{ type: 'text', data: { text: '二' } }])).toBe('7')
    expect(sent).toHaveLength(2)
    // The limit is bridge-wide: a different chat consumes the same quota.
    await expect(pipeline.sendSegments('private:10001', [{ type: 'text', data: { text: '三' } }]))
      .rejects.toThrow(OneBotActionError)
    await expect(pipeline.sendSegments('private:10001', [{ type: 'text', data: { text: '四' } }]))
      .rejects.toThrow('actionRatePerMinute')
    // Rejected attempts never reach the transport and never consume quota.
    expect(sent).toHaveLength(2)
    const warns = logs.filter(l => l.startsWith('warn:已拒发主动写操作'))
    expect(warns.length).toBeGreaterThanOrEqual(2)
    expect(warns[0]).toContain('private:10001')
    expect(warns[0]).toContain('actionRatePerMinute=2')
    // Still 2/2 used: one more rejected, quota untouched by rejections.
    expect(pipeline['writeActionTimes']).toHaveLength(2)
  })

  it('rejects proactive writes beyond actionRatePerDay', async () => {
    const { pipeline, sent, logs } = makeGateHarness({ actionRatePerMinute: 100, actionRatePerDay: 3 })
    for (let i = 0; i < 3; i++) {
      await pipeline.sendSegments('group:888', [{ type: 'text', data: { text: String(i) } }])
    }
    expect(sent).toHaveLength(3)
    await expect(pipeline.sendSegments('group:888', [{ type: 'text', data: { text: '第四条' } }]))
      .rejects.toThrow('actionRatePerDay')
    expect(sent).toHaveLength(3)
    expect(logs.some(l => l.startsWith('warn:已拒发主动写操作') && l.includes('group:888') && l.includes('actionRatePerDay=3'))).toBe(true)
  })

  it('audits allowed writes and rejections to mediaDir/qq-actions.log (jsonl)', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-audit-'))
    const { pipeline } = makeGateHarness({ actionRatePerMinute: 1, actionRatePerDay: 0, mediaDir })
    await pipeline.sendSegments('group:888', [{ type: 'text', data: { text: '允许' } }])
    await expect(pipeline.sendSegments('group:888', [{ type: 'text', data: { text: '拒绝' } }]))
      .rejects.toThrow(OneBotActionError)
    await vi.waitFor(() => expect(readAudit(mediaDir)).toHaveLength(2))
    const lines = readAudit(mediaDir)
    expect(lines[0]).toMatchObject({ chatId: 'group:888', action: 'send_msg', ok: true, reason: '发送成功' })
    expect(typeof lines[0].ts).toBe('number')
    expect(lines[1]).toMatchObject({ chatId: 'group:888', action: 'send_msg', ok: false })
    expect(String(lines[1].reason)).toContain('actionRatePerMinute=1')
    // Audit appends across calls; never truncates.
    expect(readFileSync(join(mediaDir, ACTION_AUDIT_FILE), 'utf8').endsWith('\n')).toBe(true)
  })

  it('audits tool forward sends (send_forward_msg) but not the passive [[qq_forward]] reply blocks', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-audit-'))
    // Minute quota = 1: the proactive tool write consumes it entirely.
    const { pipeline, sent } = makeGateHarness({ actionRatePerMinute: 1, actionRatePerDay: 0, mediaDir })
    await pipeline.sendForward('group:888', [{ name: '助手', content: '节点内容' }])
    expect(sent).toEqual([expect.objectContaining({ action: 'send_forward_msg' })])
    // Passive replies keep flowing (sendToChat is not gated).
    await pipeline.sendToChat('group:888', '被动回复一')
    await pipeline.sendToChat('group:888', '被动回复二')
    // A passive [[qq_forward]] block inside a turn reply also bypasses the gate.
    await pipeline.sendToChat('group:888', '前言 [[qq_forward]]标题\n内容[[/qq_forward]]')
    expect(sent.some(f => f.action === 'send_forward_msg' && JSON.stringify(f.params).includes('内容'))).toBe(true)
    expect(sent.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('被动回复一'))).toBe(true)
    // Only the one proactive write was audited.
    await vi.waitFor(() => expect(readAudit(mediaDir)).toHaveLength(1))
    expect(readAudit(mediaDir)[0]).toMatchObject({ chatId: 'group:888', action: 'send_forward_msg', ok: true })
  })

  it('degrades gracefully when the audit write fails (warn only, send unaffected)', async () => {
    // mediaDir points inside a regular file → mkdir/append must fail.
    const blockFile = join(tmpdir(), 'onebot-audit-block-' + Date.now() + '-' + Math.random().toString(16).slice(2))
    writeFileSync(blockFile, 'not a dir')
    const { pipeline, sent, logs } = makeGateHarness({ actionRatePerMinute: 0, actionRatePerDay: 0, mediaDir: join(blockFile, 'sub') })
    await expect(pipeline.sendSegments('group:888', [{ type: 'text', data: { text: '照发' } }])).resolves.toBe('7')
    expect(sent).toHaveLength(1)
    await vi.waitFor(() => {
      expect(logs.some(l => l.startsWith('warn:写操作审计写入失败'))).toBe(true)
    })
    expect(logs.some(l => l.startsWith('warn:已拒发主动写操作'))).toBe(false)
  })

  it('actionRatePerMinute/actionRatePerDay 0 disables the gate with zero behavior change', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-audit-'))
    const { pipeline, sent, logs } = makeGateHarness({ actionRatePerMinute: 0, actionRatePerDay: 0, mediaDir })
    for (let i = 0; i < 25; i++) {
      await pipeline.sendSegments('group:888', [{ type: 'text', data: { text: '第' + i + '条' } }])
    }
    expect(sent).toHaveLength(25)
    expect(logs.some(l => l.startsWith('warn:已拒发主动写操作'))).toBe(false)
    // Auditing stays on (its own switch): 25 success lines, no rejections.
    await vi.waitFor(() => expect(readAudit(mediaDir)).toHaveLength(25))
    expect(readAudit(mediaDir).every(l => l.ok === true)).toBe(true)
  })
})
