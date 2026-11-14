/**
 * Issue #61 建议 2 回归测试：「启动恢复会话」设置开关（startupResumeEnabled）。
 *
 * 默认（不设置 / true）：启动按 chat-sessions.json mapping 恢复会话——既有
 * 行为零变化（issue61-restart-resume.spec.ts 已覆盖 true 路径的三条分支）。
 *
 * false（每次重启都开全新会话的显式出口）：
 *  - 启动完全不发起 resume（agents.resume 零调用）；
 *  - 旧会话（mapping 指向的 id）不被 retire（retired-sessions.json 不产生）；
 *  - evictedChats 无 resume 载体（首条消息不能绕过开关继续 resume）；
 *  - 首条消息走既有 createChat 新建路径（裸派生 id），mapping 经正常保存流
 *    更新为新 id——与无 mapping 的新 chat 一致；旧会话日志文件不动。
 *
 * 附加边界（既有 createChat 碰撞防护，非开关语义）：mapping 指向裸派生 id 且
 * 其日志仍在磁盘时，关闭开关后的首条消息新建会话会按既有碰撞防护 retire 裸 id
 * 并落到带后缀的新 id（与无 mapping 新 chat 在同场景下的行为一致）。
 * @module dsh-onebot-qq/tests/issue61-startup-resume-toggle
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebSocket from 'ws'
import type {} from '@deepseek-ai/dsh-session'

import { OneBotConnection } from '../src/connection.js'
import { ChatBridge } from '../src/bridge.js'
import type { ChatRegistry } from '../src/registry.js'
import { MediaStore } from '../src/media.js'
import { Transcriber } from '../src/stt.js'

/** mapping 常见形态：私聊指向一个带后缀的既有会话 id（与 issue61 同款）。 */
const MAPPED_SESSION_ID = 'onebot-private-10001-mvhrinxw'
/** 裸派生 id（sessionIdForChat 的产物）。 */
const BARE_SESSION_ID = 'onebot-private-10001'

function registryOf(bridge: unknown): ChatRegistry {
  return (bridge as unknown as { registry: ChatRegistry }).registry
}

/** setup 闭包收到的 agent ctx 桩（与 tests/helpers/bridge-harness.ts 同构）。 */
function agentCtxStub(): Record<string, unknown> {
  return {
    on: () => () => undefined,
    systemPrompt: { section: () => () => undefined },
    tools: { register: () => () => undefined },
    userQuestions: { askTimed: async () => ({ answers: [] }), answer: async () => false },
  }
}

interface ToggleHarnessOpts {
  /** 预置的 chat-sessions.json 内容。 */
  mapping: Record<string, string>
  /** 持久层 stat 报告「日志在磁盘」的会话 id 集合（精确匹配，非全量开关——
   *  裸派生 id 与 mapping id 的日志存在性需要区分开）。 */
  logsOnDisk: readonly string[]
  /** 启动恢复会话开关：undefined = 不设置（默认路径），false = 关。 */
  startupResumeEnabled?: boolean
}

/** 真 ChatBridge + 反向 WS 的重启场景 harness（issue61 版精简：resume 恒成功，
 *  持久层 stat 按 id 精确可控）。 */
async function makeToggleHarness(opts: ToggleHarnessOpts) {
  const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-issue61-toggle-'))
  await writeFile(join(mediaDir, 'chat-sessions.json'), JSON.stringify(opts.mapping), 'utf8')
  const captured: Array<{ text: string; sessionId: string }> = []
  const makeAgent = (sessionId: string) => ({
    session: { id: sessionId, seq: 1, header: { cwd: mediaDir } },
    status: 'idle',
    cancel: () => { agent.status = 'idle' },
    followup: (message: { content: Array<{ type: string; text?: string }> }) => {
      captured.push({ text: message.content.map(b => b.text ?? '').join(''), sessionId })
    },
    steer: () => undefined,
    whenIdle: async () => undefined,
  })
  const agent = makeAgent('') // 占位引用，create/resume 时重绑字段
  const setupAgent = (sessionId: string, options: { setup?: (agentCtx: unknown) => unknown }) => {
    Object.assign(agent, makeAgent(sessionId))
    if (typeof options.setup === 'function') return options.setup(agentCtxStub())
    return undefined
  }
  const agents = {
    create: vi.fn(async (options: { sessionId: string; meta?: { cwd?: string }; setup?: (agentCtx: unknown) => unknown }) => {
      const sessionId = String(options.sessionId)
      await setupAgent(sessionId, options)
      return { agent, dispose: vi.fn(async () => undefined) }
    }),
    resume: vi.fn(async (options: { resumeSessionId: string; setup?: (agentCtx: unknown) => unknown }) => {
      const sessionId = String(options.resumeSessionId)
      await setupAgent(sessionId, options)
      return { agent, dispose: vi.fn(async () => undefined) }
    }),
  }
  const sessionPersistence = {
    stat: vi.fn(async (id: unknown) => (opts.logsOnDisk.includes(String(id)) ? { format: 'v4' } : undefined)),
    open: vi.fn(async () => ({
      header: {},
      read: vi.fn(async () => ({ eventState: 'detached' as const, events: [] })),
      close: vi.fn(async () => undefined),
    })),
  }
  const logLines: string[] = []
  const ctx = new Context()
  const sessions = { flush: vi.fn(async () => undefined) }
  const connection = new OneBotConnection({
    mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3003', accessToken: 'test-token', callTimeoutMs: 3_000,
  })
  const bridge = new ChatBridge({
    ctx,
    connection,
    media: new MediaStore(join(mediaDir, 'media'), 6),
    transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
    agents: agents as never,
    sessions: sessions as never,
    agentPresets: {
      defaultId: 'standard',
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard' })),
      mount: vi.fn(async (_agentCtx: unknown, id?: string) => ({ id: id ?? 'standard' })),
    } as never,
    sessionPersistence: sessionPersistence as never,
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
      ...(opts.startupResumeEnabled === undefined ? {} : { startupResumeEnabled: opts.startupResumeEnabled }),
    },
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
    },
    log: (level: string, message: string) => { logLines.push(level + ': ' + message) },
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
  const sendText = (text: string): void => {
    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'text', data: { text } }], raw_message: text,
      sender: { user_id: 10001, nickname: '小明' },
    }))
  }
  return {
    bridge, connection, client, sendText, captured,
    create: agents.create, resume: agents.resume,
    mediaDir, logLines, registry: registryOf(bridge),
  }
}

async function stopHarness(h: Awaited<ReturnType<typeof makeToggleHarness>>): Promise<void> {
  h.client.close()
  await h.bridge.stop()
  await h.connection.stop()
}

describe('issue #61 建议 2：startupResumeEnabled 启动恢复会话开关', () => {
  it('开关关闭：启动不 resume、不 retire、evictedChats 无载体；首条消息新建会话且 mapping 正常更新', async () => {
    const h = await makeToggleHarness({ mapping: { 'private:10001': MAPPED_SESSION_ID }, logsOnDisk: [MAPPED_SESSION_ID], startupResumeEnabled: false })
    try {
      // 启动阶段：mapping 已加载完毕（确定性屏障），但 resume 一次都没发起。
      await h.registry.mappingLoaded
      expect(h.resume).not.toHaveBeenCalled()
      expect(h.create).not.toHaveBeenCalled()
      expect(h.registry.chats.has('private:10001')).toBe(false)
      // 旧会话不被 retire（retired-sessions.json 不产生），也没有任何
      // evictedChats 重试载体（首条消息不能绕过开关继续 resume）。
      await expect(readFile(join(h.mediaDir, 'retired-sessions.json'), 'utf8')).rejects.toThrow()
      expect((h.registry as unknown as { evictedChats: Map<string, unknown> }).evictedChats.size).toBe(0)
      // mapping 文件保持原值（未被启动流程改写）。
      const mappingAfterStart = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, string>
      expect(mappingAfterStart['private:10001']).toBe(MAPPED_SESSION_ID)

      // 首条消息：走既有 createChat 新建路径——裸派生 id 无日志、未被封锁，
      // 直接以裸 id 建新会话；mapping 经正常保存流更新为新 id（与无 mapping
      // 的新 chat 一致）；旧会话（带后缀 id）始终不被 retire。
      h.sendText('重启后的第一条消息')
      await vi.waitFor(() => expect(h.captured).toHaveLength(1))
      expect(h.captured[0].sessionId).toBe(BARE_SESSION_ID)
      expect(h.create).toHaveBeenCalledTimes(1)
      expect(h.resume).not.toHaveBeenCalled()
      expect((h.registry as unknown as { evictedChats: Map<string, unknown> }).evictedChats.size).toBe(0)
      await vi.waitFor(async () => {
        const mapping = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, string>
        expect(mapping['private:10001']).toBe(BARE_SESSION_ID)
      })
      await expect(readFile(join(h.mediaDir, 'retired-sessions.json'), 'utf8')).rejects.toThrow()
    } finally { await stopHarness(h) }
  }, 30_000)

  it('开关不设置（默认）：启动仍按 mapping resume 旧会话（既有行为零变化）', async () => {
    const h = await makeToggleHarness({ mapping: { 'private:10001': MAPPED_SESSION_ID }, logsOnDisk: [MAPPED_SESSION_ID] })
    try {
      await vi.waitFor(() => expect(h.resume.mock.calls.map(call => String(call[0].resumeSessionId))).toEqual([MAPPED_SESSION_ID]))
      await h.registry.mappingLoaded
      expect(h.registry.chats.get('private:10001')?.sessionId).toBe(MAPPED_SESSION_ID)
      expect(h.create).not.toHaveBeenCalled()
    } finally { await stopHarness(h) }
  }, 30_000)

  it('开关关闭 + mapping 指向裸派生 id 且其日志仍在磁盘：首条消息按既有碰撞防护 retire 裸 id 并落到带后缀新 id（与无 mapping 新 chat 一致）', async () => {
    const h = await makeToggleHarness({ mapping: { 'private:10001': BARE_SESSION_ID }, logsOnDisk: [BARE_SESSION_ID], startupResumeEnabled: false })
    try {
      await h.registry.mappingLoaded
      expect(h.resume).not.toHaveBeenCalled()
      await expect(readFile(join(h.mediaDir, 'retired-sessions.json'), 'utf8')).rejects.toThrow()

      // 首条消息：新建路径撞上裸 id 的既有日志 → 既有碰撞防护 retire 裸 id、
      // 落到带后缀的新 id（既有 createChat 行为，非开关新增语义）。
      h.sendText('重启后的第一条消息')
      await vi.waitFor(() => expect(h.captured).toHaveLength(1))
      expect(h.captured[0].sessionId).not.toBe(BARE_SESSION_ID)
      expect(h.captured[0].sessionId).not.toBe(MAPPED_SESSION_ID)
      expect(h.create).toHaveBeenCalledTimes(1)
      expect(h.resume).not.toHaveBeenCalled()
      await vi.waitFor(async () => {
        const mapping = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, string>
        expect(mapping['private:10001']).toBe(h.captured[0].sessionId)
      })
      const retired = JSON.parse(await readFile(join(h.mediaDir, 'retired-sessions.json'), 'utf8')) as string[]
      expect(retired).toContain(BARE_SESSION_ID)
    } finally { await stopHarness(h) }
  }, 30_000)
})
