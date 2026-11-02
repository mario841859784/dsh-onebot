/**
 * Outbound media gate wiring (M1-A3b): the qq_send_* tools read local files
 * only inside the calling session's mediaSendRoots — the plugin media dir
 * always, plus the chat workspace on admin turns (M1-A2 turn-level role).
 * A real ChatBridge carries the role state (seeded like bridge.spec seeds
 * its private maps); the connection is a recording stub, so nothing hits
 * the network and every assertion on sends reads recorded send_msg params.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { ChatBridge } from '../src/bridge.js'
import { configureSendSegments, registerTools, SEGMENTS_INTERVAL_MAX_MS } from '../src/tools.js'

interface SendTool {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** Real ChatBridge + registered qq_* tools with a recording connection stub.
 * T14: `segments` installs the qq_send_segments page switches BEFORE tool
 * registration (undefined = module default: enabled, no interval). */
async function makeHarness(opts: { segments?: { enabled: boolean; intervalMs: number } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tools-gate-'))
  const mediaDir = join(root, 'media')
  const workspace = join(root, 'workspace')
  const otherDir = join(root, 'other-ws')
  const outside = join(root, 'outside')
  await Promise.all([mkdir(mediaDir), mkdir(workspace), mkdir(otherDir), mkdir(outside)])

  const calls: Array<{ action: string; params: Record<string, unknown> }> = []
  const bridge = new ChatBridge({
    ctx: new Context(),
    connection: {
      call: async (action: string, params: Record<string, unknown>) => {
        calls.push({ action, params })
        return { message_id: 42 }
      },
    } as never,
    media: {} as never,
    transcriber: {} as never,
    agents: {} as never,
    sessions: {} as never,
    agentPresets: undefined as never,
    sessionPersistence: undefined,
    workspaceRegistry: undefined as never,
    agentDefaultModel: undefined,
    defaultModel: undefined,
    config: {
      botQQ: '10002', ignoreSelf: false, requireMention: true,
      interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
      sensitivePatterns: [], mediaDir, maxImageBytes: 8 * 1024 * 1024,
      maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
      textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
      agentPreset: 'standard', workspacePath: workspace, maxInboundFileBytes: 0,
    },
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
    },
    log: () => undefined,
  })

  /** Seed one live chat with a frozen turn role (the M1-A2 state mediaSendRoots reads). */
  const seed = (sessionId: string, role: 'admin' | 'member'): string => {
    const chatId = 'group:' + (role === 'admin' ? '20001' : '20002')
    ;(bridge as unknown as { chats: Map<string, Record<string, unknown>> }).chats.set(chatId, {
      queue: Promise.resolve(),
      activeTurnRole: role,
      sessionId,
    })
    ;(bridge as unknown as { bySession: Map<string, string> }).bySession.set(sessionId, chatId)
    return chatId
  }

  const ctx = new Context()
  const tools: SendTool[] = []
  ctx.provide('tools' as never, {
    register: (tool: SendTool) => {
      tools.push(tool)
      return () => undefined
    },
  } as never)
  configureSendSegments(opts.segments)
  registerTools(ctx, bridge, {} as never, {
    maxImageBytes: 1_000_000,
    maxVoiceBytes: 1_000_000,
    maxFileBytes: 1_000_000,
  })
  const tool = (name: string): SendTool => {
    const found = tools.find(t => t.name === name)
    if (found === undefined) throw new Error('tool not registered: ' + name)
    return found
  }
  const exec = (sessionId: string) => ({ agent: { session: { id: sessionId } } })
  const sentSegment = (index = 0): Record<string, unknown> => {
    const send = calls.find(c => c.action === 'send_msg')
    if (send === undefined) throw new Error('no send_msg recorded')
    return (send.params.message as Array<Record<string, unknown>>)[index]
  }

  return { bridge, tool, exec, seed, calls, sentSegment, mediaDir, workspace, otherDir, outside }
}

describe('qq_send_* local-path outbound gate (M1-A3b)', () => {
  it('refuses a workspace file on a member turn without reading or sending it', async () => {
    const h = await makeHarness()
    const sessionId = 'sess-member'
    h.seed(sessionId, 'member')
    const target = join(h.workspace, 'report.txt')
    await writeFile(target, 'member-must-not-send')
    // The file exists inside the admin-only workspace root: a refusal here
    // proves the gate ran BEFORE the read (an unfenced read would succeed).
    await expect(h.tool('qq_send_file').execute({ path: target, chat_id: 'group:20002' }, h.exec(sessionId)))
      .rejects.toThrow(/不在允许的媒体目录内/)
    expect(h.calls).toHaveLength(0)
  })

  it('sends a workspace file on an admin turn (real temp file)', async () => {
    const h = await makeHarness()
    const sessionId = 'sess-admin'
    h.seed(sessionId, 'admin')
    const target = join(h.workspace, 'report.txt')
    await writeFile(target, 'workspace-data')
    const result = await h.tool('qq_send_file').execute({ path: target }, h.exec(sessionId)) as { sent: boolean; messageId: string | null }
    expect(result.sent).toBe(true)
    expect(result.messageId).toBe('42')
    expect(h.sentSegment()).toMatchObject({ type: 'file', data: { file: 'base64://' + Buffer.from('workspace-data').toString('base64') } })
  })

  it('sends mediaDir files on both member and admin turns', async () => {
    const h = await makeHarness()
    const target = join(h.mediaDir, 'media_pic.jpg')
    await writeFile(target, 'media-bytes')
    for (const role of ['member', 'admin'] as const) {
      const sessionId = 'sess-' + role
      h.seed(sessionId, role)
      const result = await h.tool('qq_send_image').execute({ sources: [target] }, h.exec(sessionId)) as { sent: boolean }
      expect(result.sent).toBe(true)
      expect(h.sentSegment()).toMatchObject({ type: 'image', data: { file: 'base64://' + Buffer.from('media-bytes').toString('base64') } })
    }
  })

  it('refuses a symlink inside the workspace that escapes every root (admin turn)', async () => {
    const h = await makeHarness()
    const sessionId = 'sess-admin'
    h.seed(sessionId, 'admin')
    await writeFile(join(h.outside, 'secret.txt'), 'outside-data')
    const link = join(h.workspace, 'innocent.txt')
    await symlink(join(h.outside, 'secret.txt'), link)
    await expect(h.tool('qq_send_image').execute({ sources: [link] }, h.exec(sessionId)))
      .rejects.toThrow(/不在允许的媒体目录内/)
    expect(h.calls).toHaveLength(0)
  })

  it('refuses absolute host paths like /etc/passwd before any read (even admin)', async () => {
    const h = await makeHarness()
    const sessionId = 'sess-admin'
    h.seed(sessionId, 'admin')
    // /etc/passwd exists and is readable on Linux: a missing fence would read
    // it fine, so this refusal proves the check happens before readFile.
    await expect(h.tool('qq_send_file').execute({ path: '/etc/passwd' }, h.exec(sessionId)))
      .rejects.toThrow(/不在允许的媒体目录内/)
    expect(h.calls).toHaveLength(0)
  })

  it('keeps URL sources outside the fence (NapCat fetches them)', async () => {
    const h = await makeHarness()
    const sessionId = 'sess-member'
    h.seed(sessionId, 'member')
    const result = await h.tool('qq_send_image').execute({ sources: ['https://example.com/pic.jpg'] }, h.exec(sessionId)) as { sent: boolean }
    expect(result.sent).toBe(true)
    expect(h.sentSegment()).toMatchObject({ type: 'image', data: { url: 'https://example.com/pic.jpg' } })
  })
})

describe('ChatBridge.mediaSendRoots (M1-A3b roots口径)', () => {
  it('derives roots from the turn-level role: member → mediaDir, admin → mediaDir + workspace', async () => {
    const h = await makeHarness()
    const member = 'acc-member'
    const admin = 'acc-admin'
    h.seed(member, 'member')
    h.seed(admin, 'admin')
    expect(await h.bridge.mediaSendRoots(member)).toEqual({
      roots: [realpathSync(h.mediaDir)],
      isTurnAdmin: false,
    })
    expect(await h.bridge.mediaSendRoots(admin)).toEqual({
      roots: [realpathSync(h.mediaDir), realpathSync(h.workspace)],
      isTurnAdmin: true,
    })
  })

  it('uses the /workspace override directory for admin roots when set', async () => {
    const h = await makeHarness()
    const sessionId = 'acc-ws'
    const chatId = h.seed(sessionId, 'admin')
    ;(h.bridge as unknown as { registry: { getSettings(id: string): { workspacePath?: string } } }).registry.getSettings(chatId).workspacePath = h.otherDir
    expect(await h.bridge.mediaSendRoots(sessionId)).toEqual({
      roots: [realpathSync(h.mediaDir), realpathSync(h.otherDir)],
      isTurnAdmin: true,
    })
  })

  it('fails closed to mediaDir-only for a session with no known chat', async () => {
    const h = await makeHarness()
    // canEditFiles trusts non-QQ sessions (A1), but the media gate does not:
    // no chat → no workspace root, mediaDir only.
    expect(await h.bridge.mediaSendRoots('some-web-session')).toEqual({
      roots: [realpathSync(h.mediaDir)],
      isTurnAdmin: true,
    })
  })
})

describe('qq_send_segments (T10 #6)', () => {
  it('sends each segment as its own separate send_msg bubble, in order', async () => {
    const h = await makeHarness()
    h.seed('group-seg-1', 'admin')
    const sessionId = 'group-seg-1'
    const result = await h.tool('qq_send_segments').execute({
      segments: ['第一段', '第二段', '第三段'],
    }, h.exec(sessionId)) as { sent: boolean; count: number; messageIds: Array<string | null> }
    expect(result.sent).toBe(true)
    expect(result.count).toBe(3)
    const sends = h.calls.filter(c => c.action === 'send_msg')
    expect(sends).toHaveLength(3)
    expect(sends.map(s => (s.params.message as Array<{ data: { text: string } }>)[0].data.text))
      .toEqual(['第一段', '第二段', '第三段'])
  })

  it('rejects empty, over-count, and over-length inputs without sending', async () => {
    const h = await makeHarness()
    h.seed('group-seg-2', 'admin')
    const sessionId = 'group-seg-2'
    const tool = h.tool('qq_send_segments')
    await expect(tool.execute({ segments: [] }, h.exec(sessionId)))
      .rejects.toThrow('qq_send_segments: segments 不能为空')
    await expect(tool.execute({ segments: ['   ', '\n\t'] }, h.exec(sessionId)))
      .rejects.toThrow('qq_send_segments: segments 不能为空')
    await expect(tool.execute({ segments: Array.from({ length: 10 }, (_, i) => '段' + i) }, h.exec(sessionId)))
      .rejects.toThrow('qq_send_segments: 一次最多 9 段')
    await expect(tool.execute({ segments: ['好'.repeat(501)] }, h.exec(sessionId)))
      .rejects.toThrow('qq_send_segments: 每段最多 500 字')
    expect(h.calls.filter(c => c.action === 'send_msg')).toHaveLength(0)
  })
})

/**
 * T14 (#6 补充): qq_send_segments 插件页开关 + 发送间隔。全部用 fake timers
 * 断言延时行为——绝不真实 sleep 多秒（deferred/inject 有真实计时 flaky 先例）。
 * 默认（intervalMs=0）完全不排定时器：若实现误排 setTimeout，await 会挂起
 * 直到测试超时，本身就是失败信号。
 */
describe('qq_send_segments 开关与发送间隔 (T14 #6)', () => {
  it('default intervalMs=0 keeps 0.9.10 behavior: no delay timers, sends in order', async () => {
    vi.useFakeTimers()
    try {
      const h = await makeHarness() // undefined → 模块默认 { enabled: true, intervalMs: 0 }
      h.seed('group-seg-d0', 'admin')
      const result = await h.tool('qq_send_segments').execute({
        segments: ['一', '二', '三'],
      }, h.exec('group-seg-d0')) as { sent: boolean; count: number }
      expect(result.sent).toBe(true)
      expect(result.count).toBe(3)
      expect(h.calls.filter(c => c.action === 'send_msg')).toHaveLength(3)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('enabled=false leaves qq_send_segments unregistered (other tools intact)', async () => {
    const h = await makeHarness({ segments: { enabled: false, intervalMs: 0 } })
    expect(() => h.tool('qq_send_segments')).toThrow('tool not registered: qq_send_segments')
    expect(h.tool('qq_send_image')).toBeTruthy()
    expect(h.tool('qq_send_forward')).toBeTruthy()
  })

  it('global intervalMs waits between consecutive segments (fake timers, no real sleep)', async () => {
    vi.useFakeTimers()
    try {
      const h = await makeHarness({ segments: { enabled: true, intervalMs: 40 } })
      h.seed('group-seg-gi', 'admin')
      const pending = h.tool('qq_send_segments').execute({
        segments: ['甲', '乙', '丙'],
      }, h.exec('group-seg-gi')) as Promise<{ count: number }>
      // 推进 1ms：第一段已发，第二个段还卡在 40ms 间隔定时器上（证明等待真实生效）。
      await vi.advanceTimersByTimeAsync(1)
      expect(h.calls.filter(c => c.action === 'send_msg')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1000)
      const result = await pending
      expect(result.count).toBe(3)
      expect(h.calls.filter(c => c.action === 'send_msg')).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tool intervalMs overrides the global default (0 override = no delay timers)', async () => {
    vi.useFakeTimers()
    try {
      const h = await makeHarness({ segments: { enabled: true, intervalMs: 999 } })
      h.seed('group-seg-ov', 'admin')
      const result = await h.tool('qq_send_segments').execute({
        segments: ['甲', '乙'],
        intervalMs: 0,
      }, h.exec('group-seg-ov')) as { count: number }
      expect(result.count).toBe(2)
      expect(h.calls.filter(c => c.action === 'send_msg')).toHaveLength(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clamps out-of-range tool intervalMs into 0–3000 (5000 → 3000)', async () => {
    vi.useFakeTimers()
    try {
      const h = await makeHarness() // 全局默认 0，仅参数超界
      h.seed('group-seg-cl', 'admin')
      const pending = h.tool('qq_send_segments').execute({
        segments: ['甲', '乙'],
        intervalMs: 5000,
      }, h.exec('group-seg-cl')) as Promise<{ count: number }>
      // clamp 后单段间隔 = 3000ms：推进到 3000 应完成发送；未 clamp（5000）则不会。
      await vi.advanceTimersByTimeAsync(SEGMENTS_INTERVAL_MAX_MS)
      const result = await pending
      expect(result.count).toBe(2)
      expect(h.calls.filter(c => c.action === 'send_msg')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
