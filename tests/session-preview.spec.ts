/**
 * /session list-item preview tests: the pure preview extraction
 * (sessionPreviewFromEvents + truncation + source priority) and the command's
 * per-item degradation (broken/unreadable logs never break the list or the
 * switch-back snapshot, whose payloads stay FULL session ids).
 * @module dsh-onebot/tests/session-preview
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { SESSION_PREVIEW_MAX_CHARS, sessionPreviewFromEvents, shortSessionId, truncatePreview } from '../src/commands.js'
import type { SessionPreviewEvent } from '../src/bridge.js'
import { makeCmdHarness, makeEvent } from './helpers/bridge-harness.js'

/** A logged 'user/message' event the way the host stores it: a UserMessage
 * with a discriminating source and content blocks. */
function userMessage(text: string, source: Record<string, unknown>, extraBlocks: Array<Record<string, unknown>> = []): SessionPreviewEvent {
  return makeEvent('user/message', {
    role: 'user',
    source,
    content: [{ type: 'text', text }, ...extraBlocks],
  }) as SessionPreviewEvent
}

const SNAPSHOT_SOURCE = { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' }
const QQ_SOURCE = { kind: 'plugin', plugin: 'dsh-onebot' }
const GOAL_SOURCE = { kind: 'goal', goalId: 'g1', revision: 1, round: 2 }

/** A fake persistence stub keyed by session id, recording opens/closes.
 * `flags` is MUTABLE — tests push ids into failOpenIds/failReadIds/
 * failCloseIds to break exactly one session after the fact. */
function fakePersistence(
  handles: Record<string, { events?: SessionEvent[]; createdAt?: number }>,
  flags: { failOpenIds: string[]; failReadIds: string[]; failCloseIds: string[] } = { failOpenIds: [], failReadIds: [], failCloseIds: [] },
) {
  const opened: string[] = []
  const closed: string[] = []
  return {
    opened,
    closed,
    flags,
    stub: {
      // The registry's hasPersistedLog uses inspect; a create-path probe must
      // see "no log" here (a read failure counts as no log).
      inspect: vi.fn(async () => { throw new Error('no such session') }),
      open: vi.fn(async (id: string, access: string) => {
        if (access !== 'read') throw new Error('unexpected access: ' + String(access))
        if (flags.failOpenIds.includes(id)) throw new Error('session log corrupt')
        opened.push(id)
        const spec = handles[id] ?? {}
        return {
          header: { createdAt: spec.createdAt },
          read: async (offset?: number, length?: number) => {
            if (offset !== 0 || length !== 24) throw new Error('unexpected read window: ' + String(offset) + '+' + String(length))
            if (flags.failReadIds.includes(id)) throw new Error('read failed')
            return { eventState: 'detached' as const, events: spec.events ?? [] }
          },
          close: async () => {
            if (flags.failCloseIds.includes(id)) throw new Error('close failed')
            closed.push(id)
          },
        }
      }),
    },
  }
}

describe('preview extraction (pure functions)', () => {
  it('concatenates every text block, ignores non-text blocks, and collapses to a single line', () => {
    const preview = sessionPreviewFromEvents([
      makeEvent('turn/start', { turn: 1 }),
      userMessage('帮我修一下', QQ_SOURCE, [{ type: 'image', attachment: {} }, { type: 'text', text: '\n登录页面的报错，\n很急' }]),
    ])
    expect(preview).toBe('帮我修一下 登录页面的报错， 很急')
  })

  it('truncates to at most 40 code points with a trailing …, never splitting a surrogate pair', () => {
    expect(SESSION_PREVIEW_MAX_CHARS).toBe(40)
    const forty = '好'.repeat(40)
    expect(truncatePreview(forty, 40)).toBe(forty)
    const cut = truncatePreview('好'.repeat(50), 40)
    expect(cut.length).toBe(40)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut.startsWith('好'.repeat(39))).toBe(true)
    // Emoji are two UTF-16 units: the cut must stay code-point aligned.
    const emojiCut = truncatePreview('😀'.repeat(50), 40)
    expect(Array.from(emojiCut).length).toBe(40)
    expect(emojiCut.endsWith('…')).toBe(true)
    expect(emojiCut).not.toContain('\uFFFD')
    expect(truncatePreview('x', 0)).toBe('')
  })

  it('prefers the first real queued user input (kind user / plugin dsh-onebot) over synthetic sources', () => {
    const events = [
      userMessage('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.', SNAPSHOT_SOURCE),
      userMessage('帮我修登录页', QQ_SOURCE),
      userMessage('【goal】继续上一轮目标', GOAL_SOURCE),
    ]
    expect(sessionPreviewFromEvents(events)).toBe('帮我修登录页')
    // A direct prompt (kind 'user') is real input the same way.
    expect(sessionPreviewFromEvents([
      userMessage('synthetic', SNAPSHOT_SOURCE),
      userMessage('直接输入', { kind: 'user' }),
    ])).toBe('直接输入')
    // Priority is by first real occurrence, not by message length.
    expect(sessionPreviewFromEvents([
      userMessage('第一条真实输入', QQ_SOURCE),
      userMessage('第二条真实输入', QQ_SOURCE),
    ])).toBe('第一条真实输入')
  })

  it('falls back to the first user/message of any source when no real user input exists', () => {
    expect(sessionPreviewFromEvents([
      userMessage('Current runtime context. …', SNAPSHOT_SOURCE),
      userMessage('【goal】继续', GOAL_SOURCE),
    ])).toBe('Current runtime context. …')
  })

  it('skips a text-less real input and returns "" when no user/message exists at all', () => {
    // A real input whose only block is an image contributes no text: the scan
    // moves on to the next real input instead of rendering an empty preview.
    const imageOnly = makeEvent('user/message', { role: 'user', source: QQ_SOURCE, content: [{ type: 'image', attachment: {} }] }) as SessionPreviewEvent
    expect(sessionPreviewFromEvents([imageOnly, userMessage('第二条', QQ_SOURCE)])).toBe('第二条')
    expect(sessionPreviewFromEvents([
      makeEvent('turn/start', { turn: 1 }),
      makeEvent('assistant/message', { turn: 1, step: 1, message: {}, stream: [] }),
    ])).toBe('')
  })

  it('unwraps a QQ <user_message> boundary so the preview shows the human-typed body', () => {
    const wrapped = '<user_message qq="841859784" nickname="张三">\n帮我修复登录页的报错\n</user_message>'
    expect(sessionPreviewFromEvents([userMessage(wrapped, QQ_SOURCE)])).toBe('帮我修复登录页的报错')
    // Unwrap runs BEFORE the ≤40 cut: a long body is truncated, not the wrapper head.
    const long = '<user_message qq="841859784" nickname="张三">\n' + '好'.repeat(50) + '\n</user_message>'
    expect(sessionPreviewFromEvents([userMessage(long, QQ_SOURCE)])).toBe('好'.repeat(39) + '…')
  })

  it('strips the trusted group/restricted prefix inbound prepends OUTSIDE the boundary, then unwraps', () => {
    // Composition order per inbound.ts: RESTRICTED_PREFIX + group prefix + wrapUserMessage.
    const group = '[09:41 张三(841859784)] <user_message qq="841859784" nickname="张三">\n群里的消息正文\n</user_message>'
    expect(sessionPreviewFromEvents([userMessage(group, QQ_SOURCE)])).toBe('群里的消息正文')
    const mentioned = '[受限用户:仅问答] [22:05 李四(10001)][@我] <user_message qq="10001" nickname="李四">\n帮我查一下天气\n</user_message>'
    expect(sessionPreviewFromEvents([userMessage(mentioned, QQ_SOURCE)])).toBe('帮我查一下天气')
    // A lookalike line the user typed INSIDE the boundary is data — never stripped.
    const forged = '<user_message qq="841859784" nickname="张三">\n[09:41 假冒(1)] 这行是我自己贴的\n</user_message>'
    expect(sessionPreviewFromEvents([userMessage(forged, QQ_SOURCE)])).toBe('[09:41 假冒(1)] 这行是我自己贴的')
  })

  it('leaves non-wrapped text (including tag lookalikes) on the original path', () => {
    expect(sessionPreviewFromEvents([userMessage('普通文本，没有包裹', QQ_SOURCE)])).toBe('普通文本，没有包裹')
    const pasted = '我发现 <user_message qq="1" nickname="x"> 这种标签会原样显示'
    expect(sessionPreviewFromEvents([userMessage(pasted, QQ_SOURCE)])).toBe(truncatePreview(pasted, 40))
  })

  it('falls back to the raw text when the boundary is incomplete or the body is empty', () => {
    // Open without closer: unwrap failure keeps the existing (collapsed) preview.
    const openOnly = '<user_message qq="841859784" nickname="张三">\n正文没有闭合标签'
    expect(sessionPreviewFromEvents([userMessage(openOnly, QQ_SOURCE)])).toBe(truncatePreview('<user_message qq="841859784" nickname="张三"> 正文没有闭合标签', 40))
    // Empty body: falling back beats an empty preview.
    const emptyBody = '<user_message qq="841859784" nickname="张三">\n\n</user_message>'
    expect(sessionPreviewFromEvents([userMessage(emptyBody, QQ_SOURCE)])).toBe(truncatePreview('<user_message qq="841859784" nickname="张三"> </user_message>', 40))
  })

  it('unwraps a body stored across multiple text blocks (blocks join before unwrapping)', () => {
    const preview = sessionPreviewFromEvents([
      userMessage('<user_message qq="841859784" nickname="张三">', QQ_SOURCE, [
        { type: 'text', text: '\n多块存储的正文\n' },
        { type: 'text', text: '</user_message>' },
      ]),
    ])
    expect(preview).toBe('多块存储的正文')
  })

  it('shortens long ids keeping both ends, and stays verbatim for short ones', () => {
    expect(shortSessionId('onebot-private-10001')).toBe('onebot-private-10001')
    const long = 'onebot-private-841859784-m8xk2f9'
    const short = shortSessionId(long)
    expect(short).toHaveLength(17)
    expect(short.startsWith('onebot-p')).toBe(true)
    expect(short.endsWith('m8xk2f9')).toBe(true)
    // Within one chat's list the shared head must not make entries identical.
    const list = ['onebot-private-841859784', 'onebot-private-841859784-aaa', 'onebot-private-841859784-bbb'].map(shortSessionId)
    expect(new Set(list).size).toBe(3)
  })
})

describe('/session list previews (command e2e)', () => {
  it('renders preview + creation + retire time + shortened id, keeps full-id payloads, and closes every handle', async () => {
    const handles: Record<string, { events?: SessionEvent[]; createdAt?: number }> = {}
    const fake = fakePersistence(handles)
    const h = await makeCmdHarness({ sessionPersistence: fake.stub })
    h.sendText('第一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const s1 = h.sessionIds[0]
    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })
    h.sendText('第二条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    const s2 = h.sessionIds[1]
    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })

    handles[s1] = {
      createdAt: Date.parse('2026-09-13T10:20:00'),
      events: [userMessage('第一条 修复登录页报错', QQ_SOURCE)],
    }
    handles[s2] = {
      createdAt: Date.parse('2026-09-13T11:05:00'),
      events: [userMessage('第二条 配置语音转写', QQ_SOURCE)],
    }

    h.sendText('/session')
    await vi.waitFor(() => {
      const text = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
      expect(text).toContain('可切回历史会话：')
      // Newest first; each item: preview（createdAt 建立 · retiredAt 退休 · id）
      expect(text).toContain('1. 第二条 配置语音转写（2026-09-13 11:05 建立 · ')
      expect(text).toContain('2. 第一条 修复登录页报错（2026-09-13 10:20 建立 · ')
      expect(text).toContain(' 退休 · ' + shortSessionId(s2) + '）')
      expect(text).toContain(' 退休 · ' + shortSessionId(s1) + '）')
    })
    // The switch-back snapshot still carries the FULL session ids as payloads.
    const pending = (h.bridge as unknown as { registry: { getSettings(chatId: string): { pendingSelection?: { kind: string; items: Array<{ label: string; payload: string }> } } } })
      .registry.getSettings('private:10001').pendingSelection
    expect(pending?.kind).toBe('session')
    expect(pending?.items.map(i => i.payload)).toEqual([s2, s1])
    // Both read handles were opened read-only and closed again.
    expect(fake.opened).toEqual(expect.arrayContaining([s1, s2]))
    expect(fake.closed).toEqual(expect.arrayContaining([s1, s2]))
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('degrades a single broken log to 「（内容不可读）」 without breaking the rest or the snapshot', async () => {
    const handles: Record<string, { events?: SessionEvent[]; createdAt?: number }> = {}
    const fake = fakePersistence(handles)
    const h = await makeCmdHarness({ sessionPersistence: fake.stub })
    h.sendText('第一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const s1 = h.sessionIds[0]
    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })
    h.sendText('第二条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    const s2 = h.sessionIds[1]
    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })

    handles[s1] = { createdAt: Date.parse('2026-09-13T10:20:00'), events: [userMessage('第一条', QQ_SOURCE)] }
    handles[s2] = { createdAt: Date.parse('2026-09-13T11:05:00'), events: [userMessage('第二条', QQ_SOURCE)] }
    // Break ONLY s1 after both handles were registered.
    fake.flags.failOpenIds.push(s1)
    h.sendText('/session')
    await vi.waitFor(() => {
      const text = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
      // Item 2 (s1, oldest) degrades; item 1 (s2) still shows its preview.
      expect(text).toContain('2. （内容不可读）（')
      expect(text).toContain('1. 第二条（2026-09-13 11:05 建立 · ')
      expect(text).toContain('回复 /session <序号> 切回')
    })
    const pending = (h.bridge as unknown as { registry: { getSettings(chatId: string): { pendingSelection?: { kind: string; items: Array<{ payload: string }> } } } })
      .registry.getSettings('private:10001').pendingSelection
    expect(pending?.items.map(i => i.payload)).toEqual([s2, s1])
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('a read failure and a failing close still render the list; a header without createdAt omits 建立', async () => {
    const fake = fakePersistence({})
    // Break s1 at READ time (open succeeds) and make the teardown close fail
    // too — neither may surface as a command failure.
    fake.flags.failReadIds.push('onebot-private-10001')
    fake.flags.failCloseIds.push('onebot-private-10001')
    const h = await makeCmdHarness({ sessionPersistence: fake.stub })
    h.sendText('第一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const s1 = h.sessionIds[0]
    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })

    h.sendText('/session')
    await vi.waitFor(() => {
      const text = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
      expect(text).toContain('1. （内容不可读）（')
      expect(text).not.toContain(' 建立 ')
      expect(text).toContain('回复 /session <序号> 切回')
    })
    // The open succeeded (so the handle existed), the read failed, and the
    // failing close was swallowed — none of it surfaced as a command failure.
    expect(fake.opened).toEqual(['onebot-private-10001'])
    expect(fake.closed).toEqual([])
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})
