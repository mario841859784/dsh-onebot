/**
 * Command-surface tests (M2-D1-PR1). Migrated from bridge.spec.ts per the
 * M2-T0 migration map §3.1, re-railed onto the shared tests/helpers stubs;
 * assertions are unchanged from the pre-split suite.
 * @module dsh-onebot/tests/commands
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { COMMANDS } from '../src/commands.js'
import { MediaStore } from '../src/media.js'
import { makeCmdHarness } from './helpers/bridge-harness.js'

describe('commands', () => {
  it('routes slash commands before the model: /new opens a fresh session', async () => {
    const h = await makeCmdHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const oldSession = h.sessionIds[0]
    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })
    expect(h.captured.followups).toHaveLength(1) // /new never reaches the model
    h.sendText('第二条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].sessionId).not.toBe(oldSession)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('routes slash commands before the model: /stop cancels, unknown goes to the model', async () => {
    const h = await makeCmdHarness()
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    // Mark the agent running, then /stop must cancel it.
    const agent = (h.bridge as unknown as { chats: Map<string, { agent: { status: string; cancel: (c: unknown) => void } }> }).chats.get('private:10001')?.agent
    expect(agent).toBeDefined()
    agent!.status = 'running'
    h.sendText('/stop')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已停止生成'))).toBe(true)
    })
    expect(agent!.status).toBe('idle')
    expect(h.captured.followups).toHaveLength(1)
    // Unknown commands fall through to the model.
    h.sendText('/unknowncmd 参数')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].text).toContain('/unknowncmd')
    // A path is not a command.
    h.sendText('请查看 /tmp/x 文件')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('blocks slash commands for non-admin users', async () => {
    const h = await makeCmdHarness()
    // Group message from a non-admin member, @-mentioning the bot, with /help.
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'group', user_id: 20002, group_id: 888, self_id: 10002,
      message: [
        { type: 'at', data: { qq: '10002' } },
        { type: 'text', data: { text: '/help' } },
      ],
      raw_message: '[CQ:at,qq=10002]/help',
      sender: { user_id: 20002, nickname: '路人' },
    }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('仅管理员可用'))).toBe(true)
    })
    expect(h.captured.followups).toHaveLength(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('slash /new retires the chat agent and starts a fresh session on the next message', async () => {
    const h = await makeCmdHarness()
    // 1. Normal message lands on the first session.
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.sessionIds).toHaveLength(1)
    // 2. /new must NOT reach the agent; a confirmation is sent directly and
    //    the next message starts a fresh (suffixed) session.
    h.sendText('/new')
    await vi.waitFor(() => expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('已开启新会话'))).toBe(true))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.sendText('新对话的第一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.sessionIds).toHaveLength(2)
    expect(h.sessionIds[1]).toMatch(/^onebot-private-10001-[a-z0-9]+$/)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('slash /model shows the current model and switches with provider/model', async () => {
    const saveSelection = vi.fn(async () => undefined)
    const h = await makeCmdHarness({
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
        saveSelection,
      },
    })
    // The command context reads ctx.llm live, so attaching the catalog after
    // construction is observable exactly like the host wiring.
    ;(h.ctx as unknown as { llm: unknown }).llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-chat' }, { provider: 'deepseek', id: 'deepseek-reasoner' }],
    }
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const chat = (h.bridge as unknown as { chats: Map<string, { agent: { session: { id: string } }, selectionRef: { current: { provider: string; model: string } } | undefined }> }).chats.get('private:10001')!

    // 1. /model without args shows the current model and provider catalog.
    h.sendText('/model')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('当前模型：deepseek/deepseek-chat'))).toBe(true)
    })

    // 2. /model provider model switches the live selection and persists it.
    h.sendText('/model deepseek deepseek-reasoner')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已切换模型：deepseek/deepseek-reasoner'))).toBe(true)
    })
    expect(chat.selectionRef?.current).toMatchObject({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'deepseek', model: 'deepseek-reasoner' })

    // 3. Unknown model for a provider is rejected with the catalog.
    h.sendText('/model deepseek no-such-model')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('没有模型 no-such-model'))).toBe(true)
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('slash /workspace switches the directory for the next session', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'onebot-other-'))
    const h = await makeCmdHarness({
      workspaceRegistry: {
        resolveByPath: vi.fn(async () => undefined),
        create: vi.fn(async (path: string) => ({ id: 'w1', path, sessionIds: [], attachSession: vi.fn(async () => undefined) })),
        list: vi.fn(() => []),
      },
    })

    // 1. First session is created under the configured workspacePath.
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.sessionIds).toHaveLength(1)

    // 2. /workspace <dir> switches, retires the current agent, and the next
    //    message creates a fresh session under the new directory.
    h.sendText('/workspace ' + otherDir)
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('工作区已切换'))).toBe(true)
    })
    h.sendText('新工作区的第一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.sessionIds).toHaveLength(2)
    const chats = (h.bridge as unknown as { chats: Map<string, { agent: { session: { header: { cwd: string } } } }> }).chats
    // The bridge stores the realpath'd directory; macOS /var is a symlink to
    // /private/var, so normalize the expectation the same way.
    expect(chats.get('private:10001')!.agent.session.header.cwd).toBe(realpathSync(otherDir))

    // 3. Invalid path is rejected.
    h.sendText('/workspace /nonexistent/definitely/not/here')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('目录无效'))).toBe(true)
    })
    expect(chats.get('private:10001')!.agent.session.header.cwd).toBe(realpathSync(otherDir))

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

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

  it('slash /goal /plan /mode set per-chat state and forward to host plan command', async () => {
    const commands = { execute: vi.fn(async () => ({ kind: 'success', text: 'Plan mode on. Use /plan off to leave.' })) }
    const h = await makeCmdHarness({ commands })

    // /goal stays a native per-chat prefix.
    h.sendText('/goal 验证 9 个命令')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('目标已记录'))).toBe(true)
    })
    h.sendText('普通消息')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('【当前目标】验证 9 个命令')

    // /plan forwards to the host plan command (no 【计划模式】 prefix anymore).
    h.sendText('/plan')
    await vi.waitFor(() => {
      expect(commands.execute).toHaveBeenCalledWith(expect.anything(), '/plan', expect.any(AbortSignal))
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('Plan mode on. Use /plan off to leave.'))).toBe(true)
    })
    h.sendText('/plan 写一个新模块')
    await vi.waitFor(() => {
      expect(commands.execute).toHaveBeenCalledWith(expect.anything(), '/plan 写一个新模块', expect.any(AbortSignal))
    })
    h.sendText('/plan off')
    await vi.waitFor(() => {
      expect(commands.execute).toHaveBeenCalledWith(expect.anything(), '/plan off', expect.any(AbortSignal))
    })
    // No 【计划模式】 prefix on normal turns.
    h.sendText('再来一轮')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].text).not.toContain('【计划模式】')

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
    ;(h.bridge as unknown as { registry: { getSettings(id: string): { lastImagePath?: string } } }).registry.getSettings('private:10001').lastImagePath = png
    h.sendText('/ocr')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('第一行文字'))).toBe(true)
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('第二行文字'))).toBe(true)
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('command messages carrying media skip media downloads (M1-C6a)', async () => {
    const h = await makeCmdHarness()
    const media = (h.bridge as unknown as { deps: { media: MediaStore } }).deps.media
    let downloads = 0
    const realDownload = media.downloadUrl.bind(media)
    media.downloadUrl = async (...args: Parameters<MediaStore['downloadUrl']>) => {
      downloads += 1
      return await realDownload(...args)
    }
    // '/help' text first so the message parses as a command; the attached
    // image must NOT be downloaded before the command consumes the message.
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [
        { type: 'text', data: { text: '/help ' } },
        { type: 'image', data: { url: 'http://127.0.0.1:1/a.png' } },
      ],
      raw_message: '/help [CQ:image,url=http://127.0.0.1:1/a.png]',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('可用命令'))).toBe(true)
    })
    expect(downloads).toBe(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('/ocr resolves the image registered from a command message (M1-C6a)', async () => {
    const h = await makeCmdHarness({ ocrResult: { texts: [{ text: '命令消息里的图片' }] } })
    const media = (h.bridge as unknown as { deps: { media: MediaStore } }).deps.media
    let downloads = 0
    const realDownload = media.downloadUrl.bind(media)
    media.downloadUrl = async (...args: Parameters<MediaStore['downloadUrl']>) => {
      downloads += 1
      return await realDownload(...args)
    }
    // base64 image: materialized locally without downloadUrl, so the lazy
    // /ocr resolution is fully observable (download count must stay 0).
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [
        { type: 'text', data: { text: '/ocr ' } },
        { type: 'image', data: { file: 'base64://' + png } },
      ],
      raw_message: '/ocr [CQ:image,file=base64://...]',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('命令消息里的图片'))).toBe(true)
    })
    expect(downloads).toBe(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('slash /help lists the full routed command table for an admin (M2-T0 command table)', async () => {
    const h = await makeCmdHarness()
    h.sendText('/help')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('可用命令'))).toBe(true)
    })
    const helpText = h.outbound.filter(f => f.action === 'send_msg').map(f => JSON.stringify(f.params)).join('\n')
    for (const name of ['new', 'stop', 'model', 'workspace', 'preset', 'status', 'retry', 'id', 'ver', 'ocr', 'mode', 'plan', 'goal', 'help']) {
      expect(helpText).toContain('/' + name)
    }
    expect(h.captured.followups).toHaveLength(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('rejects every routed slash command for a non-admin with no side effects (M2-T0 command table)', async () => {
    const commands = { execute: vi.fn(async () => ({ kind: 'success', text: 'unreachable' })) }
    const h = await makeCmdHarness({ commands })
    for (const name of ['new', 'stop', 'model', 'workspace', 'preset', 'status', 'retry', 'id', 'ver', 'ocr', 'mode', 'plan', 'goal', 'help']) {
      const before = h.outbound.length
      h.sendGroupTextAs('/' + name, 20002)
      await vi.waitFor(() => {
        expect(h.outbound.slice(before).some(f => JSON.stringify(f.params).includes('仅管理员可用'))).toBe(true)
      })
      expect(h.outbound.slice(before).filter(f => f.action === 'send_msg')).toHaveLength(1)
    }
    expect(h.captured.followups).toHaveLength(0)
    expect(h.chats().size).toBe(0)
    expect(commands.execute).not.toHaveBeenCalled()
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('command table registers exactly the 14 routed commands, one row each, and /help is generated from the table (D1-PR1)', () => {
    // Row order = /help order; the router matches by name so ordering is
    // routing-neutral. Adding a command is exactly one row here.
    expect(COMMANDS.map(c => c.name)).toEqual(['new', 'stop', 'model', 'workspace', 'preset', 'status', 'retry', 'id', 'ver', 'ocr', 'mode', 'plan', 'goal', 'help'])
    expect(COMMANDS).toHaveLength(14)
    expect(new Set(COMMANDS.map(c => c.name)).size).toBe(14)
    for (const c of COMMANDS) {
      expect(c.adminOnly).toBe(true)
      expect(c.help).not.toContain('\n')
    }
    // Byte-identity gate: the table-rendered /help body equals the pre-split
    // hardcoded text verbatim (the harness-level /help test above exercises
    // the real outbound path).
    const rendered = '可用命令：\n' + COMMANDS.map(c => '/' + c.name + ' ' + c.help).join('\n') + '\n\n其他 / 开头的文本会直接交给模型。'
    const preSplit = '可用命令：\n/new 开启新会话（清空上下文）\n/stop 停止当前生成\n/model [provider/model] 查看或切换模型\n/workspace [路径|list] 查看或切换工作区\n/preset [id] 查看或切换 agent 预设\n/status 会话全景状态\n/retry 重跑上一条\n/id 查看 session/chat id\n/ver 插件版本\n/ocr 识别最近一张图片\n/mode [interim|instant] 切换出站模式\n/plan [off|内容] 宿主计划模式（/plan off 退出）\n/goal [目标|clear] 查看/设置目标\n/help 本帮助\n\n其他 / 开头的文本会直接交给模型。'
    expect(rendered).toBe(preSplit)
  })
})
