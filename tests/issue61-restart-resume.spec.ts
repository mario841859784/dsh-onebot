/**
 * Issue #61 回归测试：DSH 进程异常重启（断电/强杀）后，QQ 私聊首条消息必须
 * resume chat-sessions.json mapping 里记录的旧会话，而不是新建会话并把旧
 * 会话写进 retired-sessions.json、把 mapping 静默改写。
 *
 * 三条路径：
 * A. mapping 会话可 resume：与启动 resume 竞争到达的首条消息（断电重启后
 *    NapCat 立即重连的现实时序——消息在 mappingLoaded 完成前进站）必须 join
 *    已恢复的会话——不新建、不 retire、mapping 不改写。
 * B. 启动 resume 瞬态失败但会话日志仍在磁盘：不得把 id 写进 retired-sessions.json
 *    （旧行为会永久封死一个完好的会话）；mapping 保留原值并留一行带原值的
 *    warn，首条消息经 evictedChats 载体重试 resume 并成功接回。
 * C. 会话真丢了（磁盘无日志）：维持既有行为——retire + 新建（任务红线护栏）。
 * @module dsh-onebot/tests/issue61-restart-resume
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

/** issue #61 的 mapping 形态：私聊指向一个带后缀的既有会话 id。 */
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

interface RestartHarnessOpts {
  /** 预置的 chat-sessions.json 内容（断电前留下的 mapping）。 */
  mapping: Record<string, string>
  /** resume 行为：'ok' 恒成功；'gate-first' 首次挂起直到放行（制造启动竞争窗口）；
   * 'fail-first' 首次失败其后成功（瞬态故障）；'fail-always' 恒失败（会话真坏）。 */
  resumeMode: 'ok' | 'gate-first' | 'fail-first' | 'fail-always'
  /** 持久层 stat 是否报告日志存在（会话目录仍在磁盘）。 */
  sessionLogOnDisk: boolean
}

/** 真 ChatBridge + 反向 WS 的重启场景 harness：预置 mapping 文件，agent 层可编程
 * （resume 按脚本成功/失败/挂起），持久层 stat 可控（会话日志是否还在磁盘）。 */
async function makeRestartHarness(opts: RestartHarnessOpts) {
  const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-issue61-'))
  await writeFile(join(mediaDir, 'chat-sessions.json'), JSON.stringify(opts.mapping), 'utf8')
  const captured: Array<{ text: string; sessionId: string }> = []
  const resumeCalls: string[] = []
  let releaseFirstResume: (() => void) | undefined
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
      resumeCalls.push(sessionId)
      if (opts.resumeMode === 'gate-first' && resumeCalls.length === 1) {
        await new Promise<void>(resolve => { releaseFirstResume = resolve })
      }
      if (opts.resumeMode === 'fail-first' && resumeCalls.length === 1) throw new Error('transient: session store warming up')
      if (opts.resumeMode === 'fail-always') throw new Error('not persisted')
      await setupAgent(sessionId, options)
      return { agent, dispose: vi.fn(async () => undefined) }
    }),
  }
  const sessionPersistence = {
    stat: vi.fn(async () => (opts.sessionLogOnDisk ? { format: 'v4' } : undefined)),
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
    mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
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
    bridge, connection, client, sendText, captured, resumeCalls,
    create: agents.create, resume: agents.resume,
    releaseFirstResume: () => { releaseFirstResume?.() },
    mediaDir, logLines, registry: registryOf(bridge),
  }
}

async function stopHarness(h: Awaited<ReturnType<typeof makeRestartHarness>>): Promise<void> {
  h.client.close()
  await h.bridge.stop()
  await h.connection.stop()
}

describe('issue #61：断电重启后首条消息 resume mapping 会话', () => {
  it('A. mapping 会话可 resume：与启动 resume 竞争的首条消息 join 恢复的会话，不新建不 retire', async () => {
    const h = await makeRestartHarness({ mapping: { 'private:10001': MAPPED_SESSION_ID }, resumeMode: 'gate-first', sessionLogOnDisk: true })
    try {
      // 首条消息在启动 resume 尚未完成时进站（mappingLoaded 未落定）——用
      // pendingCreates 观测点证明 createChat 已停在 mappingLoaded 等待上，
      // 再放行 resume，使竞争窗口确定性地命中。
      h.sendText('重启后的第一条消息')
      await vi.waitFor(() => expect((h.registry as unknown as { pendingCreates: Map<string, unknown> }).pendingCreates.has('private:10001')).toBe(true))
      await vi.waitFor(() => expect(h.resumeCalls).toEqual([MAPPED_SESSION_ID]))
      h.releaseFirstResume()
      await vi.waitFor(() => expect(h.captured).toHaveLength(1))
      // 消息进了恢复出来的旧会话，而不是新建的会话。
      expect(h.captured[0].sessionId).toBe(MAPPED_SESSION_ID)
      expect(h.create).not.toHaveBeenCalled()
      expect(h.resume).toHaveBeenCalledTimes(1)
      // 旧会话不被 retire；mapping 不被静默改写。
      await expect(readFile(join(h.mediaDir, 'retired-sessions.json'), 'utf8')).rejects.toThrow()
      const mapping = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, string>
      expect(mapping['private:10001']).toBe(MAPPED_SESSION_ID)
    } finally { await stopHarness(h) }
  }, 30_000)

  it('B. 启动 resume 瞬态失败但日志仍在磁盘：不 retire，mapping 保留原值，首条消息重试成功', async () => {
    const h = await makeRestartHarness({ mapping: { 'private:10001': MAPPED_SESSION_ID }, resumeMode: 'fail-first', sessionLogOnDisk: true })
    try {
      // 启动 resume 失败（宿主瞬态故障），但会话日志仍在磁盘。
      await vi.waitFor(() => expect(h.logLines.some(l => l.startsWith('warn: resume failed'))).toBe(true))
      // 旧行为会在这里把 id 写进 retired-sessions.json 永久封死——修复后必须不写。
      await expect(readFile(join(h.mediaDir, 'retired-sessions.json'), 'utf8')).rejects.toThrow()
      // mapping 保留原值；warn 记录了原会话 id 与保留重试的意图。
      const mappingAfterStart = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, string>
      expect(mappingAfterStart['private:10001']).toBe(MAPPED_SESSION_ID)
      expect(h.logLines.some(l => l.includes(MAPPED_SESSION_ID) && l.includes('still on disk'))).toBe(true)
      // 首条消息：经 evictedChats 载体重试 resume，成功接回旧会话。
      h.sendText('重启后的第一条消息')
      await vi.waitFor(() => expect(h.captured).toHaveLength(1))
      expect(h.captured[0].sessionId).toBe(MAPPED_SESSION_ID)
      expect(h.resume).toHaveBeenCalledTimes(2)
      expect(h.resume.mock.calls[1][0].resumeSessionId).toBe(MAPPED_SESSION_ID)
      expect(h.create).not.toHaveBeenCalled()
      await expect(readFile(join(h.mediaDir, 'retired-sessions.json'), 'utf8')).rejects.toThrow()
      const mapping = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, string>
      expect(mapping['private:10001']).toBe(MAPPED_SESSION_ID)
    } finally { await stopHarness(h) }
  }, 30_000)

  it('C. 会话真丢了（磁盘无日志）：维持既有 retire + 新建行为（红线护栏）', async () => {
    const h = await makeRestartHarness({ mapping: { 'private:10001': 'onebot-private-10001-dead' }, resumeMode: 'fail-always', sessionLogOnDisk: false })
    try {
      await vi.waitFor(() => expect(h.logLines.some(l => l.startsWith('warn: resume failed'))).toBe(true))
      await vi.waitFor(async () => {
        const retired = JSON.parse(await readFile(join(h.mediaDir, 'retired-sessions.json'), 'utf8')) as string[]
        expect(retired).toContain('onebot-private-10001-dead')
      })
      h.sendText('重启后的第一条消息')
      await vi.waitFor(() => expect(h.captured).toHaveLength(1))
      // 裸派生 id 未被封禁且磁盘无日志：新建裸 id 会话（既有新建行为不变）。
      await vi.waitFor(async () => {
        const mapping = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, string>
        expect(mapping['private:10001']).toBe(BARE_SESSION_ID)
      })
      expect(h.captured[0].sessionId).toBe(BARE_SESSION_ID)
      expect(h.create).toHaveBeenCalledTimes(1)
    } finally { await stopHarness(h) }
  }, 30_000)
})
