import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import WebSocket from 'ws'

import { OneBotConnection } from '../src/connection.js'
import { ChatBridge } from '../src/bridge.js'
import { MediaStore } from '../src/media.js'
import { Transcriber } from '../src/stt.js'

/** A fake agent handle for the bridge. */
function makeFakeAgents(sessionIds: string[], captured: { followups: Array<{ text: string; sessionId: string }> }) {
  const agents = {
    create: vi.fn(async (options: { sessionId: string; meta?: { cwd?: string }; setup?: (agentCtx: unknown) => unknown }) => {
      const sessionId = String(options.sessionId)
      sessionIds.push(sessionId)
      const agent = {
        session: { id: sessionId, seq: 0, header: { cwd: options.meta?.cwd ?? process.cwd() } },
        status: 'idle',
        cancel: () => { agent.status = 'idle' },
        followup: (message: { content: Array<{ type: string; text?: string }> }) => {
          const text = message.content.map(b => b.text ?? '').join('')
          captured.followups.push({ text, sessionId })
        },
        whenIdle: async () => undefined,
      }
      if (typeof options.setup === 'function') {
        await options.setup({ on: () => () => undefined })
      }
      return { agent, dispose: async () => undefined }
    }),
    resume: vi.fn(async () => {
      throw new Error('not persisted')
    }),
  }
  return agents
}

function makeEvent(type: string, data: unknown): SessionEvent {
  return { seq: 0, time: Date.now(), type: type as never, data: data as never } as SessionEvent
}

describe('ChatBridge', () => {
  it('runs the full inbound→agent→outbound pipeline', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })

    const bridge = new ChatBridge({
      ctx,
      connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
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
    connection.onMessage = event => {
      void bridge.handleInbound(event)
    }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))

    // Respond to every action so pending calls resolve.
    const outbound: Array<Record<string, unknown>> = []
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      outbound.push(frame)
      if (typeof frame.echo === 'string') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
      }
    })

    // 1. Inbound DM from the admin user.
    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'text', data: { text: '你好，帮我看看这个' } }],
      raw_message: '你好，帮我看看这个',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(captured.followups).toHaveLength(1))
    expect(captured.followups[0].text).toBe('你好，帮我看看这个')
    const sessionId = sessionIds[0]

    // 2. Assistant message → deferred one step; turn end settles it as the
    //    final outbound send_msg with the text.
    const session = { id: sessionId }
    ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '这是回复' }] },
    }))
    ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('这是回复'))).toBe(true)
    })
    const sent = outbound.find(f => f.action === 'send_msg')!
    expect(sent.params).toMatchObject({ user_id: 10001 })

    // 3. Turn end → session flush + typing stop.
    await vi.waitFor(() => expect(sessions.flush).toHaveBeenCalled())

    client.close()
    await bridge.stop()
    await connection.stop()
  })

  it('buffers interim text when interimMessages is off and sends only the final step', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
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
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
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

  it('renders a t2i card for long replies (image segment)', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
        sensitivePatterns: [], mediaDir, maxImageBytes: 8 * 1024 * 1024,
        maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        textImageThreshold: 10, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    connection.onMessage = event => { void bridge.handleInbound(event) }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
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
    const longText = '这是一段非常长的回复内容，长度超过了阈值十，因此应该渲染成文字图卡片发送，而不是分段文本。'.repeat(2)
    ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
    }))
    ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('base64://'))).toBe(true)
    })
    const imageFrame = outbound.find(f => f.action === 'send_msg')!
    const segments = imageFrame.params.message as Array<{ type: string }>
    expect(segments.some(s => s.type === 'image')).toBe(true)
    client.close()
    await bridge.stop()
    await connection.stop()
  }, 60_000)

  it('falls back to text chunks when the card exceeds maxImageBytes', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
        sensitivePatterns: [], mediaDir, maxImageBytes: 500,
        maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        textImageThreshold: 10, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    connection.onMessage = event => { void bridge.handleInbound(event) }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
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
    const longText = '这是一段非常长的回复内容，图片超限，应该回退为分段文本发送。'.repeat(2)
    ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
    }))
    ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params.message).includes('分段文本'))).toBe(true)
    })
    const textFrame = outbound.find(f => f.action === 'send_msg')!
    const segments = textFrame.params.message as Array<{ type: string }>
    expect(segments.some(s => s.type === 'text')).toBe(true)
    expect(outbound.some(f => JSON.stringify(f.params).includes('base64://'))).toBe(false)
    client.close()
    await bridge.stop()
    await connection.stop()
  }, 60_000)

  it('routes slash commands before the model: /new opens a fresh session', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
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
    connection.onMessage = event => { void bridge.handleInbound(event) }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const outbound: Array<Record<string, unknown>> = []
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      outbound.push(frame)
      if (typeof frame.echo === 'string') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
      }
    })
    const send = (text: string): void => {
      client.send(JSON.stringify({
        post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
        message: [{ type: 'text', data: { text } }], raw_message: text,
        sender: { user_id: 10001, nickname: '小明' },
      }))
    }
    send('你好')
    await vi.waitFor(() => expect(captured.followups).toHaveLength(1))
    const oldSession = sessionIds[0]
    send('/new')
    await vi.waitFor(() => {
      expect(outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })
    expect(captured.followups).toHaveLength(1) // /new never reaches the model
    send('第二条')
    await vi.waitFor(() => expect(captured.followups).toHaveLength(2))
    expect(captured.followups[1].sessionId).not.toBe(oldSession)
    client.close()
    await bridge.stop()
    await connection.stop()
  }, 60_000)

  it('routes slash commands before the model: /stop cancels, unknown goes to the model', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
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
    connection.onMessage = event => { void bridge.handleInbound(event) }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const outbound: Array<Record<string, unknown>> = []
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      outbound.push(frame)
      if (typeof frame.echo === 'string') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
      }
    })
    const send = (text: string): void => {
      client.send(JSON.stringify({
        post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
        message: [{ type: 'text', data: { text } }], raw_message: text,
        sender: { user_id: 10001, nickname: '小明' },
      }))
    }
    send('启动任务')
    await vi.waitFor(() => expect(captured.followups).toHaveLength(1))
    // Mark the agent running, then /stop must cancel it.
    const agent = (bridge as unknown as { chats: Map<string, { agent: { status: string; cancel: (c: unknown) => void } }> }).chats.get('private:10001')?.agent
    expect(agent).toBeDefined()
    agent!.status = 'running'
    send('/stop')
    await vi.waitFor(() => {
      expect(outbound.some(f => JSON.stringify(f.params).includes('已停止生成'))).toBe(true)
    })
    expect(agent!.status).toBe('idle')
    expect(captured.followups).toHaveLength(1)
    // Unknown commands fall through to the model.
    send('/unknowncmd 参数')
    await vi.waitFor(() => expect(captured.followups).toHaveLength(2))
    expect(captured.followups[1].text).toContain('/unknowncmd')
    // A path is not a command.
    send('请查看 /tmp/x 文件')
    await vi.waitFor(() => expect(captured.followups).toHaveLength(3))
    client.close()
    await bridge.stop()
    await connection.stop()
  }, 60_000)

  it('blocks slash commands for non-admin users', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
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
    connection.onMessage = event => { void bridge.handleInbound(event) }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const outbound: Array<Record<string, unknown>> = []
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      outbound.push(frame)
      if (typeof frame.echo === 'string') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
      }
    })
    // Group message from a non-admin member, @-mentioning the bot, with /help.
    client.send(JSON.stringify({
      post_type: 'message', message_type: 'group', user_id: 20002, group_id: 888, self_id: 10002,
      message: [
        { type: 'at', data: { qq: '10002' } },
        { type: 'text', data: { text: '/help' } },
      ],
      raw_message: '[CQ:at,qq=10002]/help',
      sender: { user_id: 20002, nickname: '路人' },
    }))
    await vi.waitFor(() => {
      expect(outbound.some(f => JSON.stringify(f.params).includes('仅管理员可用'))).toBe(true)
    })
    expect(captured.followups).toHaveLength(0)
    client.close()
    await bridge.stop()
    await connection.stop()
  }, 60_000)

  it('preserves the chat mapping across stop()', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
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
    connection.onMessage = event => { void bridge.handleInbound(event) }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
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
    await bridge.stop()
    const { readFile } = await import('node:fs/promises')
    const mapping = JSON.parse(await readFile(join(mediaDir, 'chat-sessions.json'), 'utf8'))
    expect(mapping['private:10001']).toBe(sessionIds[0])
    await connection.stop()
  })

  it('sends an error notice on a failed turn', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
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
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
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
    ctx.emit('session/event', session as never, makeEvent('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'E_TEST', message: '模型炸了' } },
    }))
    await vi.waitFor(() => {
      expect(outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('运行出错'))).toBe(true)
    })
    client.close()
    await bridge.stop()
    await connection.stop()
  })

  it('slash /new retires the chat agent and starts a fresh session on the next message', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })

    const bridge = new ChatBridge({
      ctx,
      connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      agentPresets: undefined as never,
      workspaceRegistry: undefined as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
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
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const outbound: Array<Record<string, unknown>> = []
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      outbound.push(frame)
      if (typeof frame.echo === 'string') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
      }
    })
    const sendText = (text: string): void => {
      client.send(JSON.stringify({
        post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
        message: [{ type: 'text', data: { text } }], raw_message: text,
        sender: { user_id: 10001, nickname: '小明' },
      }))
    }

    // 1. Normal message lands on the first session.
    sendText('你好')
    await vi.waitFor(() => expect(captured.followups).toHaveLength(1))
    expect(sessionIds).toHaveLength(1)

    // 2. /new must NOT reach the agent; a confirmation is sent directly and
    //    the next message starts a fresh (suffixed) session.
    sendText('/new')
    await vi.waitFor(() => expect(outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('已开启新会话'))).toBe(true))
    await vi.waitFor(() => expect(captured.followups).toHaveLength(1))
    sendText('新对话的第一条')
    await vi.waitFor(() => expect(captured.followups).toHaveLength(2))
    expect(sessionIds).toHaveLength(2)
    expect(sessionIds[1]).toMatch(/^onebot-private-10001-[a-z0-9]+$/)

    client.close()
    await bridge.stop()
    await connection.stop()
  })

  it('joins the configured agent preset and attaches the session to its workspace', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })

    const mountedPresets: Array<string | undefined> = []
    const agentPresets = {
      mount: vi.fn(async (_agentCtx: unknown, id?: string) => {
        mountedPresets.push(id)
        return { id: id ?? 'standard' }
      }),
    }
    const attached: Array<{ sessionId: string; cwd: string }> = []
    const workspaceRegistry = {
      resolveByPath: vi.fn(async () => undefined),
      create: vi.fn(async (path: string) => ({
        attachSession: vi.fn(async (sessionId: string) => { attached.push({ sessionId, cwd: path }) }),
      })),
    }

    const bridge = new ChatBridge({
      ctx,
      connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      agentPresets: agentPresets as never,
      workspaceRegistry: workspaceRegistry as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
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
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
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
    await vi.waitFor(() => expect(attached).toHaveLength(1))

    // The agent joined the configured preset (standard), so its tools resolve
    // against the preset composition instead of the empty global layer.
    expect(mountedPresets).toEqual(['standard'])
    // The session was attached to the workspace owning its header cwd
    // (creating the workspace when unowned) instead of landing ungrouped.
    expect(workspaceRegistry.resolveByPath).toHaveBeenCalledWith(mediaDir)
    expect(workspaceRegistry.create).toHaveBeenCalledWith(mediaDir)
    expect(attached[0]).toEqual({ sessionId: sessionIds[0], cwd: mediaDir })

    client.close()
    await bridge.stop()
    await connection.stop()
  })

  it('does not auto-create a workspace for a session whose cwd differs from workspacePath', async () => {
    const ctx = new Context()
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })
    const attached: string[] = []
    const workspaceRegistry = {
      resolveByPath: vi.fn(async () => undefined),
      create: vi.fn(async () => {
        throw new Error('create must not be called for a foreign cwd')
      }),
    }
    const bridge = new ChatBridge({
      ctx,
      connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: { create: vi.fn(), resume: vi.fn() } as never,
      sessions: { flush: vi.fn() } as never,
      agentPresets: undefined as never,
      workspaceRegistry: workspaceRegistry as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
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
    // A resumed legacy session may carry a cwd that predates workspacePath
    // (e.g. an earlier host cwd): it must NOT spawn a workspace of its own.
    const method = (bridge as unknown as {
      attachToWorkspace(sessionId: string, headerCwd: string | undefined): Promise<void>
    })
    await method.attachToWorkspace('onebot-legacy-session', '/home/user/.hermes/workspace')
    expect(workspaceRegistry.resolveByPath).toHaveBeenCalledWith('/home/user/.hermes/workspace')
    expect(workspaceRegistry.create).not.toHaveBeenCalled()
    expect(attached).toHaveLength(0)
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
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
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
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
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
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))

    // Respond to every action so pending calls resolve.
    const outbound: Array<Record<string, unknown>> = []
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      outbound.push(frame)
      if (typeof frame.echo === 'string') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
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

    // Settlement order on the chain: merged forward first, then the final
    // text, then the originals recalled.
    await vi.waitFor(() => {
      expect(outbound.filter(f => f.action === 'send_private_forward_msg')).toHaveLength(1)
    })
    const fwd = outbound.find(f => f.action === 'send_private_forward_msg')!
    const params = fwd.params as { messages: Array<{ data: { content: Array<{ data: { text: string } }> } }> }
    expect(params.messages).toHaveLength(2)
    expect(params.messages[0].data.content[0].data.text).toBe('第一步：先查资料')
    expect(params.messages[1].data.content[0].data.text).toBe('第二步：找到了，开始总结')
    const fwdIdx = outbound.findIndex(f => f.action === 'send_private_forward_msg')

    // Final text delivered after the forward.
    await vi.waitFor(() => {
      expect(outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('第三步'))).toBe(true)
    })
    const finalIdx = outbound.findIndex(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('第三步'))
    expect(finalIdx).toBeGreaterThan(fwdIdx)

    // Originals recalled last, after the final text.
    await vi.waitFor(() => {
      expect(outbound.filter(f => f.action === 'delete_msg')).toHaveLength(2)
    })
    const delIdx = outbound.findIndex(f => f.action === 'delete_msg')
    expect(delIdx).toBeGreaterThan(finalIdx)

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
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
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
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
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
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
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
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
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
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
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
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
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

  it('slash /model shows the current model and switches with provider/model', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })
    const saveSelection = vi.fn(async () => undefined)
    ;(ctx as unknown as { agentDefaultModel: unknown }).agentDefaultModel = {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      saveSelection,
    }
    ;(ctx as unknown as { llm: unknown }).llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-chat' }, { provider: 'deepseek', id: 'deepseek-reasoner' }],
    }
    const bridge = new ChatBridge({
      ctx, connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      agentPresets: { mount: vi.fn(async () => ({ id: 'standard' })) } as never,
      workspaceRegistry: {
        resolveByPath: vi.fn(async () => undefined),
        create: vi.fn(async () => ({ id: 'w1', path: mediaDir, sessionIds: [], attachSession: vi.fn(async () => undefined) })),
        list: vi.fn(() => []),
      } as never,
      agentDefaultModel: (ctx as unknown as { agentDefaultModel: never }).agentDefaultModel as never,
      defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
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
    connection.onMessage = event => { void bridge.handleInbound(event) }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const outbound: Array<Record<string, unknown>> = []
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      outbound.push(frame)
      if (typeof frame.echo === 'string') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
      }
    })
    const sendText = (text: string): void => {
      client.send(JSON.stringify({
        post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
        message: [{ type: 'text', data: { text } }], raw_message: text,
        sender: { user_id: 10001, nickname: '小明' },
      }))
    }

    sendText('你好')
    await vi.waitFor(() => expect(captured.followups).toHaveLength(1))
    const chat = (bridge as unknown as { chats: Map<string, { agent: { session: { id: string } }, selectionRef: { current: { provider: string; model: string } } | undefined }> }).chats.get('private:10001')!

    // 1. /model without args shows the current model and provider catalog.
    sendText('/model')
    await vi.waitFor(() => {
      expect(outbound.some(f => JSON.stringify(f.params).includes('当前模型：deepseek/deepseek-chat'))).toBe(true)
    })

    // 2. /model provider model switches the live selection and persists it.
    sendText('/model deepseek deepseek-reasoner')
    await vi.waitFor(() => {
      expect(outbound.some(f => JSON.stringify(f.params).includes('已切换模型：deepseek/deepseek-reasoner'))).toBe(true)
    })
    expect(chat.selectionRef?.current).toMatchObject({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'deepseek', model: 'deepseek-reasoner' })

    // 3. Unknown model for a provider is rejected with the catalog.
    sendText('/model deepseek no-such-model')
    await vi.waitFor(() => {
      expect(outbound.some(f => JSON.stringify(f.params).includes('没有模型 no-such-model'))).toBe(true)
    })

    client.close()
    await bridge.stop()
    await connection.stop()
  })

  it('slash /workspace switches the directory for the next session', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const otherDir = mkdtempSync(join(tmpdir(), 'onebot-other-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
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
        create: vi.fn(async () => ({ id: 'w1', path: mediaDir, sessionIds: [], attachSession: vi.fn(async () => undefined) })),
        list: vi.fn(() => []),
      } as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
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
    connection.onMessage = event => { void bridge.handleInbound(event) }
    bridge.start()
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const outbound: Array<Record<string, unknown>> = []
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      outbound.push(frame)
      if (typeof frame.echo === 'string') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
      }
    })
    const sendText = (text: string): void => {
      client.send(JSON.stringify({
        post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
        message: [{ type: 'text', data: { text } }], raw_message: text,
        sender: { user_id: 10001, nickname: '小明' },
      }))
    }

    // 1. First session is created under the configured workspacePath.
    sendText('你好')
    await vi.waitFor(() => expect(captured.followups).toHaveLength(1))
    expect(sessionIds).toHaveLength(1)

    // 2. /workspace <dir> switches, retires the current agent, and the next
    //    message creates a fresh session under the new directory.
    sendText('/workspace ' + otherDir)
    await vi.waitFor(() => {
      expect(outbound.some(f => JSON.stringify(f.params).includes('工作区已切换'))).toBe(true)
    })
    sendText('新工作区的第一条')
    await vi.waitFor(() => expect(captured.followups).toHaveLength(2))
    expect(sessionIds).toHaveLength(2)
    const chats = (bridge as unknown as { chats: Map<string, { agent: { session: { header: { cwd: string } } } }> }).chats
    // The bridge stores the realpath'd directory; macOS /var is a symlink to
    // /private/var, so normalize the expectation the same way.
    const { realpathSync } = await import('node:fs')
    expect(chats.get('private:10001')!.agent.session.header.cwd).toBe(realpathSync(otherDir))

    // 3. Invalid path is rejected.
    sendText('/workspace /nonexistent/definitely/not/here')
    await vi.waitFor(() => {
      expect(outbound.some(f => JSON.stringify(f.params).includes('目录无效'))).toBe(true)
    })
    expect(chats.get('private:10001')!.agent.session.header.cwd).toBe(realpathSync(otherDir))

    client.close()
    await bridge.stop()
    await connection.stop()
  })
})
