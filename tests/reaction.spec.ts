/**
 * 群聊 @ 表情回执（T1 reaction）：被显式 @ 机器人后，回合启动点 best-effort
 * 贴一次 set_msg_emoji_like（NapCat/SnowLuma 扩展 action）作为「已收到」回执。
 * 覆盖：默认值三处一致、@ 判定（段数组 / CQ 码回退 / 他人 at 不贴 / 私聊不贴 /
 * 引用与 @全体不贴）、默认关零行为、reactionEmoji 自定义透传、失败静默且不
 * 影响回复管线。
 * @module dsh-onebot/tests/reaction
 */
import { describe, expect, it, vi } from 'vitest'

import { Config } from '../src/index.js'
import { SCHEMA_DEFAULTS } from '../src/settings-remote.js'

import { makeEvent, makeHarness } from './helpers/bridge-harness.js'

/** 发一条带 message_id 的群 @ 消息（sendGroupTextAs 不带 id，回执判定需要它）。 */
function sendGroupAt(h: Awaited<ReturnType<typeof makeHarness>>, messageId: number, message: unknown, raw: string, userId = 10001): void {
  h.client.send(JSON.stringify({
    post_type: 'message', message_type: 'group', group_id: 888, user_id: userId, self_id: 10002,
    message_id: messageId,
    message,
    raw_message: raw,
    sender: { user_id: userId, nickname: '用户' + userId },
  }))
}

describe('T1 reaction 默认值三处一致（schema / SCHEMA_DEFAULTS / 面板 DEFAULTS）', () => {
  it('schema 解析默认值 reactionOnMention=false、reactionEmoji=178，与 SCHEMA_DEFAULTS 逐字一致', () => {
    const resolved = Config({}) as Record<string, unknown>
    expect(SCHEMA_DEFAULTS.reactionOnMention).toBe(false)
    expect(SCHEMA_DEFAULTS.reactionEmoji).toBe(178)
    expect(resolved.reactionOnMention).toBe(false)
    expect(resolved.reactionEmoji).toBe(178)
    expect(resolved.reactionOnMention).toEqual(SCHEMA_DEFAULTS.reactionOnMention)
    expect(resolved.reactionEmoji).toEqual(SCHEMA_DEFAULTS.reactionEmoji)
    // 面板 DEFAULTS（lib/client.js）与 SCHEMA_DEFAULTS 的全等断言由
    // client-settings.spec.ts「默认值逐字对齐 host SCHEMA_DEFAULTS」覆盖
    // （含上面 reactionOnMention/reactionEmoji 两行专项断言）。
  })
})

describe('T1 reaction 行为', () => {
  it('群聊段数组 @ 机器人：回合启动时贴一次表情回执（默认 178）', async () => {
    const h = await makeHarness({ reactionOnMention: true })
    sendGroupAt(h, 40001, [{ type: 'at', data: { qq: '10002' } }, { type: 'text', data: { text: '你好' } }], '[CQ:at,qq=10002]你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    await vi.waitFor(() => {
      const frames = h.outbound.filter(f => f.action === 'set_msg_emoji_like')
      expect(frames).toHaveLength(1)
      expect(frames[0].params).toEqual({ message_id: 40001, emoji_id: '178' })
    })
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('CQ 码文本回退：字符串消息里的 [CQ:at,qq=bot] 同样触发', async () => {
    const h = await makeHarness({ reactionOnMention: true })
    sendGroupAt(h, 40002, '[CQ:at,qq=10002]帮我看看', '[CQ:at,qq=10002]帮我看看')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'set_msg_emoji_like' && (f.params as Record<string, unknown>).message_id === 40002)).toBe(true)
    })
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('reactionEmoji 自定义透传（emoji_id = String(config.reactionEmoji)）', async () => {
    const h = await makeHarness({ reactionOnMention: true, reactionEmoji: 128 })
    sendGroupAt(h, 40003, [{ type: 'at', data: { qq: '10002' } }, { type: 'text', data: { text: '在吗' } }], '[CQ:at,qq=10002]在吗')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    await vi.waitFor(() => {
      const frames = h.outbound.filter(f => f.action === 'set_msg_emoji_like')
      expect(frames).toHaveLength(1)
      expect(frames[0].params).toEqual({ message_id: 40003, emoji_id: '128' })
    })
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('默认关：群聊 @ 不产生任何表情回执（零行为差异）', async () => {
    const h = await makeHarness()
    sendGroupAt(h, 40004, [{ type: 'at', data: { qq: '10002' } }, { type: 'text', data: { text: '你好' } }], '[CQ:at,qq=10002]你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.outbound.some(f => f.action === 'set_msg_emoji_like')).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('他人 at 不贴；私聊不贴；引用唤醒与 @全体唤醒也不贴（只认显式 @ 机器人）', async () => {
    const h = await makeHarness({ reactionOnMention: true, replyCountsAsMention: true, atAllCountsAsMention: true })
    // 他人 at（@ 的不是机器人）——requireMention 门直接拦下，无回合无回执。
    sendGroupAt(h, 40005, [{ type: 'at', data: { qq: '99999' } }, { type: 'text', data: { text: '你好' } }], '[CQ:at,qq=99999]你好')
    // 引用机器人消息唤醒（type=reply，无 at 段）。
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'group', group_id: 888, user_id: 10001, self_id: 10002,
      message_id: 40006,
      message: [{ type: 'reply', data: { id: '7' } }, { type: 'text', data: { text: '再看看' } }],
      raw_message: '[CQ:reply,id=7]再看看',
      sender: { user_id: 10001, nickname: '用户10001' },
    }))
    // @全体唤醒（at all，不是 at 机器人）。
    sendGroupAt(h, 40007, [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '都在吗' } }], '[CQ:at,qq=all]都在吗')
    // 私聊（已有 typing indicator，不贴表情回执）。
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups.length).toBeGreaterThanOrEqual(3))
    expect(h.outbound.some(f => f.action === 'set_msg_emoji_like')).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('回执失败静默降级（debug 日志），不影响回复管线', async () => {
    const logs: Array<{ level: string; message: string }> = []
    const h = await makeHarness({
      reactionOnMention: true,
      respond: {
        set_msg_emoji_like: () => {
          throw new Error('unsupported action: set_msg_emoji_like')
        },
      },
      log: (level, message) => logs.push({ level, message }),
    })
    sendGroupAt(h, 40008, [{ type: 'at', data: { qq: '10002' } }, { type: 'text', data: { text: '你好' } }], '[CQ:at,qq=10002]你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    // 回执 best-effort 失败：debug 静默日志，管线继续。
    await vi.waitFor(() => expect(logs.some(l => l.level === 'debug' && l.message.includes('表情回执失败'))).toBe(true))
    // 回复管线不受影响：assistant 回复照常 send_msg。
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '这是回复' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('这是回复'))).toBe(true)
    })
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
