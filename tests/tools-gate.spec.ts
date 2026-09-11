/**
 * Outbound media gate wiring (M1-A3b): the qq_send_* tools read local files
 * only inside the calling session's mediaSendRoots — the plugin media dir
 * always, plus the chat workspace on admin turns (M1-A2 turn-level role).
 * A real ChatBridge carries the role state (seeded like bridge.spec seeds
 * its private maps); the connection is a recording stub, so nothing hits
 * the network and every assertion on sends reads recorded send_msg params.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { ChatBridge } from '../src/bridge.js'
import { registerTools } from '../src/tools.js'

interface SendTool {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** Real ChatBridge + registered qq_* tools with a recording connection stub. */
async function makeHarness() {
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
      botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
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
    ;(h.bridge as unknown as { chatWorkspacePaths: Map<string, string> }).chatWorkspacePaths.set(chatId, h.otherDir)
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
