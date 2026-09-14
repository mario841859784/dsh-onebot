/**
 * Interim-domain tests (M2-D1-PR5): cases migrated from bridge.spec.ts per
 * the tests/README.md migration map (§3.4 interim). Assertions are unchanged
 * and the five migrated cases keep their inline harnesses verbatim. The three
 * M2-T0 interim timing cases and the three golden end-to-end cases stay in
 * bridge.spec.ts — they are the cross-module gate. The last case pins the B8
 * recalledInterimIds prune at turn/start.
 * @module dsh-onebot/tests/interim
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import WebSocket from 'ws'

import { OneBotConnection } from '../src/connection.js'
import { ChatBridge } from '../src/bridge.js'
import { MediaStore } from '../src/media.js'
import { Transcriber } from '../src/stt.js'

import { makeCmdHarness, makeEvent, makeFakeAgents } from './helpers/bridge-harness.js'

describe('interim tracker', () => {
  it('buffers interim text when interimMessages is off and sends only the final step', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, requireMention: true,
        interimMessages: false, sendErrorNotice: true, restrictedMemberPrefix: false,
        sensitivePatterns: [], mediaDir, maxImageBytes: 8 * 1024 * 1024,
        maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    connection.onMessage = event => {
      void bridge.handleInbound(event)
    }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer test-token' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const outbound: Array<Record<string, unknown>> = []
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      outbound.push(frame)
      if (typeof frame.echo === 'string') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
      }
    })
    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'text', data: { text: 'hi' } }], raw_message: 'hi',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(captured.followups).toHaveLength(1))
    const session = { id: sessionIds[0] }
    ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '中间步骤' }] },
    }))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(outbound.some(f => f.action === 'send_msg')).toBe(false)
    ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 2, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '最终答案' }] },
    }))
    ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('最终答案'))).toBe(true)
    })
    expect(outbound.filter(f => f.action === 'send_msg').some(f => JSON.stringify(f.params).includes('中间步骤'))).toBe(false)
    client.close()
    await bridge.stop()
    await connection.stop()
  })

  it('merges ≥2 interim messages into one forward and recalls the originals at turn/end', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      agentPresets: { mount: vi.fn(async () => ({ id: 'standard' })) } as never,
      workspaceRegistry: {
        resolveByPath: vi.fn(async () => undefined),
        create: vi.fn(async () => ({ attachSession: vi.fn(async () => undefined) })),
      } as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
        sensitivePatterns: [], mediaDir, maxImageBytes: 8 * 1024 * 1024,
        maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
        agentPreset: 'standard', workspacePath: mediaDir,
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    connection.onMessage = event => {
      void bridge.handleInbound(event)
    }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer test-token' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))

    // Respond to every action so pending calls resolve (unique message ids).
    const outbound: Array<Record<string, unknown>> = []
    let nextId = 1
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      outbound.push(frame)
      if (typeof frame.echo === 'string') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: nextId++ }, echo: frame.echo }))
      }
    })

    // Start a chat with an inbound message.
    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'text', data: { text: '做这个任务' } }],
      raw_message: '做这个任务',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(captured.followups).toHaveLength(1))
    const session = { id: sessionIds[0] }

    // Three assistant steps: the first two become interim, the last is final.
    const emitAssistant = (text: string, step: number) => {
      ctx.emit('session/event', session as never, makeEvent('assistant/message', {
        turn: 1, step,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      }))
    }
    emitAssistant('第一步：先查资料', 1)
    emitAssistant('第二步：找到了，开始总结', 2)
    await vi.waitFor(() => {
      // Only the first step is out (deferred one step) at this point.
      expect(outbound.filter(f => f.action === 'send_msg')).toHaveLength(1)
    })
    emitAssistant('第三步：总结如下', 3)
    await vi.waitFor(() => {
      // Second step out as interim too; third still deferred.
      expect(outbound.filter(f => f.action === 'send_msg')).toHaveLength(2)
    })
    ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))

    // Settlement: one t2i summary image card first (all interims), then the
    // originals recalled immediately, then the final text. No merged-forward.
    await vi.waitFor(() => {
      expect(outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('"type":"image"'))).toBe(true)
    })
    const summaryIdx = outbound.findIndex(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('"type":"image"'))

    // Final text delivered after the summary card.
    await vi.waitFor(() => {
      expect(outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('第三步'))).toBe(true)
    })
    const finalIdx = outbound.findIndex(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('第三步'))
    expect(finalIdx).toBeGreaterThan(summaryIdx)
    expect(outbound.some(f => f.action === 'send_private_forward_msg')).toBe(false)

    // Originals recalled immediately (after the summary card).
    await vi.waitFor(() => {
      expect(outbound.filter(f => f.action === 'delete_msg')).toHaveLength(2)
    })
    const delIdx = outbound.findIndex(f => f.action === 'delete_msg')
    expect(delIdx).toBeGreaterThan(summaryIdx)

    client.close()
    await bridge.stop()
    await connection.stop()
  })

  it('dedupes duplicate assistant/message events for the same message id', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      agentPresets: { mount: vi.fn(async () => ({ id: 'standard' })) } as never,
      workspaceRegistry: {
        resolveByPath: vi.fn(async () => undefined),
        create: vi.fn(async () => ({ attachSession: vi.fn(async () => undefined) })),
      } as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
        sensitivePatterns: [], mediaDir, maxImageBytes: 8 * 1024 * 1024,
        maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
        agentPreset: 'standard', workspacePath: mediaDir,
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    connection.onMessage = event => {
      void bridge.handleInbound(event)
    }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer test-token' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))

    const outbound: Array<Record<string, unknown>> = []
    let nextId = 1
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      outbound.push(frame)
      if (typeof frame.echo === 'string') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: nextId++ }, echo: frame.echo }))
      }
    })

    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'text', data: { text: '重复事件测试' } }],
      raw_message: '重复事件测试',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(captured.followups).toHaveLength(1))
    const session = { id: sessionIds[0] }

    // Tool-carrying interims are sent immediately; a re-emitted event with the
    // same message id (streaming/usage) must not send again.
    const emitAssistant = (id: string, text: string) => {
      ctx.emit('session/event', session as never, makeEvent('assistant/message', {
        turn: 1, step: 1,
        message: {
          id, role: 'assistant',
          content: [{ type: 'text', text }, { type: 'tool-call', id: 'call-1', name: 'test', arguments: '{}' }],
        },
      }))
    }
    emitAssistant('msg-dup-1', '第一条：查资料')
    emitAssistant('msg-dup-1', '第一条：查资料')
    emitAssistant('msg-dup-1', '第一条：查资料')
    emitAssistant('msg-dup-2', '第二条：总结')
    await vi.waitFor(() => {
      expect(outbound.filter(f => f.action === 'send_msg')).toHaveLength(2)
    })
    ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    // No merged forward: a t2i summary image plus immediate recalls instead.
    await vi.waitFor(() => {
      expect(outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('"type":"image"'))).toBe(true)
    })
    expect(outbound.filter(f => f.action === 'send_private_forward_msg')).toHaveLength(0)
    await vi.waitFor(() => {
      expect(outbound.filter(f => f.action === 'delete_msg')).toHaveLength(2)
    })

    client.close()
    await bridge.stop()
    await connection.stop()
  })

  it('leaves a single interim as-is: no merge, no recall', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      agentPresets: { mount: vi.fn(async () => ({ id: 'standard' })) } as never,
      workspaceRegistry: {
        resolveByPath: vi.fn(async () => undefined),
        create: vi.fn(async () => ({ attachSession: vi.fn(async () => undefined) })),
      } as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
        sensitivePatterns: [], mediaDir, maxImageBytes: 8 * 1024 * 1024,
        maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
        agentPreset: 'standard', workspacePath: mediaDir,
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    connection.onMessage = event => {
      void bridge.handleInbound(event)
    }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer test-token' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))

    const outbound: Array<Record<string, unknown>> = []
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      outbound.push(frame)
      if (typeof frame.echo === 'string') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
      }
    })

    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'text', data: { text: '一个问题' } }],
      raw_message: '一个问题',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(captured.followups).toHaveLength(1))
    const session = { id: sessionIds[0] }

    // One assistant step only → it is the final; no interim ever sent.
    ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '唯一回复' }] },
    }))
    ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('唯一回复'))).toBe(true)
    })
    await vi.waitFor(() => expect(sessions.flush).toHaveBeenCalled())
    expect(outbound.some(f => f.action === 'send_forward_msg' || f.action === 'send_private_forward_msg')).toBe(false)
    expect(outbound.some(f => f.action === 'delete_msg')).toBe(false)

    client.close()
    await bridge.stop()
    await connection.stop()
  })

  it('clears unmerged loop residue when a new user message arrives', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      agentPresets: { mount: vi.fn(async () => ({ id: 'standard' })) } as never,
      workspaceRegistry: {
        resolveByPath: vi.fn(async () => undefined),
        create: vi.fn(async () => ({ attachSession: vi.fn(async () => undefined) })),
      } as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
        sensitivePatterns: [], mediaDir, maxImageBytes: 8 * 1024 * 1024,
        maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
        agentPreset: 'standard', workspacePath: mediaDir,
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    connection.onMessage = event => {
      void bridge.handleInbound(event)
    }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer test-token' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))

    const outbound: Array<Record<string, unknown>> = []
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      outbound.push(frame)
      if (typeof frame.echo === 'string') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
      }
    })

    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'text', data: { text: '开始' } }],
      raw_message: '开始',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(captured.followups).toHaveLength(1))
    const session = { id: sessionIds[0] }

    // One interim out; turn never ends before the user interrupts.
    ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '中间评论一' }] },
    }))
    ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 2,
      message: { role: 'assistant', content: [{ type: 'text', text: '中间评论二' }] },
    }))
    await vi.waitFor(() => {
      expect(outbound.filter(f => f.action === 'send_msg')).toHaveLength(1)
    })

    // New user message arrives before turn/end: residue must be cleared.
    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'text', data: { text: '打断一下' } }],
      raw_message: '打断一下',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(captured.followups).toHaveLength(2))

    // Turn ends: nothing left to merge, no final to send.
    ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => expect(sessions.flush).toHaveBeenCalled())
    expect(outbound.some(f => f.action === 'send_forward_msg' || f.action === 'send_private_forward_msg')).toBe(false)
    expect(outbound.some(f => f.action === 'delete_msg')).toBe(false)
    expect(outbound.filter(f => f.action === 'send_msg')).toHaveLength(1)

    client.close()
    await bridge.stop()
    await connection.stop()
  })

  it('prunes recalledInterimIds at turn/start; the skip logic survives the prune (B8)', async () => {
    const h = await makeCmdHarness({ interimRecallMs: 40 })
    h.sendText('开始长任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    const chat = (h.bridge as unknown as { chats: Map<string, { recalledInterimIds: Set<string> }> }).chats.get('private:10001')!

    // Turn 1: a tool-carrying interim goes out live and its 40ms timer revokes
    // it — the id lands in recalledInterimIds.
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', id: 'im-prune-1', content: [
        { type: 'text', text: '第一步：查资料' },
        { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
      ] },
    }))
    await vi.waitFor(() => expect(h.outbound.some(f => f.action === 'delete_msg')).toBe(true))
    expect(chat.recalledInterimIds.has('7')).toBe(true)

    // turn/end: the immediate recall skips the already-revoked id — no second
    // delete_msg for the same message id.
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('"type":"image"'))).toBe(true)
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(h.outbound.filter(f => f.action === 'delete_msg')).toHaveLength(1)

    // The next turn starts: the previous turn's residue is pruned.
    h.ctx.emit('session/event', session as never, makeEvent('turn/start', { turn: 2 }))
    expect(chat.recalledInterimIds.size).toBe(0)

    // Same id again (the echo responder reuses 7): the new interim auto-recalls
    // and its turn/end recall skips it exactly as before — pruning did not
    // break the skip logic, and the reused id leaves no stale behavior.
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 2, step: 1, message: { role: 'assistant', id: 'im-prune-2', content: [
        { type: 'text', text: '第二步：总结' },
        { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
      ] },
    }))
    await vi.waitFor(() => expect(h.outbound.filter(f => f.action === 'delete_msg')).toHaveLength(2))
    expect(chat.recalledInterimIds.has('7')).toBe(true)
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.filter(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('"type":"image"'))).toHaveLength(2)
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(h.outbound.filter(f => f.action === 'delete_msg')).toHaveLength(2)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('sends one 104-char interim as a single QQ message with one recall and a one-line, contiguously numbered summary card', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      agentPresets: { mount: vi.fn(async () => ({ id: 'standard' })) } as never,
      workspaceRegistry: {
        resolveByPath: vi.fn(async () => undefined),
        create: vi.fn(async () => ({ attachSession: vi.fn(async () => undefined) })),
      } as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
        sensitivePatterns: [], mediaDir, maxImageBytes: 500,
        maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
        agentPreset: 'standard', workspacePath: mediaDir,
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    connection.onMessage = event => {
      void bridge.handleInbound(event)
    }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer test-token' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))

    const textOf = (frame: Record<string, unknown>): string =>
      ((frame.params as { message?: Array<{ type?: string; data?: { text?: string } }> }).message ?? [])
        .filter(seg => seg.type === 'text')
        .map(seg => seg.data?.text ?? '')
        .join('')
    const outbound: Array<Record<string, unknown>> = []
    const echoed: Array<{ action: unknown; id: string }> = []
    let nextId = 1
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      outbound.push(frame)
      if (typeof frame.echo === 'string') {
        const id = String(nextId++)
        echoed.push({ action: frame.action, id })
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: id }, echo: frame.echo }))
      }
    })

    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'text', data: { text: '开始长任务' } }],
      raw_message: '开始长任务',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(captured.followups).toHaveLength(1))
    const session = { id: sessionIds[0] }

    // One tool-carrying interim of 104 chars: the whole body goes out as one
    // QQ message (one id), and the pre-fix bug
    // expanded the single buffer entry into two verbatim-identical summary
    // lines. maxImageBytes=500 forces the summary card down the PNG-overflow
    // text fallback so the rendered body is directly assertable.
    const text = '第一步：已经读取了配置文件并确认了所有参数都符合预期。' +
      '第二步：正在把改动应用到工作树并且没有遇到任何冲突。' +
      '第三步：还剩最后的验证步骤就可以提交最终结论了。' +
      '第四步：所有检查都已完成，等待下一个指令继续推进任务。'
    ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', id: 'im-split-1', content: [
        { type: 'text', text },
        { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
      ] },
    }))
    await vi.waitFor(() => {
      expect(outbound.filter(f => f.action === 'send_msg')).toHaveLength(1)
    })
    // Live send: the full text goes out once, unsplit.
    expect(outbound.filter(f => f.action === 'send_msg').map(textOf).join('')).toBe(text)

    const at = outbound.length
    ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(outbound.filter(f => f.action === 'delete_msg')).toHaveLength(1)
    })

    // Summary body: the full text appears exactly once, numbering stays
    // contiguous (no orphan "2." line from the empty-text sibling entry).
    const summary = outbound.slice(at).filter(f => f.action === 'send_msg').map(textOf).join('')
    expect(summary).toBe('1. ' + text)
    // Recall intact: the one QQ message of the interim is revoked.
    const liveIds = echoed.filter(e => e.action === 'send_msg').slice(0, 1).map(e => e.id)
    expect(outbound.filter(f => f.action === 'delete_msg').map(f => (f.params as { message_id: string }).message_id).sort())
      .toEqual(liveIds.sort())

    client.close()
    await bridge.stop()
    await connection.stop()
  })

  it('keeps one summary line when an interim carries a [[qq_forward]] block plus body (forward fake id still recalls)', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      agentPresets: { mount: vi.fn(async () => ({ id: 'standard' })) } as never,
      workspaceRegistry: {
        resolveByPath: vi.fn(async () => undefined),
        create: vi.fn(async () => ({ attachSession: vi.fn(async () => undefined) })),
      } as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
        sensitivePatterns: [], mediaDir, maxImageBytes: 500,
        maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
        agentPreset: 'standard', workspacePath: mediaDir,
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    connection.onMessage = event => {
      void bridge.handleInbound(event)
    }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer test-token' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))

    const textOf = (frame: Record<string, unknown>): string =>
      ((frame.params as { message?: Array<{ type?: string; data?: { text?: string } }> }).message ?? [])
        .filter(seg => seg.type === 'text')
        .map(seg => seg.data?.text ?? '')
        .join('')
    const nodesOf = (frame: Record<string, unknown>): Array<{ name: string; content: string }> =>
      ((frame.params as { messages?: Array<{ data?: { name?: string; content?: Array<{ data?: { text?: string } }> } }> }).messages ?? [])
        .map(node => ({
          name: node.data?.name ?? '',
          content: (node.data?.content ?? []).map(seg => seg.data?.text ?? '').join(''),
        }))
    const outbound: Array<Record<string, unknown>> = []
    const echoed: Array<{ action: unknown; id: string }> = []
    let nextId = 1
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      outbound.push(frame)
      if (typeof frame.echo === 'string') {
        const id = String(nextId++)
        echoed.push({ action: frame.action, id })
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: id }, echo: frame.echo }))
      }
    })

    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'text', data: { text: '开始长任务' } }],
      raw_message: '开始长任务',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(captured.followups).toHaveLength(1))
    const session = { id: sessionIds[0] }

    // A forward block plus body: the pipeline returns the fake 'forward' id
    // and the real body id, i.e. two buffer entries from one interim.
    const text = '[[qq_forward]]\n资料卡片\n这是查到的资料内容。[[/qq_forward]]正文结论如下。'
    ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', id: 'im-fwd-1', content: [
        { type: 'text', text },
        { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
      ] },
    }))
    await vi.waitFor(() => {
      expect(outbound.some(f => f.action === 'send_private_forward_msg')).toBe(true)
      expect(outbound.filter(f => f.action === 'send_msg')).toHaveLength(1)
    })
    // Live behavior unchanged: one forward node + one body message.
    expect(nodesOf(outbound.find(f => f.action === 'send_private_forward_msg')!))
      .toEqual([{ name: '资料卡片', content: '这是查到的资料内容。' }])
    expect(outbound.filter(f => f.action === 'send_msg').map(textOf)).toEqual(['正文结论如下。'])

    const at = outbound.length
    ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(outbound.filter(f => f.action === 'delete_msg')).toHaveLength(2)
    })

    // Summary body (PNG-overflow text fallback re-extracts the marker): the
    // node content appears exactly once and the line numbering stays contiguous.
    const postFwd = outbound.slice(at).filter(f => f.action === 'send_private_forward_msg')
    expect(postFwd).toHaveLength(1)
    expect(nodesOf(postFwd[0]!)).toEqual([{ name: '资料卡片', content: '这是查到的资料内容。' }])
    const summary = outbound.slice(at).filter(f => f.action === 'send_msg').map(textOf).join('')
    expect(summary).toBe('1. 正文结论如下。')
    // Recall intact: the fake forward id and the real body id both revoked.
    const bodyId = echoed.filter(e => e.action === 'send_msg').slice(0, 1).map(e => e.id)
    expect(outbound.filter(f => f.action === 'delete_msg').map(f => (f.params as { message_id: string }).message_id).sort())
      .toEqual([...bodyId, 'forward'].sort())

    client.close()
    await bridge.stop()
    await connection.stop()
  })
})

describe('interimRecall=false degrade switch (M3-D2b): send-only interims', () => {
  it('sends interims live but never recalls: no auto-recall timer, no turn/end card, no delete_msg', async () => {
    const h = await makeCmdHarness({ interimRecallMs: 40, interimRecall: false })
    h.sendText('开始长任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    // A tool-carrying interim goes out live as usual…
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', id: 'dr-1', content: [
        { type: 'text', text: '第一步：查资料' },
        { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
      ] },
    }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('第一步'))).toBe(true)
    })
    // …but its 40ms auto-recall window elapses while the turn runs: nothing revoked.
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(h.outbound.some(f => f.action === 'delete_msg')).toBe(false)
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 2, message: { role: 'assistant', id: 'dr-2', content: [{ type: 'text', text: '最终结论' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    // Settlement sends the final only: no summary card, no immediate recall.
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('最终结论'))).toBe(true)
    })
    expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('"type":"image"'))).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(h.outbound.some(f => f.action === 'delete_msg')).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('keeps every step live and ends the turn with only the final (deferred path, no card/recall)', async () => {
    const h = await makeCmdHarness({ interimRecall: false })
    h.sendText('开始长任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', id: 'dr-3', content: [{ type: 'text', text: '中间评论一' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 2, message: { role: 'assistant', id: 'dr-4', content: [{ type: 'text', text: '中间评论二' }] },
    }))
    // Step 1 flushes as interim when step 2 proves it; step 2 stays deferred.
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('中间评论一'))).toBe(true)
    })
    expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('中间评论二'))).toBe(false)
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('中间评论二'))).toBe(true)
    })
    expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('"type":"image"'))).toBe(false)
    expect(h.outbound.some(f => f.action === 'delete_msg')).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('combines with interimMessages=false: pure instant mode — exactly one final send', async () => {
    const h = await makeCmdHarness({ interimMessages: false, interimRecall: false })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', id: 'dr-5', content: [{ type: 'text', text: '这是回复' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('这是回复'))).toBe(true)
    })
    expect(h.outbound.filter(f => f.action === 'send_msg')).toHaveLength(1)
    expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('"type":"image"'))).toBe(false)
    expect(h.outbound.some(f => f.action === 'delete_msg')).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)
})
