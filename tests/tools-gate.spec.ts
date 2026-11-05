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
import { filterBlankTextSegments } from '../src/outbound.js'

interface SendTool {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** Real ChatBridge + registered qq_* tools with a recording connection stub.
 * T14: `segments` installs the qq_send_segments page switches BEFORE tool
 * registration (undefined = module default: enabled, no interval).
 * `respond` lets a test override the canned response per action (e.g.
 * get_group_msg_history).
 * 权限分档 A2: `memberTools` defaults to 'all' here so the media-fence tests
 * below stay purely about the fence; the member-tier gate itself is exercised
 * in its own describe with the production default 'none'. */
async function makeHarness(opts: {
  segments?: { enabled: boolean; intervalMs: number }
  respond?: Record<string, (params: Record<string, unknown>) => unknown>
  memberTools?: 'none' | 'all'
} = {}) {
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
        const respond = opts.respond?.[action]
        if (respond !== undefined) return respond(params)
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
      permissions: { memberTools: opts.memberTools ?? 'all' },
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
  registerTools(ctx, bridge, {
    // qq_group_history talks to the connection directly (send tools go
    // through bridge.sendSegments): same recording + respond stub.
    call: async (action: string, params: Record<string, unknown>) => {
      calls.push({ action, params })
      const respond = opts.respond?.[action]
      if (respond !== undefined) return respond(params)
      return { message_id: 42 }
    },
  } as never, {
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

/**
 * 权限分档 A2（工具硬防线）：成员（非管理员）回合内全部 qq_* 工具在 execute
 * 前被拦截——守卫先于参数校验/媒体栅栏/发送，任何 qq_* 工具一视同仁；
 * 管理员回合与 permissions.memberTools='all' 不受限；无 QQ 会话映射的调用方
 * （Web 等其他通道）不受限。守卫复用 M1-A2 turn-level 角色（seed 即
 * activeTurnRole，fail-closed member）。
 */
describe('qq_* member-tier tool gate (权限分档 A2)', () => {
  it('rejects a member-turn tool call before any send, on every qq_* tool shape', async () => {
    const h = await makeHarness({ memberTools: 'none' })
    const sessionId = 'sess-gate-member'
    h.seed(sessionId, 'member')
    const target = join(h.mediaDir, 'allowed.jpg')
    await writeFile(target, 'bytes')
    for (const [name, args] of [
      ['qq_send_image', { sources: [target] }],
      ['qq_send_file', { path: target }],
      ['qq_send_forward', { messages: [{ name: 'a', content: 'b' }] }],
      ['qq_napcat_api', { action: 'get_group_member_list', params: { group_id: 1 } }],
      ['qq_group_history', { chat_id: 'group:20002' }],
    ] as Array<[string, Record<string, unknown>]>) {
      await expect(h.tool(name).execute(args, h.exec(sessionId)))
        .rejects.toThrow('当前发言人为成员档位，无工具权限：qq_* 工具仅管理员回合可用')
    }
    expect(h.calls).toHaveLength(0)
  })

  it('fires before argument validation (permission error, not the validation error)', async () => {
    const h = await makeHarness({ memberTools: 'none' })
    const sessionId = 'sess-gate-early'
    h.seed(sessionId, 'member')
    await expect(h.tool('qq_send_segments').execute({ segments: [] }, h.exec(sessionId)))
      .rejects.toThrow('当前发言人为成员档位')
    expect(h.calls).toHaveLength(0)
  })

  it('leaves admin turns unrestricted', async () => {
    const h = await makeHarness({ memberTools: 'none' })
    const sessionId = 'sess-gate-admin'
    h.seed(sessionId, 'admin')
    const target = join(h.mediaDir, 'admin.jpg')
    await writeFile(target, 'admin-bytes')
    const result = await h.tool('qq_send_image').execute({ sources: [target] }, h.exec(sessionId)) as { sent: boolean }
    expect(result.sent).toBe(true)
    expect(h.sentSegment()).toMatchObject({ type: 'image' })
  })

  it("permissions.memberTools='all' disables the gate for members", async () => {
    const h = await makeHarness({ memberTools: 'all' })
    const sessionId = 'sess-gate-open'
    h.seed(sessionId, 'member')
    const target = join(h.mediaDir, 'open.jpg')
    await writeFile(target, 'open-bytes')
    const result = await h.tool('qq_send_image').execute({ sources: [target] }, h.exec(sessionId)) as { sent: boolean }
    expect(result.sent).toBe(true)
  })

  it('trusts callers with no QQ session mapping (Web/other channels)', async () => {
    const h = await makeHarness({ memberTools: 'none' })
    // 显式 chat_id + 未映射会话：守卫放行（无 QQ 会话映射不在档位语义内）。
    const result = await h.tool('qq_send_image').execute({ sources: ['https://example.com/pic.jpg'], chat_id: 'group:30001' }, h.exec('some-web-session')) as { sent: boolean }
    expect(result.sent).toBe(true)
    expect(h.calls.filter(c => c.action === 'send_msg')).toHaveLength(1)
  })

  it('absent config fails closed: member is blocked even without the permissions key', async () => {
    const h = await makeHarness({ memberTools: 'none' })
    delete (h.bridge as unknown as { deps: { config: { permissions?: unknown } } }).deps.config.permissions
    const sessionId = 'sess-gate-absent'
    h.seed(sessionId, 'member')
    await expect(h.tool('qq_send_image').execute({ sources: ['https://example.com/pic.jpg'] }, h.exec(sessionId)))
      .rejects.toThrow('当前发言人为成员档位')
    expect(h.calls).toHaveLength(0)
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

  it('#23 point 1: strips Markdown from each segment before sending', async () => {
    const h = await makeHarness()
    const sessionId = 'group-seg-md'
    h.seed(sessionId, 'admin')
    const result = await h.tool('qq_send_segments').execute({
      segments: ['**加粗**的段', '# 标题段', '带 \x60代码\x60 的段'],
    }, h.exec(sessionId)) as { count: number }
    expect(result.count).toBe(3)
    const sends = h.calls.filter(c => c.action === 'send_msg')
    expect(sends.map(s => (s.params.message as Array<{ data: { text: string } }>)[0].data.text))
      .toEqual(['加粗的段', '标题段', '带 代码 的段'])
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

  it('PR #25 评审: 清洗后为空的段被丢弃，count 跟着递减', async () => {
    const h = await makeHarness()
    const sessionId = 'group-seg-drop'
    h.seed(sessionId, 'admin')
    // 第二段是纯分隔线，stripMarkdown 后为空 —— 丢段且不产生空气泡
    const result = await h.tool('qq_send_segments').execute({
      segments: ['第一段', '---', '第三段'],
    }, h.exec(sessionId)) as { count: number; messageIds: Array<string | null> }
    expect(result.count).toBe(2)
    expect(result.messageIds).toHaveLength(2)
    const sends = h.calls.filter(c => c.action === 'send_msg')
    expect(sends.map(s => (s.params.message as Array<{ data: { text: string } }>)[0].data.text))
      .toEqual(['第一段', '第三段'])
  })

  it('PR #25 评审: 全部段清洗后为空时报错而不是发空消息', async () => {
    const h = await makeHarness()
    const sessionId = 'group-seg-empty'
    h.seed(sessionId, 'admin')
    await expect(h.tool('qq_send_segments').execute({
      segments: ['### ', '---'],
    }, h.exec(sessionId))).rejects.toThrow('去掉 Markdown 后没有可发送内容')
    expect(h.calls.filter(c => c.action === 'send_msg')).toHaveLength(0)
  })
})

describe('qq_send_image caption (PR #25 评审同类修复)', () => {
  it('caption 按出站规则清洗后再发，且排在图片之前', async () => {
    const h = await makeHarness()
    h.seed('group-cap-1', 'admin')
    await h.tool('qq_send_image').execute({
      sources: ['https://example.com/pic.jpg'],
      caption: '**加粗**说明 \x60code\x60',
    }, h.exec('group-cap-1'))
    const sends = h.calls.filter(c => c.action === 'send_msg')
    expect(sends).toHaveLength(1)
    const message = sends[0].params.message as Array<{ type: string; data: Record<string, unknown> }>
    expect(message[0]).toEqual({ type: 'text', data: { text: '加粗说明 code' } })
    expect(message[1].type).toBe('image')
  })

  it('caption 清洗后为空时不发文本段（只发图片）', async () => {
    const h = await makeHarness()
    h.seed('group-cap-2', 'admin')
    await h.tool('qq_send_image').execute({
      sources: ['https://example.com/pic.jpg'],
      caption: '--- ',
    }, h.exec('group-cap-2'))
    const sends = h.calls.filter(c => c.action === 'send_msg')
    expect(sends).toHaveLength(1)
    const message = sends[0].params.message as Array<{ type: string }>
    expect(message.every(m => m.type !== 'text')).toBe(true)
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

/**
 * SnowLuma 适配第一批（T1）：qq_group_history 的翻页锚点必须以 message_id
 * 发给协议端（SnowLuma 只认 message_id，不认 NapCat 旧名 message_seq），
 * 以及 sendMsg 出站管线在协议端收口处过滤空/纯空白 text 段（SnowLuma
 * 校验拒绝空白文本段）。
 */
describe('SnowLuma 适配：翻页锚点与空白 text 段 (T1 #2/#7)', () => {
  it('qq_group_history sends the anchor as message_id (not message_seq) to the protocol side', async () => {
    const h = await makeHarness({
      respond: {
        get_group_msg_history: () => ({
          messages: [{
            message_id: 7, time: 111, user_id: 10001,
            sender: { user_id: 10001, nickname: '小明' },
            message: '你好', raw_message: '你好',
          }],
        }),
      },
    })
    h.seed('group-hist-1', 'admin')
    const result = await h.tool('qq_group_history').execute({
      chat_id: 'group:20001', count: 5, message_seq: 777,
    }, h.exec('group-hist-1')) as Array<{ message_id: string }>
    const call = h.calls.find(c => c.action === 'get_group_msg_history')
    expect(call).toBeDefined()
    expect(call!.params).toEqual({ group_id: 20001, count: 5, message_id: 777 })
    expect(Object.hasOwn(call!.params, 'message_seq')).toBe(false)
    expect(result).toEqual([{ message_id: '7', time: '111', user_id: '10001', nickname: '小明', text: '你好' }])
  })

  it('qq_group_history omits the anchor parameter entirely when message_seq is absent', async () => {
    const h = await makeHarness({ respond: { get_group_msg_history: () => ({ messages: [] }) } })
    h.seed('group-hist-2', 'admin')
    await h.tool('qq_group_history').execute({}, h.exec('group-hist-2'))
    const call = h.calls.find(c => c.action === 'get_group_msg_history')!
    expect(call.params).toEqual({ group_id: 20001, count: 20 })
    expect(Object.hasOwn(call.params, 'message_id')).toBe(false)
    expect(Object.hasOwn(call.params, 'message_seq')).toBe(false)
  })

  it('filterBlankTextSegments drops empty/whitespace text segments and keeps the rest', () => {
    const segs = [
      { type: 'text', data: { text: '' } },
      { type: 'text', data: { text: '   \n\t ' } },
      { type: 'text', data: { text: '正文' } },
      { type: 'image', data: { file: 'base64://x' } },
      { type: 'text', data: { text: ' 保留 ' } },
    ]
    expect(filterBlankTextSegments(segs)).toEqual([
      { type: 'text', data: { text: '正文' } },
      { type: 'image', data: { file: 'base64://x' } },
      { type: 'text', data: { text: ' 保留 ' } },
    ])
    // non-text segments always survive
    expect(filterBlankTextSegments([{ type: 'face', data: { id: '1' } }])).toEqual([{ type: 'face', data: { id: '1' } }])
  })

  it('sendMsg on the wire strips blank text segments (mixed → only real content sent)', async () => {
    const h = await makeHarness()
    h.seed('group-blank-1', 'admin')
    const id = await h.bridge.sendSegments('group:20001', [
      { type: 'text', data: { text: '  ' } },
      { type: 'text', data: { text: '' } },
      { type: 'text', data: { text: ' SnowLuma 只认这个 ' } },
    ])
    expect(id).toBe('42')
    const send = h.calls.find(c => c.action === 'send_msg')!
    expect(send.params.group_id).toBe(20001)
    expect(send.params.message).toEqual([{ type: 'text', data: { text: ' SnowLuma 只认这个 ' } }])
  })

  it('sendMsg with only blank text segments sends nothing (no send_msg recorded)', async () => {
    const h = await makeHarness()
    h.seed('group-blank-2', 'admin')
    const id = await h.bridge.sendSegments('group:20001', [
      { type: 'text', data: { text: '' } },
      { type: 'text', data: { text: ' \n\t ' } },
    ])
    expect(id).toBeUndefined()
    expect(h.calls.filter(c => c.action === 'send_msg')).toHaveLength(0)
  })
})
