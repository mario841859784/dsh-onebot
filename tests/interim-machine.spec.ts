/**
 * InterimTracker state-machine unit tests (M3-D2a): the transition table is
 * driven directly against a hand-built InterimChat plus a stub InterimContext
 * — no WebSocket harness. Every entry method × prior state is covered,
 * including the permissive transitions that keep the pre-rewrite semantics
 * (a late assistant/message during settlement, a double turn/end) and the
 * synchronous booking/drain behavior (placeholder at enqueue, id backfill on
 * completion, placeholder drop on send failure).
 * @module dsh-onebot/tests/interim-machine
 */
import { describe, expect, it } from 'vitest'

import { InterimTracker } from '../src/interim.js'
import type { InterimChat } from '../src/interim.js'

function makeHarness(opts?: { interim?: boolean; interimRecallMs?: number; failSends?: boolean; sendIds?: string[] }) {
  const sentTexts: string[] = []
  const recalledIds: string[] = []
  const summaryCards: number[] = []
  let interimMode = opts?.interim ?? true
  const tracker = new InterimTracker({
    sendToChat: async (_chatId, text) => {
      if (opts?.failSends === true) throw new Error('send down')
      sentTexts.push(text)
      return opts?.sendIds ?? ['7']
    },
    sendMsg: async (_chatId, segments) => {
      summaryCards.push(segments.length)
      return '8'
    },
    call: async (action, params) => {
      if (action === 'delete_msg') recalledIds.push(String(params.message_id))
      return undefined
    },
    chainTail: async () => undefined,
    relayHostCards: () => undefined,
    effectiveInterim: () => interimMode,
    log: () => undefined,
    config: {
      interimRecallMs: opts?.interimRecallMs,
      maxImageBytes: 8 * 1024 * 1024,
      cardFooter: 'dsh',
      fontFiles: [],
      fontFamilies: [],
    },
  })
  const chat: InterimChat = {
    loopPending: null,
    loopBuffer: [],
    recallTimers: new Map(),
    recalledInterimIds: new Set(),
    lastHandledMessageId: undefined,
  }
  const assistant = (text: string, messageOpts?: { toolCall?: boolean; id?: string }) => ({
    id: messageOpts?.id,
    content: messageOpts?.toolCall === true
      ? [{ type: 'text', text }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }]
      : [{ type: 'text', text }],
  })
  // 120ms: a settlement recalls its interims with a 60ms spacing sleep per
  // id (RECALL_SPACING_MS), so the drain needs more than one spacing tick.
  const settle = () => new Promise(resolve => setTimeout(resolve, 120))
  return { tracker, chat, sentTexts, recalledIds, summaryCards, assistant, settle, setMode: (value: boolean) => { interimMode = value } }
}

describe('InterimTracker state machine (M3-D2a)', () => {
  it('idle × assistant(interim, tool-free) → accumulating: text deferred, nothing sent', () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('第一步') as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    expect(h.chat.loopPending).toBe('第一步')
    expect(h.sentTexts).toEqual([])
    expect(h.chat.loopBuffer).toEqual([])
  })

  it('idle × assistant(interim, tool call) → accumulating: interim booked at enqueue, sent live', async () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('带工具', { toolCall: true }) as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    // Booked synchronously at enqueue time (placeholder), before the send.
    expect(h.chat.loopBuffer).toHaveLength(1)
    expect(h.chat.loopBuffer[0].text).toBe('带工具')
    await h.settle()
    expect(h.chat.loopBuffer[0].id).toBe('7')
    expect(h.chat.loopBuffer[0].sentAt).toBeGreaterThan(0)
    expect(h.sentTexts).toEqual(['带工具'])
    expect(h.chat.recallTimers.has('7')).toBe(true)
  })

  it('accumulating × assistant(interim) → accumulating: the prior deferred text flushes as interim', async () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('第一步') as never)
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('第二步') as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    expect(h.chat.loopPending).toBe('第二步')
    await h.settle()
    expect(h.sentTexts).toEqual(['第一步'])
    expect(h.chat.loopBuffer).toHaveLength(1)
    expect(h.chat.loopBuffer[0].text).toBe('第一步')
  })

  it('accumulating × turn/end (interim) → settling → idle: summary card, recall, final', async () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('中间步', { toolCall: true }) as never)
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('最终答') as never)
    h.tracker.onTurnEnd('private:10001', h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('settling')
    await h.settle()
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
    expect(h.summaryCards).toHaveLength(1)
    expect(h.recalledIds).toEqual(['7'])
    expect(h.sentTexts).toEqual(['中间步', '最终答'])
    expect(h.chat.loopBuffer).toHaveLength(0)
    expect(h.chat.loopPending).toBeNull()
  })

  it('idle × turn/end (interim) → settling → idle with an empty trail: no card, no recall, no final', async () => {
    const h = makeHarness()
    h.tracker.onTurnEnd('private:10001', h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('settling')
    await h.settle()
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
    expect(h.summaryCards).toEqual([])
    expect(h.recalledIds).toEqual([])
    expect(h.sentTexts).toEqual([])
  })

  it('settling × turn/end (double) → skipped: one settle, machine returns to idle once', async () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('中间步', { toolCall: true }) as never)
    h.tracker.onTurnEnd('private:10001', h.chat)
    h.tracker.onTurnEnd('private:10001', h.chat)
    await h.settle()
    expect(h.summaryCards).toHaveLength(1)
    expect(h.recalledIds).toEqual(['7'])
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
  })

  it('settling × assistant (late message) → accumulating (permissive, pre-rewrite semantics)', async () => {
    const h = makeHarness()
    h.tracker.onTurnEnd('private:10001', h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('settling')
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('迟到步') as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    expect(h.chat.loopPending).toBe('迟到步')
    await h.settle()
    // The completed empty settlement did not stomp the new accumulation.
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
  })

  it('accumulating × turn/end (instant mode) → idle: the deferred text is the final', async () => {
    const h = makeHarness({ interim: false })
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('最终答') as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    expect(h.chat.loopPending).toBe('最终答')
    h.tracker.onTurnEnd('private:10001', h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
    await h.settle()
    expect(h.sentTexts).toEqual(['最终答'])
    expect(h.summaryCards).toEqual([])
  })

  it('idle × turn/end (instant mode) → idle, nothing sent', () => {
    const h = makeHarness({ interim: false })
    h.tracker.onTurnEnd('private:10001', h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
    expect(h.sentTexts).toEqual([])
  })

  it('instant × assistant mid-cycle then a mode flip to interim: the next message flushes the deferred text (unified field)', async () => {
    const h = makeHarness({ interim: false })
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('暂存文本') as never)
    h.setMode(true)
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('新文本') as never)
    await h.settle()
    expect(h.sentTexts).toEqual(['暂存文本'])
    expect(h.chat.loopPending).toBe('新文本')
  })

  it('accumulating/settling × onNewUserTurn → idle', async () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('第一步') as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    h.tracker.onNewUserTurn(h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
    h.tracker.onTurnEnd('private:10001', h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('settling')
    h.tracker.onNewUserTurn(h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
    await h.settle()
  })

  it('turn/start → idle plus the B8 prune of recalledInterimIds', () => {
    const h = makeHarness()
    h.chat.recalledInterimIds.add('7')
    h.tracker.onTurnStart(h.chat)
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
    expect(h.chat.recalledInterimIds.size).toBe(0)
  })

  it('empty text is a no-op for the machine; a duplicate message id is ignored entirely', () => {
    const h = makeHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, { id: undefined, content: [{ type: 'text', text: '' }] } as never)
    expect(h.tracker.stateOf(h.chat)).toBe('idle')
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('一步', { id: 'm1' }) as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('重复', { id: 'm1' }) as never)
    expect(h.tracker.stateOf(h.chat)).toBe('accumulating')
    expect(h.chat.loopPending).toBe('一步')
  })

  it('a failed send drops its placeholder: never summarized, never recalled', async () => {
    const h = makeHarness({ failSends: true })
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('发不出去', { toolCall: true }) as never)
    expect(h.chat.loopBuffer).toHaveLength(1)
    await h.settle()
    expect(h.chat.loopBuffer).toHaveLength(0)
    h.tracker.onTurnEnd('private:10001', h.chat)
    await h.settle()
    expect(h.summaryCards).toEqual([])
    expect(h.recalledIds).toEqual([])
  })

  it('a multi-id send expands the placeholder into one entry per message id', async () => {
    const h = makeHarness({ sendIds: ['7', '8'] })
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('分两段', { toolCall: true }) as never)
    expect(h.chat.loopBuffer).toHaveLength(1)
    await h.settle()
    expect(h.chat.loopBuffer.map(entry => entry.id)).toEqual(['7', '8'])
    expect(h.chat.recallTimers.has('7')).toBe(true)
    expect(h.chat.recallTimers.has('8')).toBe(true)
  })

  it('the auto-recall timer revokes alone and records the id (default recall on)', async () => {
    const h = makeHarness({ interimRecallMs: 20 })
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('会撤回', { toolCall: true }) as never)
    await h.settle()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(h.recalledIds).toEqual(['7'])
    expect(h.chat.recalledInterimIds.has('7')).toBe(true)
  })
})
