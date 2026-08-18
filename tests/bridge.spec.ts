import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, readdir, realpathSync, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import WebSocket from 'ws'

import { OneBotConnection } from '../src/connection.js'
import { ChatBridge, resolveRecordedPreset } from '../src/bridge.js'
import { MediaStore } from '../src/media.js'
import { Transcriber } from '../src/stt.js'

/** A fake agent handle for the bridge. */
function makeFakeAgents(
  sessionIds: string[],
  captured: { followups: Array<{ text: string; sessionId: string }>; createdMeta?: Array<{ cwd?: string; agentPreset?: string }> },
  opts?: { failCreateFor?: string },
) {
  const agents = {
    create: vi.fn(async (options: { sessionId: string; meta?: { cwd?: string; agentPreset?: string }; setup?: (agentCtx: unknown) => unknown }) => {
      const sessionId = String(options.sessionId)
      sessionIds.push(sessionId)
      captured.createdMeta?.push({ ...options.meta })
      if (opts?.failCreateFor !== undefined && sessionId === opts.failCreateFor) {
        throw new Error('session "' + sessionId + '" already has a persisted log on disk that does not match this live session (id collision)')
      }
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

/** Full bridge + WS harness: inbound via real WebSocket, outbound captured. */
async function makeHarness(opts?: { failCreateFor?: string; mediaDir?: string }) {
  const ctx = new Context()
  const sessionIds: string[] = []
  const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
  const agents = makeFakeAgents(sessionIds, captured, opts)
  const sessions = { flush: vi.fn(async () => undefined) }
  const mediaDir = opts?.mediaDir ?? mkdtempSync(join(tmpdir(), 'onebot-test-'))
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
  return { ctx, sessionIds, captured, sessions, mediaDir, connection, bridge, client, outbound, sendText }
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

    // 3. The retirement is durable: retired-sessions.json records the first
    //    session id, so a restart never reuses it.
    const { readFile } = await import('node:fs/promises')
    await vi.waitFor(async () => {
      const retired = JSON.parse(await readFile(join(mediaDir, 'retired-sessions.json'), 'utf8')) as string[]
      expect(retired).toContain('onebot-private-10001')
    })

    // 4. Restart simulation: a fresh bridge on the same media dir must skip
    //    the retired bare id and open the next message on a new suffixed id.
    const h2 = await makeHarness({ mediaDir })
    h2.sendText('重启后第一条')
    await vi.waitFor(() => expect(h2.captured.followups).toHaveLength(1))
    expect(h2.sessionIds).toHaveLength(1)
    expect(h2.sessionIds[0]).toMatch(/^onebot-private-10001-[a-z0-9]+$/)
    h2.client.close()
    await h2.bridge.stop()
    await h2.connection.stop()

    client.close()
    await bridge.stop()
    await connection.stop()
  })

  it('recovers from a create id collision with a suffixed session and records the truth', async () => {
    const h = await makeHarness({ failCreateFor: 'onebot-private-10001' })
    const { readFile } = await import('node:fs/promises')
    h.sendText('hi')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    // The bare attempt failed synchronously and the fallback succeeded.
    expect(h.sessionIds).toHaveLength(2)
    const fallback = h.sessionIds[1]
    expect(fallback).toMatch(/^onebot-private-10001-[a-z0-9]+$/)
    expect(h.captured.followups[0].sessionId).toBe(fallback)
    // The mapping persists the REAL session id (not the attempted bare one).
    await vi.waitFor(async () => {
      const mapping = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8'))
      expect(mapping['private:10001']).toBe(fallback)
    })
    // The colliding id is retired durably.
    await vi.waitFor(async () => {
      const retired = JSON.parse(await readFile(join(h.mediaDir, 'retired-sessions.json'), 'utf8')) as string[]
      expect(retired).toContain('onebot-private-10001')
    })
    // Session events route to the chat through the REAL id.
    const session = { id: fallback }
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '兜底回复' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('兜底回复'))).toBe(true)
    })
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('persists the retired id when a turn/end reports an id collision', async () => {
    const h = await makeHarness()
    const { readFile } = await import('node:fs/promises')
    h.sendText('hi')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const sessionId = h.sessionIds[0]
    const session = { id: sessionId }
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', {
      turn: 1,
      reason: {
        kind: 'error',
        error: { code: 'E_COLLISION', message: 'session "' + sessionId + '" already has a persisted log on disk that does not match this live session (id collision)' },
      },
    }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('运行出错'))).toBe(true)
    })
    // The colliding id lands in retired-sessions.json and the chat mapping
    // is emptied (the next message will rebuild on a fresh id).
    await vi.waitFor(async () => {
      const retired = JSON.parse(await readFile(join(h.mediaDir, 'retired-sessions.json'), 'utf8')) as string[]
      expect(retired).toContain(sessionId)
    })
    await vi.waitFor(async () => {
      const mapping = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8'))
      expect(Object.keys(mapping)).toHaveLength(0)
    })
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('joins the configured agent preset and attaches the session to its workspace', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = {
      followups: [] as Array<{ text: string; sessionId: string }>,
      createdMeta: [] as Array<{ cwd?: string; agentPreset?: string }>,
    }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })

    const mountedPresets: Array<string | undefined> = []
    const agentPresets = {
      defaultId: 'standard',
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard' })),
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
    // The session header records the resolved preset id (config in this case),
    // so the Web surface can label the session without a second lookup.
    expect(captured.createdMeta[0].agentPreset).toBe('standard')
    // The session was attached to the workspace owning its header cwd
    // (creating the workspace when unowned) instead of landing ungrouped.
    expect(workspaceRegistry.resolveByPath).toHaveBeenCalledWith(mediaDir)
    expect(workspaceRegistry.create).toHaveBeenCalledWith(mediaDir)
    expect(attached[0]).toEqual({ sessionId: sessionIds[0], cwd: mediaDir })

    client.close()
    await bridge.stop()
    await connection.stop()
  })

  it('records the deployment default preset on the header when the config leaves it unset', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = {
      followups: [] as Array<{ text: string; sessionId: string }>,
      createdMeta: [] as Array<{ cwd?: string; agentPreset?: string }>,
    }
    const agents = makeFakeAgents(sessionIds, captured)
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const mountedPresets: Array<string | undefined> = []
    const agentPresets = {
      defaultId: 'router-flash',
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'router-flash' })),
      mount: vi.fn(async (_agentCtx: unknown, id?: string) => {
        mountedPresets.push(id)
        return { id: id ?? 'router-flash' }
      }),
    }
    const bridge = new ChatBridge({
      ctx,
      connection: new OneBotConnection({
        mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
      }),
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: { flush: vi.fn(async () => undefined) } as never,
      agentPresets: agentPresets as never,
      sessionPersistence: undefined,
      workspaceRegistry: undefined as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
        sensitivePatterns: [], mediaDir, maxImageBytes: 8 * 1024 * 1024,
        maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
        agentPreset: '', workspacePath: mediaDir,
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    await (bridge as unknown as { ensureChat(chatId: string, nickname: string): Promise<unknown> })
      .ensureChat('private:10001', '小明')
    // The effective preset (deployment default) was resolved and recorded on
    // the session header even though the plugin config names no preset.
    expect(agentPresets.resolve).toHaveBeenCalledWith('router-flash')
    expect(captured.createdMeta[0].agentPreset).toBe('router-flash')
    // The setup joins the same composition via the default mount path.
    expect(mountedPresets).toEqual([undefined])
    await bridge.stop()
  })

  it('resume rejoins the preset a session recorded, over a conflicting config', async () => {
    const ctx = new Context()
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    await import('node:fs/promises').then(async ({ mkdir, writeFile }) => {
      await mkdir(mediaDir, { recursive: true })
      await writeFile(join(mediaDir, 'chat-sessions.json'), JSON.stringify({ 'private:10001': 'onebot-private-10001' }), 'utf8')
    })
    const mountedPresets: Array<string | undefined> = []
    const logLines: string[] = []
    const agentPresets = {
      defaultId: 'router-flash',
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'router-flash' })),
      mount: vi.fn(async (_agentCtx: unknown, id?: string) => {
        mountedPresets.push(id)
        return { id: id ?? 'router-flash' }
      }),
    }
    const agents = {
      create: vi.fn(),
      resume: vi.fn(async (options: { resumeSessionId: string; setup?: (agentCtx: unknown) => unknown }) => {
        if (typeof options.setup === 'function') await options.setup({ on: () => () => undefined })
        return {
          agent: {
            id: String(options.resumeSessionId),
            session: { id: String(options.resumeSessionId), header: { cwd: mediaDir } },
            whenIdle: async () => undefined,
          },
          dispose: async () => undefined,
        }
      }),
    }
    const sessionPersistence = {
      inspect: vi.fn(async () => ({ meta: { agentPreset: 'router-flash' }, events: [] })),
    }
    const bridge = new ChatBridge({
      ctx,
      connection: new OneBotConnection({
        mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
      }),
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: { flush: vi.fn(async () => undefined) } as never,
      agentPresets: agentPresets as never,
      sessionPersistence: sessionPersistence as never,
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
      log: (level, message) => { logLines.push(level + ': ' + message) },
    })
    await (bridge as unknown as { loadMapping(): Promise<void> }).loadMapping()
    // The session's own record wins over the conflicting plugin config.
    expect(sessionPersistence.inspect).toHaveBeenCalled()
    expect(mountedPresets).toEqual(['router-flash'])
    expect(logLines.some(line => line.includes('records preset router-flash') && line.includes('standard'))).toBe(true)
    await bridge.stop()
  })

  it('resolveRecordedPreset: newest logged selection wins, else the creation header', () => {
    const events = [
      { type: 'user/message', data: { content: [] } },
      { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } },
      { type: 'agent-preset/selected', data: { agentPreset: 'router-flash' } },
    ]
    expect(resolveRecordedPreset({ meta: { agentPreset: 'standard' }, events })).toBe('router-flash')
    expect(resolveRecordedPreset({ meta: { agentPreset: 'standard' }, events: [] })).toBe('standard')
    expect(resolveRecordedPreset({ meta: {}, events: [] })).toBeUndefined()
  })

  it('ensureChat avoids a bare id that still owns a persisted log (stale retiring lost)', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = {
      followups: [] as Array<{ text: string; sessionId: string }>,
      createdMeta: [] as Array<{ cwd?: string; agentPreset?: string }>,
    }
    const agents = makeFakeAgents(sessionIds, captured)
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const inspect = vi.fn(async (id: string) => {
      if (id === 'onebot-private-10001') return { meta: {}, events: [] }
      throw new Error('no such session')
    })
    const agentPresets = {
      defaultId: 'router-flash',
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'router-flash' })),
      mount: vi.fn(async (_agentCtx: unknown, id?: string) => ({ id: id ?? 'router-flash' })),
    }
    const bridge = new ChatBridge({
      ctx,
      connection: new OneBotConnection({
        mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
      }),
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: { flush: vi.fn(async () => undefined) } as never,
      agentPresets: agentPresets as never,
      sessionPersistence: { inspect } as never,
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
        agentPreset: '', workspacePath: mediaDir,
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    await (bridge as unknown as { ensureChat(chatId: string, nickname: string): Promise<unknown> })
      .ensureChat('private:10001', '小明')
    // The bare id owns a stale log: the chat must NOT reuse it — it retires
    // the bare id and creates on a suffixed id instead of failing later.
    expect(inspect).toHaveBeenCalled()
    expect(sessionIds[0]).toMatch(/^onebot-private-10001-[a-z0-9]+$/)
    expect(sessionIds[0]).not.toBe('onebot-private-10001')
    const retired = (bridge as unknown as { retiredSessionIds: string[] }).retiredSessionIds
    expect(retired).toContain('onebot-private-10001')
    await bridge.stop()
  })

  it('resetChat retires the bare derived id alongside the current session id', async () => {
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const bridge = new ChatBridge({
      ctx,
      connection: new OneBotConnection({
        mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
      }),
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: { flush: vi.fn(async () => undefined) } as never,
      agentPresets: {
        defaultId: 'router-flash',
        resolve: vi.fn(async (id?: string) => ({ id: id ?? 'router-flash' })),
        mount: vi.fn(async (_agentCtx: unknown, id?: string) => ({ id: id ?? 'router-flash' })),
      } as never,
      sessionPersistence: {
        inspect: vi.fn(async () => { throw new Error('no such session') }),
      } as never,
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
        agentPreset: '', workspacePath: mediaDir,
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    const chat = await (bridge as unknown as { ensureChat(chatId: string, nickname: string): Promise<unknown> })
      .ensureChat('private:10001', '小明')
    // First session of the chat: no stale log, so it legitimately uses the
    // bare id. /new then retires the bare id as well, so any restart cannot
    // rebuild it on a colliding id.
    expect(String((chat as { sessionId: string }).sessionId)).toBe('onebot-private-10001')
    await (bridge as unknown as { resetChat(chatId: string): Promise<void> }).resetChat('private:10001')
    const retired = (bridge as unknown as { retiredSessionIds: string[] }).retiredSessionIds
    expect(retired).toContain('onebot-private-10001')
    await bridge.stop()
  })

  it('loadRetired keeps the current set on a corrupt file and saves atomically', async () => {
    await vi.waitFor(() => expect(1).toBe(1))
    const ctx = new Context()
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    await mkdir(mediaDir, { recursive: true })
    await writeFile(join(mediaDir, 'retired-sessions.json'), '{not json', 'utf8')
    const logLines: string[] = []
    const bridge = new ChatBridge({
      ctx,
      connection: new OneBotConnection({
        mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
      }),
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: { create: vi.fn(), resume: vi.fn() } as never,
      sessions: { flush: vi.fn() } as never,
      agentPresets: undefined as never,
      sessionPersistence: undefined,
      workspaceRegistry: undefined as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
        sensitivePatterns: [], mediaDir, maxImageBytes: 8 * 1024 * 1024,
        maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
        agentPreset: '', workspacePath: mediaDir,
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: (level, message) => { logLines.push(level + ': ' + message) },
    })
    await (bridge as unknown as { loadRetired(): Promise<void> }).loadRetired()
    const logLinesSnapshot = [...logLines]
    const retiredIds = (bridge as unknown as { retiredSessionIds: string[] }).retiredSessionIds
    const retiredSnapshot = [...retiredIds]
    // Corrupt JSON must NOT be treated as an empty retired set (the 2026-08-17
    // regression): the load warns, keeps the in-memory array, and later saves
    // atomically (temp + rename, no half-written file).
    // (Assertions run inside waitFor: vitest 3.2.7's matcher state is only
    // reliably re-bound inside its polling/async callbacks.)
    await vi.waitFor(() => {
      expect(logLinesSnapshot.some(line => line.startsWith('warn') && line.includes('unparsable'))).toBe(true)
      expect(JSON.stringify(retiredSnapshot)).toBe('[]')
    })
    // Atomic save: retire one id, then the file holds exactly it and no .tmp.
    // (Leading `;` guards against ASI joining this `(bridge...)` line onto the
    // waitFor statement above — the result would be waitFor(cb)(...) called.)
    ;(bridge as unknown as { retireSession(id: string): void }).retireSession('onebot-private-10001')
    await vi.waitFor(async () => {
      const content = await readFile(join(mediaDir, 'retired-sessions.json'), 'utf8')
      expect(content).toContain('onebot-private-10001')
    })
    const files = await readdir(mediaDir)
    await vi.waitFor(() => {
      expect(files.some(f => f.endsWith('.tmp'))).toBe(false)
    })
    await bridge.stop()
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

  it('dedupes duplicate assistant/message events for the same message id', async () => {
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
    await vi.waitFor(() => {
      expect(outbound.filter(f => f.action === 'send_private_forward_msg')).toHaveLength(1)
    })
    const fwd = outbound.find(f => f.action === 'send_private_forward_msg')!
    const params = fwd.params as { messages: Array<{ data: { content: Array<{ data: { text: string } }> } }> }
    expect(params.messages).toHaveLength(2)
    expect(params.messages[0].data.content[0].data.text).toBe('第一条：查资料')
    expect(params.messages[1].data.content[0].data.text).toBe('第二条：总结')
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

  /** Compact harness for the slash-command tests (options inject stubs). */
  async function makeCmdHarness(opts?: {
    agentPresets?: unknown
    dshHome?: string
    ocrResult?: unknown
    interimMessages?: boolean
  }) {
    const ctx = new Context()
    const sessionIds: string[] = []
    const capturedMeta: Array<{ cwd?: string; agentPreset?: string }> = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }>, createdMeta: capturedMeta }
    const agents = makeFakeAgents(sessionIds, captured)
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx,
      connection,
      dshHome: opts?.dshHome,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: sessions as never,
      agentPresets: opts?.agentPresets as never,
      workspaceRegistry: undefined as never,
      agentDefaultModel: undefined,
      defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
        interimMessages: opts?.interimMessages ?? true, sendErrorNotice: true, restrictedMemberPrefix: false,
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
    if (opts?.ocrResult !== undefined) {
      const real = connection.call.bind(connection)
      connection.call = (async (action: string, params: unknown) => {
        if (action === 'ocr_image') return opts.ocrResult
        return await real(action, params)
      }) as never
    }
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
    const chats = () => (bridge as unknown as {
      chats: Map<string, { agent: { session: { id: string } }, lastFollowup: string | undefined, busy: boolean }>
    }).chats
    return { ctx, sessionIds, capturedMeta, captured, sessions, mediaDir, connection, bridge, client, outbound, sendText, chats }
  }

  it('slash /id /ver /status report the session state', async () => {
    const h = await makeCmdHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))

    h.sendText('/id')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('chat    : private:10001'))).toBe(true)
    })

    h.sendText('/ver')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('dsh-onebot v'))).toBe(true)
    })

    h.sendText('/status')
    await vi.waitFor(() => {
      const joined = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
      expect(joined).toContain('chat    : private:10001')
      expect(joined).toContain('model   : deepseek/deepseek-chat')
      expect(joined).toContain('preset  : （未记录）')
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('slash /goal /plan /mode set per-chat state and prefix turns', async () => {
    const h = await makeCmdHarness()

    h.sendText('/goal 验证 9 个命令')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('目标已记录'))).toBe(true)
    })
    h.sendText('普通消息')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('【当前目标】验证 9 个命令')

    h.sendText('/plan on')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('计划模式已开启'))).toBe(true)
    })
    h.sendText('再来一轮')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].text).toContain('【计划模式】')
    expect(h.captured.followups[1].text).toContain('再来一轮')

    h.sendText('/plan 写一个新模块')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))
    expect(h.captured.followups[2].text).toContain('【计划模式】')
    expect(h.captured.followups[2].text).toContain('写一个新模块')

    h.sendText('/plan off')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('计划模式已关闭'))).toBe(true)
    })
    h.sendText('没有计划了')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(4))
    expect(h.captured.followups[3].text).not.toContain('【计划模式】')

    h.sendText('/mode instant')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已切换为 instant'))).toBe(true)
    })
    h.sendText('/mode')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('instant（逐条即时）（/mode 覆盖）'))).toBe(true)
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('slash /retry re-feeds the last user message; /new clears it', async () => {
    const h = await makeCmdHarness()
    h.sendText('第一次的问题')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('第一次的问题')

    h.sendText('/retry')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].text).toContain('第一次的问题')
    expect(h.captured.followups[1].sessionId).toBe(h.captured.followups[0].sessionId)

    // /new retires the chat agent; /retry then reports nothing to retry.
    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })
    h.sendText('/retry')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('没有可重试'))).toBe(true)
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('slash /preset switches the agent preset for the next session', async () => {
    const resolve = vi.fn(async (id?: string) => {
      if (id === 'standard' || id === 'router-flash') return { id: id ?? 'standard' }
      throw new Error('unknown preset ' + id)
    })
    const h = await makeCmdHarness({
      agentPresets: { defaultId: 'standard', resolve, mount: vi.fn(async () => ({ id: 'router-flash' })) },
    })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.capturedMeta[0].agentPreset).toBe('standard')

    h.sendText('/preset')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('当前预设：standard'))).toBe(true)
    })

    h.sendText('/preset router-flash')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('预设已切换：router-flash'))).toBe(true)
    })
    expect(h.chats().has('private:10001')).toBe(false)

    h.sendText('下一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.capturedMeta[1].agentPreset).toBe('router-flash')

    h.sendText('/preset nope')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('预设不存在'))).toBe(true)
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('slash /ocr recognizes the most recent inbound image', async () => {
    const h = await makeCmdHarness({ ocrResult: { texts: [{ text: '第一行文字' }, { text: '第二行文字' }] } })

    // No image yet → friendly prompt.
    h.sendText('/ocr')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('请先在对话里发一张图片'))).toBe(true)
    })

    // Seed a fake image path and OCR it (ocr_image stubbed above).
    const png = join(h.mediaDir, 'seed.png')
    await writeFile(png, Buffer.from('89504e470d0a1a0a', 'hex'))
    ;(h.bridge as unknown as { chatLastImagePaths: Map<string, string> }).chatLastImagePaths.set('private:10001', png)
    h.sendText('/ocr')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('第一行文字'))).toBe(true)
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('第二行文字'))).toBe(true)
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('restores the /workspace override from a resumed session cwd (方案 B)', async () => {
    const ctx = new Context()
    const sessions = { flush: vi.fn(async () => undefined) }
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const otherDir = mkdtempSync(join(tmpdir(), 'onebot-other-'))
    await writeFile(join(mediaDir, 'chat-sessions.json'), JSON.stringify({ 'private:10001': 'onebot-private-10001-aabbcc' }), 'utf8')
    const resume = vi.fn(async () => ({
      agent: {
        session: { id: 'onebot-private-10001-aabbcc', seq: 1, header: { cwd: otherDir } },
        status: 'idle',
        cancel: () => undefined,
        followup: () => undefined,
        whenIdle: async () => undefined,
      },
      dispose: async () => undefined,
    }))
    const agents = { create: vi.fn(), resume } as never
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: '', callTimeoutMs: 3_000,
    })
    const bridge = new ChatBridge({
      ctx,
      connection,
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents,
      sessions: sessions as never,
      agentPresets: undefined as never,
      workspaceRegistry: undefined as never,
      agentDefaultModel: undefined,
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
    bridge.start()
    const overrides = () => (bridge as unknown as { chatWorkspacePaths: Map<string, string> }).chatWorkspacePaths
    // Resume carried a non-default cwd → the override map must be restored.
    await vi.waitFor(() => expect(overrides().get('private:10001')).toBe(otherDir))
    // A chat whose session cwd equals the configured default must NOT get an override.
    const { realpathSync } = await import('node:fs')
    await writeFile(join(mediaDir, 'chat-sessions.json'), JSON.stringify({ 'private:10001': 'onebot-private-10001-zzzz' }), 'utf8')
    const bridge2Dir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    await writeFile(join(bridge2Dir, 'chat-sessions.json'), JSON.stringify({ 'private:10002': 'onebot-private-10002-zzzz' }), 'utf8')
    const resume2 = vi.fn(async () => ({
      agent: { session: { id: 'onebot-private-10002-zzzz', seq: 1, header: { cwd: realpathSync(bridge2Dir) } }, status: 'idle', cancel: () => undefined, followup: () => undefined, whenIdle: async () => undefined },
      dispose: async () => undefined,
    }))
    const ctx2 = new Context()
    const bridge2 = new ChatBridge({
      ctx: ctx2,
      connection: new OneBotConnection({ mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3002', accessToken: '', callTimeoutMs: 3_000 }),
      media: new MediaStore(join(bridge2Dir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: { create: vi.fn(), resume: resume2 } as never,
      sessions: { flush: vi.fn(async () => undefined) } as never,
      agentPresets: undefined as never,
      workspaceRegistry: undefined as never,
      agentDefaultModel: undefined,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
        sensitivePatterns: [], mediaDir: bridge2Dir, maxImageBytes: 8 * 1024 * 1024,
        maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
        agentPreset: 'standard', workspacePath: realpathSync(bridge2Dir),
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    bridge2.start()
    await vi.waitFor(() => expect((bridge2 as unknown as { chatWorkspacePaths: Map<string, string> }).chatWorkspacePaths.get('private:10002')).toBeUndefined())
    await bridge.stop()
    await bridge2.stop()
    await connection.stop()
  })

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
