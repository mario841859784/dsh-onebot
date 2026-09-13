/**
 * Command-surface tests (M2-D1-PR1). Migrated from bridge.spec.ts per the
 * M2-T0 migration map §3.1, re-railed onto the shared tests/helpers stubs;
 * assertions are unchanged from the pre-split suite.
 * @module dsh-onebot/tests/commands
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
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
    const h = await makeCmdHarness({ unknownCommand: 'passthrough' })
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
    // unknownCommand: 'passthrough' restores the pre-R1 fall-through to the model.
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
    // The command context reads the catalog live, so attaching the port after
    // construction is observable exactly like the host wiring (M2-C5b port).
    ;(h.bridge as unknown as { deps: { llmCatalog?: unknown } }).deps.llmCatalog = {
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

    // 2. /model provider model switches the session selection ONLY — the
    //    deployment default (saveSelection) must stay untouched (M2-C5a).
    h.sendText('/model deepseek deepseek-reasoner')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已切换当前会话模型：deepseek/deepseek-reasoner'))).toBe(true)
    })
    expect(chat.selectionRef?.current).toMatchObject({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(saveSelection).not.toHaveBeenCalled()
    // 3. Unknown model for a provider is rejected with the catalog.
    h.sendText('/model deepseek no-such-model')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('没有模型 no-such-model'))).toBe(true)
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('slash /model --default rewrites the deployment default without touching the session selection (M2-C5a)', async () => {
    const saveSelection = vi.fn(async () => undefined)
    const h = await makeCmdHarness({
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
        saveSelection,
      },
    })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const chat = (h.bridge as unknown as { chats: Map<string, { selectionRef: { current: { provider: string; model: string } } | undefined }> }).chats.get('private:10001')!

    h.sendText('/model --default deepseek deepseek-reasoner')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已修改部署默认模型：deepseek/deepseek-reasoner'))).toBe(true)
    })
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(chat.selectionRef?.current).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('slash /model rejects unknown argument combinations with the usage line (M2-C5a)', async () => {
    const saveSelection = vi.fn(async () => undefined)
    const h = await makeCmdHarness({
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
        saveSelection,
      },
    })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))

    h.sendText('/model --default')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('用法：/model'))).toBe(true)
    })
    h.sendText('/model a b c')
    await vi.waitFor(() => {
      expect(h.outbound.filter(f => JSON.stringify(f.params).includes('用法：/model'))).toHaveLength(2)
    })
    expect(saveSelection).not.toHaveBeenCalled()

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

  it('slash /permission relays the host listing, maps QQ aliases, and marks host errors (host forward like /plan)', async () => {
    const commands = { execute: vi.fn(async (_agent: unknown, line: string, signal: AbortSignal | undefined) => {
      if (signal === undefined) throw new Error("Cannot read properties of undefined (reading 'aborted')")
      if (line === '/permission') return { kind: 'success', text: 'current preset workspace-write (available: workspace-write, danger-full-access)' }
      if (line === '/permission workspace-write') return { kind: 'success', text: 'preset workspace-write' }
      if (line === '/permission danger-full-access') return { kind: 'success', text: 'preset danger-full-access' }
      return { kind: 'error', text: `unknown preset "${line.slice('/permission '.length)}" (available: workspace-write, danger-full-access)` }
    }) }
    const h = await makeCmdHarness({ commands })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))

    // 1. Bare form: the host listing is relayed verbatim + the QQ shortcut hint.
    h.sendText('/permission')
    await vi.waitFor(() => {
      expect(commands.execute).toHaveBeenCalledWith(expect.anything(), '/permission', expect.any(AbortSignal))
      const text = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
      expect(text).toContain('current preset workspace-write (available: workspace-write, danger-full-access)')
      expect(text).toContain('/permission w')
    })

    // 2. Aliases resolve on the QQ side; the full preset name is what reaches
    //    the host (each alias maps to its own forwarded line).
    const aliases: Array<[string, string]> = [
      ['w', 'workspace-write'], ['ws', 'workspace-write'], ['write', 'workspace-write'], ['工作区', 'workspace-write'],
      ['f', 'danger-full-access'], ['full', 'danger-full-access'], ['danger', 'danger-full-access'], ['全权', 'danger-full-access'],
    ]
    for (const [alias, preset] of aliases) {
      h.sendText('/permission ' + alias)
      await vi.waitFor(() => {
        expect(commands.execute).toHaveBeenCalledWith(expect.anything(), '/permission ' + preset, expect.any(AbortSignal))
        expect(h.outbound.some(f => JSON.stringify(f.params).includes('preset ' + preset))).toBe(true)
      })
    }

    // 3. Unknown name is forwarded verbatim; the host error reply (with its
    //    available list) is relayed with the ❌ mark.
    h.sendText('/permission nope')
    await vi.waitFor(() => {
      expect(commands.execute).toHaveBeenCalledWith(expect.anything(), '/permission nope', expect.any(AbortSignal))
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('❌ unknown preset \\"nope\\" (available: workspace-write, danger-full-access)'))).toBe(true)
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('slash /permission numeric index resolves against the live available list (no snapshot)', async () => {
    const commands = { execute: vi.fn(async (_agent: unknown, line: string, signal: AbortSignal | undefined) => {
      if (signal === undefined) throw new Error("Cannot read properties of undefined (reading 'aborted')")
      if (line === '/permission') return { kind: 'success', text: 'current preset workspace-write (available: workspace-write, danger-full-access)' }
      if (line === '/permission danger-full-access') return { kind: 'success', text: 'preset danger-full-access' }
      return { kind: 'error', text: `unknown preset "${line.slice('/permission '.length)}" (available: workspace-write, danger-full-access)` }
    }) }
    const h = await makeCmdHarness({ commands })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))

    // 1. /permission 2 = the second entry of the bare listing's available
    //    order (bare pre-flight first, then the switch).
    h.sendText('/permission 2')
    await vi.waitFor(() => {
      const lines = (commands.execute as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1])
      expect(lines).toEqual(['/permission', '/permission danger-full-access'])
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('✅ preset danger-full-access'))).toBe(true)
    })

    // 2. Out-of-range index: usage fallback, host listing still relayed.
    h.sendText('/permission 9')
    await vi.waitFor(() => {
      const text = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
      expect(text).toContain('序号 9 无法解释为可用预设')
      expect(text).toContain('(available: workspace-write, danger-full-access)')
      expect(text).toContain('/permission w')
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('/permission without a live chat asks to open a session first and never reaches the host (same gate as /plan)', async () => {
    const commands = { execute: vi.fn(async () => ({ kind: 'success', text: 'unreachable' })) }
    const h = await makeCmdHarness({ commands })
    h.sendText('/permission')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('请先发一条消息建立会话，再 /permission'))).toBe(true)
    })
    expect(commands.execute).not.toHaveBeenCalled()
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
    for (const name of ['new', 'stop', 'model', 'workspace', 'preset', 'session', 'status', 'retry', 'id', 'ver', 'ocr', 'mode', 'plan', 'permission', 'goal', 'help']) {
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
    for (const name of ['new', 'stop', 'model', 'workspace', 'preset', 'session', 'status', 'retry', 'id', 'ver', 'ocr', 'mode', 'plan', 'permission', 'goal', 'help']) {
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

  it('command table registers exactly the 16 routed commands, one row each, and /help is generated from the table (D1-PR1)', () => {
    // Row order = /help order; the router matches by name so ordering is
    // routing-neutral. Adding a command is exactly one row here.
    expect(COMMANDS.map(c => c.name)).toEqual(['new', 'stop', 'model', 'workspace', 'preset', 'session', 'status', 'retry', 'id', 'ver', 'ocr', 'mode', 'plan', 'permission', 'goal', 'help'])
    expect(COMMANDS).toHaveLength(16)
    expect(new Set(COMMANDS.map(c => c.name)).size).toBe(16)
    for (const c of COMMANDS) {
      expect(c.adminOnly).toBe(true)
      expect(c.help).not.toContain('\n')
    }
    // Byte-identity gate: the table-rendered /help body equals the pre-split
    // hardcoded text verbatim (the harness-level /help test above exercises
    // the real outbound path); the R1 tail line (unknown-command intercept)
    // and the /session and /permission rows are the intentional changes from the pre-split text.
    const rendered = '可用命令：\n' + COMMANDS.map(c => '/' + c.name + ' ' + c.help).join('\n') + '\n\n未知命令默认拦截并提示相近命令；配置 unknownCommand: passthrough 可改为透传给模型。'
    const preSplit = '可用命令：\n/new 开启新会话（清空上下文）\n/stop 停止当前生成\n/model [--default] <provider> <model> 查看或切换模型（--default 改部署默认）\n/workspace [路径|list] 查看或切换工作区\n/preset [id] 查看或切换 agent 预设\n/session [序号] 查看可切回历史会话或切回\n/status 会话全景状态\n/retry 重跑上一条\n/id 查看 session/chat id\n/ver 插件版本\n/ocr 识别最近一张图片\n/mode [interim|instant] 切换出站模式\n/plan [off|内容] 宿主计划模式（/plan off 退出）\n/permission [预设名|w|f] 切换宿主权限预设（w=工作区可写+需审批，f=全权+免审批；无参查看当前）\n/goal [目标|clear] 查看/设置目标\n/help 本帮助\n\n未知命令默认拦截并提示相近命令；配置 unknownCommand: passthrough 可改为透传给模型。'
    expect(rendered).toBe(preSplit)
  })

  it('unknown command with a close match suggests candidates and is consumed (R1)', async () => {
    const h = await makeCmdHarness()
    // Prefix match: /he is a prefix of /help.
    h.sendText('/he')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('未知命令 /he，你是想用 /help吗？'))).toBe(true)
    })
    // Prefix match with several candidates, table order, max shown as /model（/mode）.
    h.sendText('/mo')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('你是想用 /model（/mode）吗？'))).toBe(true)
    })
    // Edit-distance fallback (input length ≥4): /vers ≈ /ver.
    h.sendText('/vers')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('你是想用 /ver吗？'))).toBe(true)
    })
    // All three were consumed: none reached the model.
    expect(h.captured.followups).toHaveLength(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('unknown command without a close match is intercepted by default (unknownCommand: intercept)', async () => {
    const h = await makeCmdHarness()
    h.sendText('/xyzw')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('未知命令 /xyzw。发 /help 查看命令列表'))).toBe(true)
    })
    // Inputs shorter than 4 never use the edit-distance fallback (/xy would be
    // distance 2 from /id), so they stay suggestion-less and just get the hint.
    h.sendText('/xy')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('未知命令 /xy。发 /help 查看命令列表'))).toBe(true)
    })
    expect(h.captured.followups).toHaveLength(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('unknownCommand: passthrough restores the fall-through to the model (R1)', async () => {
    const h = await makeCmdHarness({ unknownCommand: 'passthrough' })
    h.sendText('/xyzw 参数')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('/xyzw')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('a path-like first token (/tmp/x) is not a command and still falls through under default intercept (R1)', async () => {
    const h = await makeCmdHarness()
    h.sendText('/tmp/x 不是命令')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('/tmp/x')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('non-admin unknown slash commands still hit the admin gate, not the suggestion path (R1 regression)', async () => {
    const h = await makeCmdHarness()
    // /hellp would suggest /help — but the admin gate runs first.
    h.sendGroupTextAs('/hellp', 20002)
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('仅管理员可用'))).toBe(true)
    })
    expect(h.outbound.some(f => JSON.stringify(f.params).includes('你是想用'))).toBe(false)
    expect(h.captured.followups).toHaveLength(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('commands · serial selection (R2)', () => {
  const registryOf = (h: Awaited<ReturnType<typeof makeCmdHarness>>) =>
    (h.bridge as unknown as { registry: { getSettings(id: string): { pendingSelection?: { kind: string; phase?: string; provider?: string; items: Array<{ payload: string }>; createdAt: number } } } }).registry
  const pendingOf = (h: Awaited<ReturnType<typeof makeCmdHarness>>) => registryOf(h).getSettings('private:10001').pendingSelection

  const wsRegistry = (mediaDir: string, otherDir: string) => ({
    resolveByPath: vi.fn(async () => undefined),
    create: vi.fn(),
    list: vi.fn(() => [
      { id: 'w-cur', path: mediaDir, sessionIds: ['s1'], attachSession: vi.fn() },
      { id: 'w-other', path: otherDir, sessionIds: [], attachSession: vi.fn() },
    ]),
  })

  it('/workspace bare form renders a numbered snapshot with the current marker; /workspace <序号> runs the original switch path', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'onebot-ws2-'))
    const h = await makeCmdHarness()
    ;(h.bridge as unknown as { deps: { workspaceRegistry?: unknown } }).deps.workspaceRegistry = wsRegistry(h.mediaDir, otherDir)
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))

    h.sendText('/workspace')
    await vi.waitFor(() => {
      const text = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
      expect(text).toContain('当前工作目录：')
      expect(text).toContain('1. ' + h.mediaDir + '（1 会话） ← 当前')
      expect(text).toContain('2. ' + otherDir + '（0 会话）')
      expect(text).toContain('回复 /workspace <序号> 切换')
    })
    expect(pendingOf(h)?.kind).toBe('workspace')
    expect(pendingOf(h)?.items.map(i => i.payload)).toEqual([h.mediaDir, otherDir])

    // A non-selection command must not disturb the pending snapshot.
    h.sendText('/status')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('chat    : private:10001'))).toBe(true)
    })
    expect(pendingOf(h)?.kind).toBe('workspace')

    // /workspace 2 → the picked path re-enters the ORIGINAL switch path.
    h.sendText('/workspace 2')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('工作区已切换'))).toBe(true)
    })
    expect(pendingOf(h)).toBeUndefined()
    h.sendText('新工作区的第一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    const chats = (h.bridge as unknown as { chats: Map<string, { agent: { session: { header: { cwd: string } } } }> }).chats
    expect(chats.get('private:10001')!.agent.session.header.cwd).toBe(realpathSync(otherDir))

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('/workspace <序号> out of range keeps the snapshot so the user can retry without re-listing', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'onebot-ws3-'))
    const h = await makeCmdHarness()
    ;(h.bridge as unknown as { deps: { workspaceRegistry?: unknown } }).deps.workspaceRegistry = wsRegistry(h.mediaDir, otherDir)
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.sendText('/workspace')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('工作区列表'))).toBe(true)
    })

    h.sendText('/workspace 9')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('序号越界，请回复 /workspace 重新查看列表'))).toBe(true)
    })
    // Deliberately retained for a retry.
    expect(pendingOf(h)?.items).toHaveLength(2)

    h.sendText('/workspace 1')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('工作区已切换'))).toBe(true)
    })
    expect(pendingOf(h)).toBeUndefined()

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('expired pending selection: numeric replies get the lazy-TTL hint and the snapshot clears', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'onebot-ws4-'))
    const h = await makeCmdHarness()
    ;(h.bridge as unknown as { deps: { workspaceRegistry?: unknown } }).deps.workspaceRegistry = wsRegistry(h.mediaDir, otherDir)
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.sendText('/workspace')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('工作区列表'))).toBe(true)
    })

    // Lazy TTL (no timer): age the snapshot past the 5-minute window by hand.
    const settings = registryOf(h).getSettings('private:10001')
    settings.pendingSelection!.createdAt = Date.now() - 6 * 60_000
    h.sendText('/workspace 1')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('序号选择已过期，请重新执行 /workspace 查看'))).toBe(true)
    })
    expect(settings.pendingSelection).toBeUndefined()

    // Cleared → the next numeric input is back to the original path semantics.
    h.sendText('/workspace 123')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('❌ 目录无效或不可访问：123'))).toBe(true)
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('pure-numeric args keep the original semantics when no live snapshot exists', async () => {
    const resolve = vi.fn(async (id?: string) => {
      throw new Error('unknown preset ' + id)
    })
    const h = await makeCmdHarness({
      agentPresets: { defaultId: 'standard', resolve, mount: vi.fn() },
    })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))

    h.sendText('/workspace 123')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('❌ 目录无效或不可访问：123'))).toBe(true)
    })
    h.sendText('/model 123')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('用法：/model <provider> <model>'))).toBe(true)
    })
    h.sendText('/preset 123')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('❌ 预设不存在：123'))).toBe(true)
    })
    expect(pendingOf(h)).toBeUndefined()

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('/model two-level serial selection: providers → models → session-only switch; --default unaffected', async () => {
    const saveSelection = vi.fn(async () => undefined)
    const h = await makeCmdHarness({
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
        saveSelection,
      },
    })
    ;(h.bridge as unknown as { deps: { llmCatalog?: unknown } }).deps.llmCatalog = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'openai', name: 'OpenAI' }],
      listModels: async (provider: string) => provider === 'openai'
        ? [{ provider, id: 'gpt-4o' }, { provider, id: 'gpt-4o-mini' }]
        : [{ provider, id: 'deepseek-chat' }, { provider, id: 'deepseek-reasoner' }],
    }
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const chat = (h.bridge as unknown as { chats: Map<string, { selectionRef: { current: { provider: string; model: string } } | undefined }> }).chats.get('private:10001')!

    // Level 0 → 1: the bare form numbers the providers and snapshots them.
    h.sendText('/model')
    await vi.waitFor(() => {
      const text = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
      expect(text).toContain('当前模型：deepseek/deepseek-chat')
      expect(text).toContain('1. deepseek')
      expect(text).toContain('2. openai')
      expect(text).toContain('回复 /model <序号> 查看该来源的模型')
    })
    expect(pendingOf(h)).toMatchObject({ kind: 'model', phase: 'providers' })
    expect(pendingOf(h)?.items.map(i => i.payload)).toEqual(['deepseek', 'openai'])

    // Level 1 → 2: /model 2 lists that provider's models.
    h.sendText('/model 2')
    await vi.waitFor(() => {
      const text = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
      expect(text).toContain('模型列表（openai）')
      expect(text).toContain('1. gpt-4o')
      expect(text).toContain('2. gpt-4o-mini')
    })
    expect(pendingOf(h)).toMatchObject({ kind: 'model', phase: 'models', provider: 'openai' })

    // Level-2 hit: /model 1 switches ONLY the session selection (original path).
    h.sendText('/model 1')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已切换当前会话模型：openai/gpt-4o'))).toBe(true)
    })
    expect(chat.selectionRef?.current).toMatchObject({ provider: 'openai', model: 'gpt-4o' })
    expect(saveSelection).not.toHaveBeenCalled()
    expect(pendingOf(h)).toBeUndefined()

    // --default regression with the selection machinery present (not numeric).
    h.sendText('/model --default deepseek deepseek-reasoner')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已修改部署默认模型：deepseek/deepseek-reasoner'))).toBe(true)
    })
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(chat.selectionRef?.current).toMatchObject({ provider: 'openai', model: 'gpt-4o' })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('/preset bare form numbers the presets; /preset <序号> runs the original switch path; out of range retains', async () => {
    const home = mkdtempSync(join(tmpdir(), 'onebot-home2-'))
    await mkdir(join(home, '.agent-presets', 'alpha'), { recursive: true })
    await mkdir(join(home, '.agent-presets', 'beta'), { recursive: true })
    await writeFile(join(home, '.agent-presets', 'alpha', 'preset.yml'), 'name: 阿尔法\n')
    const resolve = vi.fn(async (id?: string) => {
      if (id === 'alpha' || id === 'beta') return { id }
      throw new Error('unknown preset ' + id)
    })
    const h = await makeCmdHarness({
      dshHome: home,
      agentPresets: { defaultId: 'standard', resolve, mount: vi.fn(async () => ({ id: 'beta' })) },
    })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))

    h.sendText('/preset')
    await vi.waitFor(() => {
      const text = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
      expect(text).toContain('当前预设：standard')
      expect(text).toContain('1. alpha（阿尔法）')
      expect(text).toContain('2. beta')
      expect(text).toContain('回复 /preset <序号> 切换')
    })
    expect(pendingOf(h)?.items.map(i => i.payload)).toEqual(['alpha', 'beta'])

    h.sendText('/preset 9')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('序号越界，请回复 /preset 重新查看列表'))).toBe(true)
    })
    expect(pendingOf(h)?.items).toHaveLength(2)

    h.sendText('/preset 2')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('预设已切换：beta'))).toBe(true)
    })
    expect(pendingOf(h)).toBeUndefined()
    h.sendText('下一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.capturedMeta[1].agentPreset).toBe('beta')

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})
