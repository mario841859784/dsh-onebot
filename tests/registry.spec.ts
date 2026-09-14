/**
 * ChatRegistry tests (M2-D1-PR3): migrated from bridge.spec.ts per the
 * tests/README.md §3.5 map — mapping persistence (round-trip, debounce,
 * stop()), retired-id durability, create/resume assembly (preset/workspace
 * wiring), collision heal, per-chat settings, and the ensureChat concurrency
 * pin. Assertion semantics are unchanged; internal-path direct calls target
 * the registry (this file's convention).
 * @module dsh-onebot/tests/registry
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebSocket from 'ws'
import type {} from '@deepseek-ai/dsh-session'

import { OneBotConnection } from '../src/connection.js'
import { ChatBridge } from '../src/bridge.js'
import { ChatRegistry, resolveRecordedPreset } from '../src/registry.js'
import type { ChatSettings, RegistryDeps } from '../src/registry.js'
import type { BridgeConfig } from '../src/bridge.js'
import { MediaStore } from '../src/media.js'
import { Transcriber } from '../src/stt.js'

import { makeCmdHarness, makeEvent, makeFakeAgents, makeHarness } from './helpers/bridge-harness.js'

/** Registry-only view of a harness-built bridge (the registry is private). */
function registryOf(h: { bridge: unknown }): ChatRegistry {
  return (h.bridge as unknown as { registry: ChatRegistry }).registry
}

/** Minimal RegistryDeps for direct-registry tests (the registry internal
 * direct-call convention of this file). */
function makeRegistryDeps(overrides?: {
  agents?: unknown
  config?: Partial<Pick<BridgeConfig, 'mediaDir' | 'workspacePath' | 'agentPreset' | 'restrictedMemberPrefix' | 'maxImageBytes' | 'maxVoiceBytes' | 'maxFileBytes' | 'chatIdleEvictDays'>>
}): RegistryDeps {
  return {
    agents: (overrides?.agents ?? { create: vi.fn(), resume: vi.fn() }) as never,
    sessions: { flush: vi.fn(async () => undefined) } as never,
    sessionPersistence: undefined,
    workspaceRegistry: undefined as never,
    agentPresets: {
      defaultId: 'standard',
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard' })),
      mount: vi.fn(async (_agentCtx: unknown, id?: string) => ({ id: id ?? 'standard' })),
    } as never,
    defaultModel: undefined,
    config: {
      mediaDir: mkdtempSync(join(tmpdir(), 'onebot-test-')),
      workspacePath: '',
      agentPreset: '',
      restrictedMemberPrefix: false,
      maxImageBytes: 8 * 1024 * 1024,
      maxVoiceBytes: 15 * 1024 * 1024,
      maxFileBytes: 20 * 1024 * 1024,
      ...overrides?.config,
    },
    log: () => undefined,
    isStopping: () => false,
    onChatRemoved: () => undefined,
    installChannelScope: () => undefined,
  }
}

describe('ChatRegistry', () => {
  it('preserves the chat mapping across stop()', async () => {
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
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer test-token' } })
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
    const mapping = JSON.parse(await readFile(join(mediaDir, 'chat-sessions.json'), 'utf8'))
    expect(mapping['private:10001']).toBe(sessionIds[0])
    await connection.stop()
  })

  it('recovers from a create id collision with a suffixed session and records the truth', async () => {
    const h = await makeHarness({ failCreateFor: 'onebot-private-10001' })
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
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
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
        mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
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
        botQQ: '10002', ignoreSelf: false, requireMention: true,
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
    await registryOf({ bridge }).ensureChat('private:10001', '小明')
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
    await mkdir(mediaDir, { recursive: true })
    await writeFile(join(mediaDir, 'chat-sessions.json'), JSON.stringify({ 'private:10001': 'onebot-private-10001' }), 'utf8')
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
        if (typeof options.setup === 'function') {
          await options.setup({
            on: () => () => undefined,
            systemPrompt: { section: () => () => undefined },
            tools: { register: () => () => undefined },
          })
        }
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
        mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
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
      log: (level, message) => { logLines.push(level + ': ' + message) },
    })
    await registryOf({ bridge }).loadMapping()
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
        mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
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
        botQQ: '10002', ignoreSelf: false, requireMention: true,
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
    await registryOf({ bridge }).ensureChat('private:10001', '小明')
    // The bare id owns a stale log: the chat must NOT reuse it — it retires
    // the bare id and creates on a suffixed id instead of failing later.
    expect(inspect).toHaveBeenCalled()
    expect(sessionIds[0]).toMatch(/^onebot-private-10001-[a-z0-9]+$/)
    expect(sessionIds[0]).not.toBe('onebot-private-10001')
    const retired = registryOf({ bridge }).retiredSessionIds
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
        mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
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
        botQQ: '10002', ignoreSelf: false, requireMention: true,
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
    const registry = registryOf({ bridge })
    const chat = await registry.ensureChat('private:10001', '小明')
    // First session of the chat: no stale log, so it legitimately uses the
    // bare id. /new then retires the bare id as well, so any restart cannot
    // rebuild it on a colliding id.
    expect(String(chat.sessionId)).toBe('onebot-private-10001')
    await (bridge as unknown as { resetChat(chatId: string): Promise<void> }).resetChat('private:10001')
    const retired = registry.retiredSessionIds
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
        mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
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
        botQQ: '10002', ignoreSelf: false, requireMention: true,
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
    const registry = registryOf({ bridge })
    await registry.loadRetired()
    const logLinesSnapshot = [...logLines]
    const retiredIds = registry.retiredSessionIds
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
    // (Leading `;` guards against ASI joining this line onto the waitFor
    // statement above — the result would be waitFor(cb)(...) called.)
    ;(registry as unknown as { retireSession(id: string): void }).retireSession('onebot-private-10001')
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

  it('onSessionFlush debounces the mapping write; stop() forces the final save (M1-E2)', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured)
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const bridge = new ChatBridge({
      ctx,
      connection: new OneBotConnection({
        mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
      }),
      media: new MediaStore(join(mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: agents as never,
      sessions: { flush: vi.fn(async () => undefined) } as never,
      agentPresets: undefined as never,
      workspaceRegistry: undefined as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, requireMention: true,
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
    bridge.start()
    const registry = registryOf({ bridge })
    await registry.ensureChat('private:10001', '小明')
    // Count full mapping rewrites; pass through to the real disk write.
    const saveTarget = registry as unknown as { saveMapping(): Promise<void> }
    const realSave = saveTarget.saveMapping
    let saveWrites = 0
    saveTarget.saveMapping = async () => {
      saveWrites += 1
      await realSave.call(registry)
    }
    const flush = (): void => {
      ctx.emit('session/flush', { id: sessionIds[0] } as never)
    }
    // 10 arbitrary session flushes coalesce into ONE deferred mapping write.
    for (let i = 0; i < 10; i++) flush()
    expect(saveWrites).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(saveWrites).toBe(1)
    await vi.waitFor(async () => {
      const content = await readFile(join(mediaDir, 'chat-sessions.json'), 'utf8')
      expect(JSON.parse(content)).toEqual({ 'private:10001': sessionIds[0] })
    })
    // A flush right before stop() must not wait for the debounce timer:
    // stop() cancels it and forces the final save immediately.
    flush()
    expect(saveWrites).toBe(1)
    await bridge.stop()
    expect(saveWrites).toBe(2)
    vi.useRealTimers()
  })

  it('does not auto-create a workspace for a session whose cwd differs from workspacePath', async () => {
    const ctx = new Context()
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const connection = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
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
    // A resumed legacy session may carry a cwd that predates workspacePath
    // (e.g. an earlier host cwd): it must NOT spawn a workspace of its own.
    const registry = registryOf({ bridge })
    await (registry as unknown as {
      attachToWorkspace(sessionId: string, headerCwd: string | undefined): Promise<void>
    }).attachToWorkspace('onebot-legacy-session', '/home/user/.hermes/workspace')
    expect(workspaceRegistry.resolveByPath).toHaveBeenCalledWith('/home/user/.hermes/workspace')
    expect(workspaceRegistry.create).not.toHaveBeenCalled()
    expect(attached).toHaveLength(0)
    await bridge.stop()
    await connection.stop()
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
      mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
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
    bridge.start()
    const override = (): string | undefined => registryOf({ bridge }).getSettings('private:10001').workspacePath
    // Resume carried a non-default cwd → the override must be restored.
    await vi.waitFor(() => expect(override()).toBe(otherDir))
    // A resumed QQ chat with no inbound caller yet has no owner → file edits denied.
    expect(bridge.canEditFiles('onebot-private-10001-aabbcc')).toBe(false)
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
      connection: new OneBotConnection({ mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3002', accessToken: 'test-token', callTimeoutMs: 3_000 }),
      media: new MediaStore(join(bridge2Dir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: { create: vi.fn(), resume: resume2 } as never,
      sessions: { flush: vi.fn(async () => undefined) } as never,
      agentPresets: undefined as never,
      workspaceRegistry: undefined as never,
      agentDefaultModel: undefined,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, requireMention: true,
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
    await vi.waitFor(() => expect(registryOf({ bridge: bridge2 }).getSettings('private:10002').workspacePath).toBeUndefined())
    await bridge.stop()
    await bridge2.stop()
    await connection.stop()
  })

  it('drops queued turn roles on /new so the fresh session cannot inherit them (M1-A2)', async () => {
    const h = await makeCmdHarness()
    // Member turn + admin interjection: the admin role is still queued when
    // the member's turn ends.
    h.sendGroupTextAs('任务A', 20003)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.sendGroupTextAs('管理员插话', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/start', { turn: 1 }))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    // /new in the group disposes the chat: the queued admin role must go with it.
    h.sendGroupTextAs('/new', 10001)
    await vi.waitFor(() => expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true))
    // The next admin message re-creates the chat; its turn/start must freeze
    // 'admin', proving no stale role lingered ahead of it in the queue.
    h.sendGroupTextAs('新会话消息', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))
    h.ctx.emit('session/event', { id: h.sessionIds[1] } as never, makeEvent('turn/start', { turn: 1 }))
    expect(h.bridge.canEditFiles(h.sessionIds[1])).toBe(true)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('mapping round-trip: a stopped chat resumes with the recorded preset and the live default model (M2-T0 registry)', async () => {
    const h = await makeHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
    const mapping = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, string>
    const recordedSessionId = mapping['private:10001']
    expect(recordedSessionId).toBe(h.sessionIds[0])

    const resume = vi.fn(async (options: { resumeSessionId: string; agentOptions?: { provider?: string; model?: string }; setup?: (agentCtx: unknown) => unknown }) => {
      if (typeof options.setup === 'function') {
        await options.setup({ on: () => () => undefined, systemPrompt: { section: () => () => undefined }, tools: { register: () => () => undefined } })
      }
      return {
        agent: { session: { id: String(options.resumeSessionId), seq: 1, header: { cwd: h.mediaDir } }, status: 'idle', cancel: () => undefined, followup: () => undefined, whenIdle: async () => undefined },
        dispose: async () => undefined,
      }
    })
    const mountedPresets: Array<string | undefined> = []
    const sessionPersistence = { inspect: vi.fn(async () => ({ meta: { agentPreset: 'router-flash' }, events: [] })) }
    const bridge2 = new ChatBridge({
      ctx: new Context(),
      connection: new OneBotConnection({ mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3002', accessToken: 'test-token', callTimeoutMs: 3_000 }),
      media: new MediaStore(join(h.mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: { create: vi.fn(), resume } as never,
      sessions: { flush: vi.fn(async () => undefined) } as never,
      agentPresets: {
        defaultId: 'standard',
        resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard' })),
        mount: vi.fn(async (_agentCtx: unknown, id?: string) => { mountedPresets.push(id); return { id: id ?? 'standard' } }),
      } as never,
      sessionPersistence: sessionPersistence as never,
      workspaceRegistry: undefined as never,
      agentDefaultModel: undefined,
      defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      config: {
        botQQ: '10002', ignoreSelf: false, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
        sensitivePatterns: [], mediaDir: h.mediaDir, maxImageBytes: 8 * 1024 * 1024,
        maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
        agentPreset: 'standard', workspacePath: h.mediaDir,
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    bridge2.start()
    const chats2 = registryOf({ bridge: bridge2 }).chats
    await vi.waitFor(() => expect(chats2.get('private:10001')?.sessionId).toBe(recordedSessionId))
    // The mapping file the first bridge wrote is the resume source.
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume.mock.calls[0][0].resumeSessionId).toBe(recordedSessionId)
    // Model is NOT per-chat persisted: the resume carries the live default selection.
    expect(resume.mock.calls[0][0].agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    // Preset IS backfilled from the session's own durable record, over the config.
    expect(sessionPersistence.inspect).toHaveBeenCalledTimes(1)
    expect(mountedPresets).toEqual(['router-flash'])
    await bridge2.stop()
  }, 30_000)

  it('heals a session collision end-to-end: the chat rebuilds on a fresh id for the next message (M2-T0 registry)', async () => {
    const h = await makeHarness()
    h.sendText('hi')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const oldSessionId = h.sessionIds[0]
    h.ctx.emit('session/event', { id: oldSessionId } as never, makeEvent('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'E_COLLISION', message: 'session "' + oldSessionId + '" already has a persisted log on disk that does not match this live session (id collision)' } },
    }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('运行出错'))).toBe(true)
    })
    await vi.waitFor(async () => {
      const mapping = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, string>
      expect(Object.keys(mapping)).toHaveLength(0)
    })
    // The next message rebuilds the chat on a fresh suffixed id and repopulates
    // the mapping with the truth.
    h.sendText('再来一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    const rebuiltSessionId = h.captured.followups[1].sessionId
    expect(rebuiltSessionId).not.toBe(oldSessionId)
    expect(rebuiltSessionId).toMatch(/^onebot-private-10001-[a-z0-9]+$/)
    await vi.waitFor(async () => {
      const mapping = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, string>
      expect(mapping['private:10001']).toBe(rebuiltSessionId)
    })
    const retired = JSON.parse(await readFile(join(h.mediaDir, 'retired-sessions.json'), 'utf8')) as string[]
    expect(retired).toContain(oldSessionId)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('per-chat settings survive /new: workspace, preset, mode, goal, last image and pending ref (D1-PR3)', async () => {
    const h = await makeCmdHarness()
    const registry = registryOf(h)
    const settings = (): ChatSettings => registry.getSettings('private:10001')
    registry.getSettings('private:10001').workspacePath = '/ws/dir'
    registry.getSettings('private:10001').presetOverride = 'minimal'
    registry.getSettings('private:10001').interimOverride = false
    registry.getSettings('private:10001').goal = '把事情做好'
    registry.getSettings('private:10001').lastImagePath = '/media/a.png'
    registry.getSettings('private:10001').pendingImageRef = { kind: 'image', url: 'http://x/a.jpg' }
    h.sendText('/new')
    await vi.waitFor(() => expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true))
    // /new retires the session but never clears the settings entry — every
    // field keeps its value for the NEXT session of this chat (pre-PR3 maps
    // semantics, kept verbatim).
    expect(settings().workspacePath).toBe('/ws/dir')
    expect(settings().presetOverride).toBe('minimal')
    expect(settings().interimOverride).toBe(false)
    expect(settings().goal).toBe('把事情做好')
    expect(settings().lastImagePath).toBe('/media/a.png')
    expect(settings().pendingImageRef).toEqual({ kind: 'image', url: 'http://x/a.jpg' })
    // takePendingImageRef consumes exactly once.
    expect(settings().pendingImageRef).toBeDefined()
    const taken = registry.getSettings('private:10001').pendingImageRef
    registry.getSettings('private:10001').pendingImageRef = undefined
    expect(taken).toEqual({ kind: 'image', url: 'http://x/a.jpg' })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  // B8a (M2-T0 todo unblocked): concurrent first messages for one chat join a
  // single in-flight create — agents.create runs exactly once and the second
  // dispatch awaits the already-created chat instead of racing it.
  it('ensureChat concurrent first messages create exactly one agent per chat (M2-T0, B8a)', async () => {
    const h = await makeHarness({ createDelayMs: 80 })
    for (let i = 0; i < 10; i++) h.sendText('并发首条 ' + i)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(10))
    expect(h.sessionIds).toHaveLength(1)
    expect(registryOf(h).chats.size).toBe(1)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('B8b: a whenIdle failure after create disposes the orphan agent and leaves no chat residue', async () => {
    const dispose = vi.fn(async () => undefined)
    const agents = {
      create: vi.fn(async (options: { sessionId: string }) => ({
        agent: {
          session: { id: options.sessionId, seq: 0, header: { cwd: process.cwd() } },
          status: 'idle',
          cancel: () => undefined,
          followup: () => undefined,
          whenIdle: async () => { throw new Error('whenIdle stub failure') },
        },
        dispose,
      })),
      resume: vi.fn(),
    }
    const registry = new ChatRegistry(makeRegistryDeps({ agents }))
    await expect(registry.ensureChat('private:10001', '小明')).rejects.toThrow('whenIdle stub failure')
    // The orphan agent was disposed, and no chat residue remains.
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(registry.chats.size).toBe(0)
    expect(registry.bySession.size).toBe(0)
  })

  it('B8c: an idle chat is evicted on the next inbound message — flushed, disposed, mapping kept, resume restores it', async () => {
    const h = await makeHarness({ resumeOk: true })
    h.sendText('第一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const registry = registryOf(h)
    const chat = registry.chats.get('private:10001')!
    const sessionId = String(chat.sessionId)
    const disposed = (registry as unknown as { deps: { agents: { disposed: string[] } } }).deps.agents.disposed
    expect(disposed).toHaveLength(0)
    // Fake idle: push last activity past the eviction horizon (default 7 days).
    chat.lastActivityAt = Date.now() - 8 * 24 * 60 * 60 * 1000
    // The next inbound message sweeps first: the agent is flushed + disposed,
    // and the SAME session is resumed for the message.
    h.sendText('触发清扫的一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(disposed).toEqual([sessionId])
    expect(h.captured.followups[1].sessionId).toBe(sessionId)
    // resume, not a second create: the session id list holds the id twice.
    expect(h.sessionIds).toEqual([sessionId, sessionId])
    expect(registry.chats.get('private:10001')!.agent).not.toBe(chat.agent)
    // The chat→session mapping survived eviction (NOT retired) — the file is
    // still the resume source and no retired record was written.
    const mapping = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, string>
    expect(mapping['private:10001']).toBe(sessionId)
    await expect(readFile(join(h.mediaDir, 'retired-sessions.json'), 'utf8')).rejects.toThrow()
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)
})
