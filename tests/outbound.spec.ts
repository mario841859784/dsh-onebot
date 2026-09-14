/**
 * Outbound-domain tests (M2-D1-PR2): cases migrated from bridge.spec.ts per
 * the tests/README.md migration map (§3.3 outbound + §3.6 card-relay, the
 * latter co-located here per the PR's file ownership). Assertions are
 * unchanged; the two t2i inline harnesses converged onto the shared
 * makeHarness (maxImageBytes opt added). The three golden end-to-end cases
 * stay in bridge.spec.ts — they are the cross-module full-pipeline gate.
 * @module dsh-onebot/tests/outbound
 */
import { describe, expect, it, vi } from 'vitest'

import { OneBotNotConnectedError } from '../src/connection.js'

import { inboundAndDisconnect, makeCmdHarness, makeEvent, makeHarness, reconnect, sentTexts } from './helpers/bridge-harness.js'

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
    // Let the settle-loop microtask park the final BEFORE the clock jump, or it
    // would queue with a fresh (post-jump) timestamp and never expire.
    await new Promise(resolve => setTimeout(resolve, 50))
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
