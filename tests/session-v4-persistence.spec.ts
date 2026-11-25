/**
 * Session v4 producer-owned source kind 持久化回归测试（P0/T1）。
 *
 * 审计结论（docs/v4-source-audit.md）：全仓经宿主 API 写会话 source 的形态
 * 收敛于 src/bridge.ts:576（dispatchFollowup）与 :754（steerMessage 内核，
 * T2 起共用；'steer' 策略与 /steer 都经它）两点，
 * 均为 `source: { kind: 'plugin:dsh-onebot' }`。本测试用真管线 harness（真实
 * ChatBridge + 反向 WS 入站）在四条路径上固化该结论，并在「持久化-重读-再写入」
 * 循环与真实宿主 v4 准入函数上断言 kind 不漂移：
 *
 * 1. 普通入站 dispatch —— 唯一插件会话行（user/message）携带 producer-owned kind；
 * 2. interim 开启的回合 —— 回合全程零新增插件写入，dispatch 行 kind 不变；
 * 3. steer 补递（语音转写）—— 第二写点同 kind；
 * 4. 宿主转发命令（/permission、/plan）—— 插件侧零会话写入（行归宿主管辖）；
 * 5. JSONL 序列化-重读-再写入循环 + 宿主 assertV4RowAdmission 正反例
 *    （retired `kind: 'plugin'` 必须被拒；`plugin:dsh-onebot` 必须通过）；
 * 6. src 全树扫描不变量 —— 任何新的 `source: { … kind … }` 写入形态必须携带
 *    `plugin:dsh-onebot`（防第三写点漂移的机器护栏）。
 * @module dsh-onebot/tests/session-v4-persistence
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebSocket from 'ws'

import { OneBotConnection } from '../src/connection.js'
import { ChatBridge } from '../src/bridge.js'
import { MediaStore } from '../src/media.js'
import { Transcriber } from '../src/stt.js'

/** 插件写入的会话行消息（dsh-llm createMessage 形态：id/role/content/source 冻结体）。 */
interface CapturedMessage {
  id: string
  role: string
  content: Array<{ type: string; text?: string }>
  source: Record<string, unknown>
}

const PLUGIN_KIND = 'plugin:dsh-onebot'
const RETIRED_KIND = 'plugin'

/** 与 makeFakeAgents 同构，但捕获完整消息对象（含 source）——
 * 共享 harness 的 followup 只记文本，无法断言 producer attribution。 */
function makeRecordingAgents() {
  const captured: Array<{ via: 'followup' | 'steer'; message: CapturedMessage }> = []
  const sessionIds: string[] = []
  const makeAgent = (sessionId: string) => ({
    session: { id: sessionId, seq: 0, header: { cwd: process.cwd() } },
    status: 'idle',
    cancel: () => { agent.status = 'idle' },
    followup: (message: CapturedMessage) => { captured.push({ via: 'followup', message }) },
    steer: (message: CapturedMessage) => { captured.push({ via: 'steer', message }) },
    whenIdle: async () => undefined,
  })
  const agent = makeAgent('') // 占位引用，create 时重绑字段（cancel 闭包用）
  const agents = {
    create: vi.fn(async (options: { sessionId: string; meta?: unknown; setup?: (agentCtx: unknown) => unknown }) => {
      const sessionId = String(options.sessionId)
      sessionIds.push(sessionId)
      const fresh = makeAgent(sessionId)
      Object.assign(agent, fresh)
      if (typeof options.setup === 'function') {
        await options.setup({ on: () => () => undefined, systemPrompt: { section: () => () => undefined }, tools: { register: () => () => undefined } })
      }
      return { agent, dispose: vi.fn(async () => undefined) }
    }),
    resume: vi.fn(async () => { throw new Error('not persisted') }),
  }
  return { agents, captured, sessionIds }
}

/** 真管线 harness：真实 ChatBridge + 反向 WS，镜像 tests/helpers/bridge-harness.ts
 * 的 makeHarness，仅替换 agent 记录层为全对象捕获。 */
async function makeV4Harness(opts?: {
  interimMessages?: boolean
  commands?: { execute: (agent: unknown, line: string, attachments: readonly unknown[], signal: AbortSignal) => Promise<{ kind?: string; text?: string; result?: { kind?: string; text?: string } }> }
}) {
  const ctx = new Context()
  const { agents, captured, sessionIds } = makeRecordingAgents()
  const sessions = { flush: vi.fn(async () => undefined) }
  const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-v4-test-'))
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
    ...(opts?.commands !== undefined ? { commands: opts.commands as never } : {}),
    defaultModel: undefined,
    config: {
      botQQ: '10002', ignoreSelf: false, requireMention: true,
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
  connection.onMessage = event => { void bridge.handleInbound(event) }
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
  const sendText = (text: string): void => {
    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'text', data: { text } }], raw_message: text,
      sender: { user_id: 10001, nickname: '小明' },
    }))
  }
  return { ctx, bridge, connection, client, outbound, sendText, captured, sessionIds, mediaDir }
}

/** 逐用例收尾：断开 WS、停桥、停连接（对齐既有 spec 的清理纪律）。 */
async function stopHarness(h: Awaited<ReturnType<typeof makeV4Harness>>): Promise<void> {
  h.client.close()
  await h.bridge.stop()
  await h.connection.stop()
}

function makeEvent(type: string, data: unknown): { seq: number; time: number; type: string; data: unknown } {
  return { seq: 0, time: Date.now(), type, data }
}

/** 用户行的宿主持久化行形态（v4 JSONL）：user/message 行 data 即消息本体。 */
function persistRow(message: CapturedMessage): { type: string; data: CapturedMessage } {
  return { type: 'user/message', data: message }
}

afterEach(() => { vi.useRealTimers() })

describe('session v4 producer-owned source kind（持久化回归）', () => {
  it('① 普通入站 dispatch：唯一插件会话行携带 plugin:dsh-onebot，无 retired 包装', async () => {
    const h = await makeV4Harness()
    try {
      h.sendText('你好')
      await vi.waitFor(() => expect(h.captured).toHaveLength(1))
      const row = h.captured[0]
      expect(row.via).toBe('followup')
      expect(row.message.role).toBe('user')
      expect(row.message.source).toEqual({ kind: PLUGIN_KIND })
      expect(Object.keys(row.message.source)).not.toContain(RETIRED_KIND)
      // 无 retired 形态混入：kind 是 producer-owned 值本身，而非 'plugin' + plugin 字段
      expect(row.message.source).not.toHaveProperty('plugin')
    } finally { await stopHarness(h) }
  })

  it('② interim 开启的回合：全程零新增插件写入，dispatch 行 kind 不漂移', async () => {
    const h = await makeV4Harness({ interimMessages: true })
    try {
      h.sendText('跑个长任务')
      await vi.waitFor(() => expect(h.captured).toHaveLength(1))
      const dispatchRow = h.captured[0].message
      expect(dispatchRow.source).toEqual({ kind: PLUGIN_KIND })

      // 驱动一个真实回合：turn/start → assistant 中间消息（loop-merge 模式下首段
      // 文本被 deferred，与最终回复一起在 turn/end 结算出站）→ turn/end
      const session = { id: h.sessionIds[0] }
      h.ctx.emit('session/event', session as never, makeEvent('turn/start', { turn: 1 }))
      h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
        turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '中间步骤' }] },
      }))
      h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
        turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '最终答案' }] },
      }))
      h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
      await vi.waitFor(() => {
        expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('最终答案'))).toBe(true)
      })
      // interim 只消费会话事件（出站路径），不产生任何新会话行：
      expect(h.captured).toHaveLength(1)
      expect(h.captured[0].message.source).toEqual({ kind: PLUGIN_KIND })
    } finally { await stopHarness(h) }
  })

  it('③ steer 补递（语音转写）：第二写点同 kind，不回退到 retired 包装', async () => {
    const h = await makeV4Harness()
    try {
      h.sendText('先建立会话')
      await vi.waitFor(() => expect(h.captured).toHaveLength(1))
      // steerMessage 是私有写点内核（bridge.ts:1344，steer 补递经它落会话行），类型上经桥接访问 —— 运行时为原型方法
      const chatId = [...(h.bridge as unknown as { chats: Map<string, unknown> }).chats.keys()][0]
      expect(chatId).toBeDefined()
      ;(h.bridge as unknown as { steerMessage: (chatId: string, text: string) => boolean })
        .steerMessage(chatId!, '（语音转写）帮我总结一下')
      await vi.waitFor(() => expect(h.captured).toHaveLength(2))
      const steerRow = h.captured[1]
      expect(steerRow.via).toBe('steer')
      expect(steerRow.message.role).toBe('user')
      expect(steerRow.message.source).toEqual({ kind: PLUGIN_KIND })
      expect(JSON.stringify(steerRow.message.source)).toContain(PLUGIN_KIND)
      expect(JSON.stringify(steerRow.message.source)).not.toContain('"' + RETIRED_KIND + '":')
    } finally { await stopHarness(h) }
  })

  it('④ 宿主转发命令（/permission、/plan）：插件侧零会话写入', async () => {
    const execute = vi.fn(async (_agent: unknown, line: string, attachments: readonly unknown[], signal: AbortSignal) => {
      expect(Array.isArray(attachments)).toBe(true)
      expect(signal.aborted).toBe(false)
      return { commandId: 'cmd-host', result: { kind: 'success', text: 'current preset: workspace-write\n(available: workspace-write, danger-full-access)' } }
    })
    const h = await makeV4Harness({ commands: { execute } })
    try {
      h.sendText('先建立会话')
      await vi.waitFor(() => expect(h.captured).toHaveLength(1))
      h.captured.length = 0 // 只观测命令路径

      h.sendText('/permission')
      await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(expect.anything(), '/permission', expect.anything(), expect.anything()))
      await vi.waitFor(() => {
        expect(h.outbound.some(f => f.action === 'send_msg')).toBe(true)
      })
      h.sendText('/plan off')
      await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(expect.anything(), '/plan off', expect.anything(), expect.anything()))
      // 宿主转发路径：commands.execute(chat.agent, …) 由宿主命令运行时写行（宿主自有
      // source）；插件侧 followup/steer 均未被触发 —— 零插件会话写入。
      expect(h.captured).toHaveLength(0)
    } finally { await stopHarness(h) }
  })

  it('⑤ 持久化-重读-再写入循环：kind 不漂移；宿主 v4 准入正反例成立', async () => {
    const h = await makeV4Harness()
    try {
      h.sendText('第一条')
      await vi.waitFor(() => expect(h.captured).toHaveLength(1))
      h.sendText('第二条')
      await vi.waitFor(() => expect(h.captured).toHaveLength(2))

      // 持久化：宿主 JSONL 行编码（persistRow 接收消息本体，不含 via 包装）
      const jsonl = h.captured.map(c => JSON.stringify(persistRow(c.message))).join('\n') + '\n'
      // 重读：逐行解析回行对象
      const reparsed = jsonl.trim().split('\n').map(line => JSON.parse(line) as { type: string; data: CapturedMessage })
      expect(reparsed).toHaveLength(2)
      // 再写入：重读后的行继续作为会话历史（下一轮 dispatch 追加），循环后逐行核验
      for (const row of reparsed) {
        expect(row.type).toBe('user/message')
        expect(row.data.source).toEqual({ kind: PLUGIN_KIND })
        expect(row.data.source).not.toHaveProperty(RETIRED_KIND)
        expect(row.data.role).toBe('user')
      }

      // 真实宿主读侧准入（0.2.0+）：producer-owned kind 通过、retired 包装被拒。
      // 宿主 API 缺失时显式降级（不静默失败）——审计文档 §2 已行号钉死准入线。
      let admission: { assertV4RowAdmission: (row: unknown, known?: Set<string>) => void } | undefined
      try {
        admission = await import('@deepseek-ai/dsh-session-format-v3-to-v4') as never
      } catch {
        console.warn('[session-v4-persistence] 宿主 dsh-session-format-v3-to-v4 不可用，准入断言降级跳过')
      }
      if (admission !== undefined) {
        for (const row of reparsed) {
          expect(() => admission!.assertV4RowAdmission(row)).not.toThrow()
        }
        const legacyRow = { type: 'user/message', data: { role: 'user', source: { kind: RETIRED_KIND, plugin: 'dsh-onebot' }, content: [{ type: 'text', text: '历史行' }] } }
        expect(() => admission.assertV4RowAdmission(legacyRow)).toThrow()
      }
    } finally { await stopHarness(h) }
  })

  it('⑥ src 全树扫描不变量：所有会话 source 写入形态都携带 plugin:dsh-onebot', async () => {
    // 机器护栏：任何新增 `source: { … kind … }` 写入形态必须使用 producer-owned
    // kind（审计 docs/v4-source-audit.md §4 的防漂移条款）。
    const srcDir = join(import.meta.dirname ?? 'src', '..', 'src')
    const entries = await readdir(srcDir, { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        for (const name of await readdir(join(srcDir, entry.name))) {
          if (name.endsWith('.ts')) files.push(join(srcDir, entry.name, name))
        }
      } else if (entry.name.endsWith('.ts')) files.push(join(srcDir, entry.name))
    }
    expect(files.length).toBeGreaterThan(20)
    const matches: Array<{ file: string; line: number; text: string }> = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      text.split('\n').forEach((line, index) => {
        if (/source:\s*\{/.test(line) && /kind/.test(line)) {
          matches.push({ file: file.split(/[\\/]/).pop() ?? file, line: index + 1, text: line.trim() })
        }
      })
    }
    // 恰为审计收口的两处写入点（bridge.ts:576/754，T9-C 行号同步），且全部携带 producer-owned kind
    expect(matches.length).toBeGreaterThanOrEqual(2)
    for (const m of matches) {
      expect(m.file === 'bridge.ts' || m.file === 'commands.ts' || m.file === 'trace.ts' || m.file === 'record.ts' || m.file === 'measure.ts',
        '意外的会话 source 写入形态：' + m.file + ':' + m.line + ' → ' + m.text).toBe(true)
      if (m.file === 'bridge.ts') {
        expect(m.text, m.file + ':' + m.line).toContain(PLUGIN_KIND)
      }
    }
  })
})
