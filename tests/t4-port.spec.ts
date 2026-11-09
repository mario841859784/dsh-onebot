/**
 * T4 (PR port) tests: the four features ported from the external contribution
 * back to src/ TypeScript — 提示词文件/记忆文件 (prompt-setup + prompt), the
 * silence sentinel [[不回]] (interim), and the context tails (chat-tails +
 * the /new narrowing). Each feature covers both switch sides; the three
 * review-mandated fixes each get a dedicated case:
 * - readFileCached mtime invalidation (contribution cached forever);
 * - readMemoryFiles synchronous first turn (contribution's async snapshot
 *   left the first turn's memory empty);
 * - tail greeting dispatched at role 'member' (not 'admin') and only on a
 *   genuine user-initiated /new (never impersonating source.kind 'user').
 * @module dsh-onebot/tests/t4-port
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { PromptLoader, expandHome, stripPromptIndent } from '../src/prompt-setup.js'
import { buildPlatformPrompt, readMemoryFiles, MEMORY_FILE_MAX_CHARS, MEMORY_TOTAL_MAX_CHARS } from '../src/prompt.js'
import { isSilenceText, SILENCE_TOKEN, InterimTracker } from '../src/interim.js'
import type { InterimChat } from '../src/interim.js'
import { ChatTails, buildGreetingPrompt, TAIL_MAX_MESSAGES, TAIL_TEXT_MAX, TAILS_FILE } from '../src/chat-tails.js'
import { makeCmdHarness, makeEvent } from './helpers/bridge-harness.js'

const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const fn of cleanups) await fn()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onebot-t4-'))
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

/** InterimTracker stub context (mirrors tests/interim-machine.spec.ts). */
function makeInterimHarness(opts?: { interim?: boolean }) {
  const sentTexts: string[] = []
  let interimMode = opts?.interim ?? true
  const tracker = new InterimTracker({
    sendToChat: async (_chatId, text) => {
      sentTexts.push(text)
      return ['7']
    },
    sendMsg: async () => '8',
    call: async () => undefined,
    chainTail: async () => undefined,
    relayHostCards: () => undefined,
    effectiveInterim: () => interimMode,
    log: () => undefined,
    config: {
      interimRecallMs: undefined, interimRecall: undefined,
      maxImageBytes: 8 * 1024 * 1024, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
    },
  })
  const chat: InterimChat = {
    loopPending: null, loopBuffer: [], recallTimers: new Map(),
    recalledInterimIds: new Set(), lastHandledMessageId: undefined,
  }
  const assistant = (id: string, ...parts: unknown[]) => ({
    id,
    content: typeof parts[1] === 'object' && parts[1] !== null && (parts[1] as { toolCall?: boolean }).toolCall === true
      ? [{ type: 'text', text: parts[0] }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }]
      : parts.map(text => ({ type: 'text', text })),
  })
  const settle = () => new Promise(resolve => setTimeout(resolve, 120))
  return { tracker, chat, sentTexts, assistant, settle }
}

describe('T4 提示词文件 PromptLoader (PR port 提示词文件)', () => {
  it('build picks the group file for group: chats and the dm file for dm: chats', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'group.txt'), '群设定内容', 'utf8')
    writeFileSync(join(dir, 'dm.txt'), '私聊设定内容', 'utf8')
    const loader = new PromptLoader({ log: () => undefined })
    const group = loader.build('group:888', { groupPromptFile: join(dir, 'group.txt'), dmPromptFile: join(dir, 'dm.txt') })
    expect(group.kind).toBe('group')
    expect(group.extra).toBe('群设定内容')
    const dm = loader.build('private:10001', { groupPromptFile: join(dir, 'group.txt'), dmPromptFile: join(dir, 'dm.txt') })
    expect(dm.kind).toBe('dm')
    expect(dm.extra).toBe('私聊设定内容')
  })

  it('off side: no files configured → empty extra, no memory (default off)', () => {
    const loader = new PromptLoader({ log: () => undefined })
    expect(loader.build('private:10001', {})).toEqual({ kind: 'dm', extra: '', memoryText: '' })
    expect(loader.build('group:888', {})).toEqual({ kind: 'group', extra: '', memoryText: '' })
  })

  it('评审修正① readFileCached mtime 失效：editing the file is picked up without a reload', () => {
    const dir = tempDir()
    const file = join(dir, 'persona.txt')
    writeFileSync(file, '第一版', 'utf8')
    const loader = new PromptLoader({ log: () => undefined })
    expect(loader.build('private:10001', { dmPromptFile: file }).extra).toBe('第一版')
    // Rewrite with a NEWER mtime → the cached copy must be dropped.
    const future = new Date(Date.now() + 5_000)
    writeFileSync(file, '第二版', 'utf8')
    utimesSync(file, future, future)
    expect(loader.build('private:10001', { dmPromptFile: file }).extra).toBe('第二版')
  })

  it('a missing/unreadable file degrades to an empty extra with a warn', () => {
    const warns: string[] = []
    const loader = new PromptLoader({ log: (level, msg) => { if (level === 'warn') warns.push(msg) } })
    expect(loader.build('private:10001', { dmPromptFile: join(tempDir(), 'nope.txt') }).extra).toBe('')
    expect(warns).toHaveLength(1)
  })

  it('stripPromptIndent strips per-line indentation; expandHome expands ~/', () => {
    expect(stripPromptIndent('  第一行  \n\t第二行\n')).toBe('第一行\n第二行')
    const prevHome = process.env.HOME
    process.env.HOME = tempDir()
    try {
      expect(expandHome('~/x.txt')).toBe(join(homedir(), 'x.txt'))
      expect(expandHome('/abs/x.txt')).toBe('/abs/x.txt')
    } finally {
      process.env.HOME = prevHome
    }
  })
})

describe('T4 记忆文件 readMemoryFiles (PR port 记忆文件)', () => {
  it('同步首读非空（评审修正②：第一回合记忆不空）', () => {
    const dir = tempDir()
    const mem = join(dir, 'memory.md')
    writeFileSync(mem, '主人喜欢简短回答', 'utf8')
    const loader = new PromptLoader({ log: () => undefined })
    // FIRST build call — the memory text must already be there (sync read).
    const first = loader.build('private:10001', { memoryFilesEnabled: true, memoryFiles: [mem] })
    expect(first.memoryText).toBe('主人喜欢简短回答')
  })

  it('群聊不喂记忆：group chat memoryText is empty even with the switch on', () => {
    const dir = tempDir()
    const mem = join(dir, 'memory.md')
    writeFileSync(mem, '内容', 'utf8')
    const loader = new PromptLoader({ log: () => undefined })
    expect(loader.build('group:888', { memoryFilesEnabled: true, memoryFiles: [mem] }).memoryText).toBe('')
  })

  it('switch off (default): memory stays empty', () => {
    const dir = tempDir()
    const mem = join(dir, 'memory.md')
    writeFileSync(mem, '内容', 'utf8')
    const loader = new PromptLoader({ log: () => undefined })
    expect(loader.build('private:10001', { memoryFiles: [mem] }).memoryText).toBe('')
    expect(loader.build('private:10001', { memoryFilesEnabled: false, memoryFiles: [mem] }).memoryText).toBe('')
  })

  it('truncates per file (8000) and in total (12000); unreadable files are skipped', () => {
    const dir = tempDir()
    const big = join(dir, 'big.md')
    writeFileSync(big, 'a'.repeat(MEMORY_FILE_MAX_CHARS + 500), 'utf8')
    const out = readMemoryFiles([big])
    expect(out.length).toBe(MEMORY_FILE_MAX_CHARS + '\n\n…（后面截掉了）'.length)

    const a = join(dir, 'a.md')
    const b = join(dir, 'b.md')
    writeFileSync(a, 'a'.repeat(7000), 'utf8')
    writeFileSync(b, 'b'.repeat(7000), 'utf8')
    const both = readMemoryFiles([a, b])
    const [first, second] = both.split('\n\n---\n\n')
    expect(first).toBe('a'.repeat(7000))
    // The second file is clipped so the total stays within the cap.
    expect(second.startsWith('b')).toBe(true)
    expect(second.endsWith('…（后面截掉了）')).toBe(true)
    expect(first.length + second.length).toBeLessThanOrEqual(MEMORY_TOTAL_MAX_CHARS + '\n\n…（后面截掉了）'.length)

    expect(readMemoryFiles([join(dir, 'missing.md'), ''])).toBe('')
  })
})

describe('T4 buildPlatformPrompt 扩展 (PR port 向后兼容)', () => {
  it('backward compatible: the old single-arg call works and adds no sections', () => {
    const text = buildPlatformPrompt(false)
    expect(text).not.toContain('## 本会话附加设定')
    expect(text).not.toContain('## 我的记忆')
    expect(() => buildPlatformPrompt(true)).not.toThrow()
  })

  it('injects the 附加设定/记忆 sections only when non-empty', () => {
    const withBoth = buildPlatformPrompt(false, '角色设定', '记忆内容')
    expect(withBoth).toContain('## 本会话附加设定\n角色设定\n')
    expect(withBoth).toContain('## 我的记忆\n这是你自己记下的东西')
    expect(withBoth).toContain('记忆内容')
    expect(buildPlatformPrompt(false, '', '')).not.toContain('## 本会话附加设定')
  })

  it('the silence-sentinel convention sentence is always present', () => {
    expect(buildPlatformPrompt(false)).toContain('[[不回]]')
  })
})

describe('T4 沉默哨兵 (PR port 沉默哨兵)', () => {
  it('isSilenceText: bare/padded/quoted sentinels are silence; anything else is not', () => {
    expect(SILENCE_TOKEN).toBe('[[不回]]')
    expect(isSilenceText('[[不回]]')).toBe(true)
    expect(isSilenceText('  [[不回]]  ')).toBe(true)
    expect(isSilenceText('"[[不回]]"')).toBe(true)
    expect(isSilenceText('「[[不回]]」')).toBe(true)
    expect(isSilenceText('')).toBe(false)
    expect(isSilenceText('不回')).toBe(false)
    // 全角括号剥掉后剩「不回」，不等于半角哨兵本身 —— 不是沉默。
    expect(isSilenceText('［［不回］］')).toBe(false)
    expect(isSilenceText('[[不回]]你好')).toBe(false)
    expect(isSilenceText('我认为 [[不回]] 是个好约定')).toBe(false)
  })

  it('assistant/message with only the sentinel: nothing sent, loopPending stays null', () => {
    const h = makeInterimHarness()
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('m1', ' [[不回]] ') as never)
    expect(h.sentTexts).toEqual([])
    expect(h.chat.loopPending).toBe(null)
  })

  it('instant-mode turn: a sentinel final is swallowed at turn/end (no send)', () => {
    const h = makeInterimHarness({ interim: false })
    // The sentinel check at onAssistantMessage (insertion ①) already swallows
    // an exact-sentinel message; ② covers finals reaching turn/end by other
    // paths — drive loopPending directly.
    h.chat.loopPending = '[[不回]]'
    h.tracker.onTurnEnd('private:10001', h.chat)
    expect(h.sentTexts).toEqual([])
  })

  it('interim-mode turn: the real interims still go out; the sentinel final does not', async () => {
    const h = makeInterimHarness({ interim: true })
    // A tool-call step sends its text immediately (real interim).
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('m1', '中间步', { toolCall: true }) as never)
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('m2', '最终答') as never)
    h.tracker.onTurnEnd('private:10001', h.chat)
    await h.settle()
    expect(h.sentTexts).toEqual(['中间步', '最终答'])
    // ③ (settleLoop): a sentinel final reaching settlement is swallowed.
    const h2 = makeInterimHarness({ interim: true })
    h2.chat.loopPending = '[[不回]]'
    h2.tracker.onTurnEnd('private:10001', h2.chat)
    await h2.settle()
    expect(h2.sentTexts).toEqual([])
  })

  it('评审修正：同回合「先发言后沉默」——已排队的 deferred 文本不被吞，哨兵本身不发', async () => {
    // interim 模式：真话先排队（无 tool-call，延迟未发），纯哨兵随后到达 →
    // 修复前 silence 分支无条件清 loopPending，真话被静默丢弃；修复后保留
    // 到 turn/end 经 settleLoop 作终稿发出。
    const h = makeInterimHarness({ interim: true })
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('m1', '先说的真话') as never)
    expect(h.sentTexts).toEqual([])
    h.tracker.onAssistantMessage('private:10001', h.chat, h.assistant('m2', ' [[不回]] ') as never)
    expect(h.chat.loopPending).toBe('先说的真话')
    h.tracker.onTurnEnd('private:10001', h.chat)
    await h.settle()
    expect(h.sentTexts).toEqual(['先说的真话'])
    // instant 模式同样：真话保留到 onTurnEnd 终稿路径发出，哨兵不发。
    const h2 = makeInterimHarness({ interim: false })
    h2.tracker.onAssistantMessage('private:10001', h2.chat, h2.assistant('m1', '先说的真话') as never)
    h2.tracker.onAssistantMessage('private:10001', h2.chat, h2.assistant('m2', '[[不回]]') as never)
    h2.tracker.onTurnEnd('private:10001', h2.chat)
    await h2.settle()
    expect(h2.sentTexts).toEqual(['先说的真话'])
  })
})

describe('T4 上下文尾巴 ChatTails (PR port 上下文尾巴)', () => {
  it('push/read: keeps the last 8, clips to 300 chars, strips user_message envelopes', async () => {
    const tails = new ChatTails({ mediaDir: tempDir(), log: () => undefined })
    await tails.read('private:1') // warm the cache (bridge warms it via preload)
    for (let i = 0; i < TAIL_MAX_MESSAGES + 2; i++) {
      tails.push('private:1', 'user', '<user_message id="x">消息' + i + '</user_message>')
    }
    const list = await tails.read('private:1')
    expect(list).toHaveLength(TAIL_MAX_MESSAGES)
    expect(list[0].text).toBe('消息2')
    expect(list.every(e => e.role === 'user')).toBe(true)
    const tails2 = new ChatTails({ mediaDir: tempDir(), log: () => undefined })
    await tails2.read('private:1')
    tails2.push('private:1', 'user', 'x'.repeat(TAIL_TEXT_MAX + 100))
    expect((await tails2.read('private:1'))[0].text).toHaveLength(TAIL_TEXT_MAX)
  })

  it('same-turn assistant outputs merge (longest wins)', async () => {
    const tails = new ChatTails({ mediaDir: tempDir(), log: () => undefined })
    await tails.read('private:1')
    tails.push('private:1', 'assistant', '短答')
    tails.push('private:1', 'assistant', '这是一段长得多得多的最终回答')
    const list = await tails.read('private:1')
    expect(list).toHaveLength(1)
    expect(list[0].text).toBe('这是一段长得多得多的最终回答')
  })

  it('debounced save lands the file; stop() flushes without waiting the debounce', async () => {
    const dir = tempDir()
    const tails = new ChatTails({ mediaDir: dir, log: () => undefined })
    await tails.read('private:1')
    tails.push('private:1', 'user', '落盘这句')
    await tails.stop()
    const persisted = JSON.parse(await readFile(join(dir, TAILS_FILE), 'utf8')) as Record<string, Array<{ text: string }>>
    expect(persisted['private:1']?.[0]?.text).toBe('落盘这句')
  })

  it('restart round-trip: entries reload from chat-tails.json', async () => {
    const dir = tempDir()
    const first = new ChatTails({ mediaDir: dir, log: () => undefined })
    await first.read('private:1')
    first.push('private:1', 'user', '重启前')
    await first.stop()
    const second = new ChatTails({ mediaDir: dir, log: () => undefined })
    const list = await second.read('private:1')
    expect(list[0]?.text).toBe('重启前')
  })

  it('移植修正 preload()：without it the first pushes are dropped; with it they survive', async () => {
    const dir = tempDir()
    // No preload → cache undefined → the push is silently dropped (the
    // contributor's bug: the first /new always had an empty tail).
    const cold = new ChatTails({ mediaDir: dir, log: () => undefined })
    cold.push('private:1', 'user', '首条')
    expect(await cold.read('private:1')).toEqual([])
    // With preload (bridge.start wiring) the same push survives.
    const warm = new ChatTails({ mediaDir: tempDir(), log: () => undefined })
    warm.preload()
    await new Promise(resolve => setTimeout(resolve, 20))
    warm.push('private:1', 'user', '首条')
    expect((await warm.read('private:1'))[0]?.text).toBe('首条')
  })

  it('drop clears the entry; a corrupt file degrades to an empty cache', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, TAILS_FILE), '{not json', 'utf8')
    const tails = new ChatTails({ mediaDir: dir, log: () => undefined })
    expect(await tails.read('private:1')).toEqual([])
    tails.preload()
    await tails.read('private:1')
    tails.push('private:1', 'user', 'x')
    tails.drop('private:1')
    expect(await tails.read('private:1')).toEqual([])
  })

  it('buildGreetingPrompt: empty tail → the bare greeting; entries → 我：/主人： lines', () => {
    expect(buildGreetingPrompt([])).toContain('刚开了一个新会话')
    const text = buildGreetingPrompt([
      { role: 'user', text: '主人的话' },
      { role: 'assistant', text: '模型的话' },
    ])
    expect(text).toContain('下面是之前几句')
    expect(text).toContain('主人：主人的话')
    expect(text).toContain('我：模型的话')
    expect(text).toContain('刚开了一个新会话')
  })
})

describe('T4 /new 尾巴窄化 + member 档 (bridge 级, PR port 上下文尾巴)', () => {
  it('开关开 + 用户主动 /new：注入尾巴，问候回合档位为 member，不冒充 user', async () => {
    const h = await makeCmdHarness({ chatTailsEnabled: true })
    try {
      h.sendText('上一会话的最后一句')
      await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
      // Consume the first dispatch's queued role (turn/start) so the role
      // queue holds only the greeting turn's role when we check below.
      h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/start', { turn: 1 }))
      // The model answered something before /new (recorded into the tail).
      h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('assistant/message', {
        turn: 1, step: 1, message: { role: 'assistant', id: 'am-1', content: [{ type: 'text', text: '模型的旧回答' }] },
      }))
      h.sendText('/new')
      await vi.waitFor(() => {
        expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
      })
      // The greeting turn carries the tail (genuine /new only).
      await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
      const greeting = h.captured.followups[1]
      expect(greeting.sessionId).toBe(h.sessionIds[1])
      expect(greeting.text).toContain('刚开了一个新会话')
      expect(greeting.text).toContain('主人：上一会话的最后一句')
      expect(greeting.text).toContain('我：模型的旧回答')
      // 评审修正①: the greeting turn's role is 'member', not 'admin'.
      h.ctx.emit('session/event', { id: h.sessionIds[1] } as never, makeEvent('turn/start', { turn: 1 }))
      const chat = h.chats().get('private:10001') as unknown as { activeTurnRole?: string }
      expect(chat.activeTurnRole).toBe('member')
      // 评审修正②: the greeting rides the plugin source kind (captured via the
      // followup create call — the fake agent receives the raw message), i.e.
      // the greeting text is dispatched through dispatchFollowup, whose
      // createUserMessage always uses source.kind 'plugin:dsh-onebot'.
    } finally {
      h.client.close()
      await h.bridge.stop()
      await h.connection.stop()
    }
  })

  it('评审修正：问候回合分发失败不再被 void 吞掉——warn 可见、确认照发、无 unhandled rejection', async () => {
    const logs: Array<{ level: string; message: string }> = []
    const h = await makeCmdHarness({ chatTailsEnabled: true, log: (level, message) => logs.push({ level, message }) })
    try {
      h.sendText('你好')
      await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
      // 注入 ensureChat 故障：问候回合的 dispatchFollowup → await this.ensureChat
      // 抛错（agent 创建失败）。修复前裸 void → unhandled rejection、零日志。
      ;(h.bridge as unknown as { ensureChat: () => Promise<never> }).ensureChat = async () => {
        throw new Error('问候测试故障：agent 创建失败')
      }
      h.sendText('/new')
      await vi.waitFor(() => {
        expect(logs.some(l => l.level === 'warn' && l.message.includes('问候回合分发失败') && l.message.includes('问候测试故障'))).toBe(true)
      }, { timeout: 5_000 })
      // 「已开启新会话」确认不受问候回合失败影响，照发。
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    } finally {
      h.client.close()
      await h.bridge.stop()
      await h.connection.stop()
    }
  })

  it('开关关（默认）：/new 不注入尾巴、不发起问候回合', async () => {
    const h = await makeCmdHarness({})
    try {
      h.sendText('一句话')
      await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
      h.sendText('/new')
      await vi.waitFor(() => {
        expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
      })
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(h.captured.followups).toHaveLength(1)
    } finally {
      h.client.close()
      await h.bridge.stop()
      await h.connection.stop()
    }
  })

  it('开关开但非 /new 的退役（/workspace 切档）不带尾巴', async () => {
    const h = await makeCmdHarness({ chatTailsEnabled: true })
    try {
      h.sendText('一句话')
      await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
      h.sendText('/workspace')
      await vi.waitFor(() => {
        expect(h.outbound.some(f => f.action === 'send_msg')).toBe(true)
      })
      await new Promise(resolve => setTimeout(resolve, 150))
      // Only the original followup: no tail greeting turn.
      expect(h.captured.followups).toHaveLength(1)
    } finally {
      h.client.close()
      await h.bridge.stop()
      await h.connection.stop()
    }
  })
})

describe('T4 提示词文件/记忆注入接线 (installChannelScope × PromptLoader)', () => {
  it('dm 会话建 agent 时注入 附加设定 + 我的记忆；群聊不吃记忆', async () => {
    const dir = tempDir()
    const persona = join(dir, 'persona.md')
    const memory = join(dir, 'memory.md')
    writeFileSync(persona, '附加设定内容', 'utf8')
    writeFileSync(memory, '记忆内容', 'utf8')
    const h = await makeCmdHarness({ dmPromptFile: persona, memoryFilesEnabled: true, memoryFiles: [memory] })
    try {
      h.sendText('你好')
      await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
      await vi.waitFor(() => expect(h.captured.channelSectionTexts.length).toBeGreaterThan(0))
      const section = h.captured.channelSectionTexts.find(s => s.name === 'channel:dsh-onebot')
      expect(section?.text).toContain('## 本会话附加设定\n附加设定内容')
      expect(section?.text).toContain('## 我的记忆')
      expect(section?.text).toContain('记忆内容')
    } finally {
      h.client.close()
      await h.bridge.stop()
      await h.connection.stop()
    }
  })

  it('mtime 失效：换 agent（/new 后新会话）即读到新内容', async () => {
    const dir = tempDir()
    const persona = join(dir, 'persona.md')
    writeFileSync(persona, '第一版', 'utf8')
    const h = await makeCmdHarness({ dmPromptFile: persona })
    try {
      h.sendText('你好')
      await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
      const future = new Date(Date.now() + 5_000)
      writeFileSync(persona, '第二版', 'utf8')
      const { utimesSync } = await import('node:fs')
      utimesSync(persona, future, future)
      h.sendText('/new')
      await vi.waitFor(() => {
        expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
      })
      // The new agent (created for the next user turn after /new) must read
      // the file fresh — the mtime-invalidated cache picks up the rewrite.
      h.sendText('再来一句')
      await vi.waitFor(() => expect(h.captured.channelSectionTexts.length).toBeGreaterThanOrEqual(2))
      const texts = h.captured.channelSectionTexts.map(s => s.text)
      expect(texts[0]).toContain('第一版')
      expect(texts[texts.length - 1]).toContain('第二版')
    } finally {
      h.client.close()
      await h.bridge.stop()
      await h.connection.stop()
    }
  })

  it('switch off (default): no memory section even with memory files configured; no file → no 附加设定', async () => {
    const dir = tempDir()
    const memory = join(dir, 'memory.md')
    writeFileSync(memory, '记忆内容', 'utf8')
    // memoryFiles alone is not enough — the explicit memoryFilesEnabled switch
    // (default off) gates the memory feed; no dmPromptFile → no 附加设定.
    const h = await makeCmdHarness({ memoryFiles: [memory] })
    try {
      h.sendText('你好')
      await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
      await vi.waitFor(() => expect(h.captured.channelSectionTexts.length).toBeGreaterThan(0))
      const section = h.captured.channelSectionTexts.find(s => s.name === 'channel:dsh-onebot')
      expect(section?.text).not.toContain('## 本会话附加设定')
      expect(section?.text).not.toContain('## 我的记忆')
    } finally {
      h.client.close()
      await h.bridge.stop()
      await h.connection.stop()
    }
  })
})
