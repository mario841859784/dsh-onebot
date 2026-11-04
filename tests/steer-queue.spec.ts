/**
 * 排队/插话语义回归测试（P1/T2）：任务运行中收到新消息的 newMessagePolicy
 * 处理 + /steer 命令。
 *
 * 语义定案（计划 §P1 + dsh-agent 契约）：
 * - queue（默认）：门控后的新消息保持 0.8.1 的 dispatch 路径 ——
 *   agent.followup 的宿主契约是「Queue an ordinary follow-up turn… becomes
 *   the sole ordinary message of its own turn」（runtime-types.d.ts:189-193），
 *   即入队并在当前回合结束后按到达顺序各自成为独立回合；插件侧新增的是
 *   门控后每运行回合至多 1 条的排队提示（QUEUE_NOTICE_TEXT，turn/end 重置）。
 * - steer：普通纯文字（无媒体/无引用/无转发）经 bridge 单一 steerMessage
 *   写点（agent.steer + plugin:dsh-onebot source）作为补充指令进当前任务，
 *   在最近 step 边界被读取，不新开回合；每条提交回复一次提交提示。
 * - 例外：媒体/引用/合并转发消息与 [受限用户:仅问答] 群成员两种模式下都按
 *   排队处理（软限制不放宽，媒体管线不被绕过）。
 * - T9-B (用户裁决 2026-10-12)：steer 模式下自动插话资格由 autoSteerPolicy
 *   控制（admin=仅管理员，缺省；all=不限）；不具备资格的消息走 queue 行为；
 *   受限用户任何档都不自动插话；/steer 命令始终仅管理员。
 * - T9-A：/steer 命令文本同样经 <user_message> 边界包裹（与自动插话路径同形）。
 * - 无运行中任务时全部路径与 0.8.1 逐字节等价（零提示、零 steer）。
 * @module dsh-onebot/tests/steer-queue
 */
import { describe, expect, it, vi } from 'vitest'

import { QUEUE_NOTICE_TEXT } from '../src/bridge.js'
import { STEER_ACCEPTED_NOTICE, STEER_USAGE_HINT } from '../src/commands.js'
import { makeCmdHarness, makeEvent, sentTexts } from './helpers/bridge-harness.js'

/** 把指定 chat 的假 agent 置于运行态（真实宿主中由回合驱动自动切换）。 */
function setRunning(h: Awaited<ReturnType<typeof makeCmdHarness>>, chatId = 'private:10001'): void {
  const chat = (h as unknown as { chats: Map<string, { agent: { status: string } }> }).chats().get(chatId)
  expect(chat, 'chat 未创建').toBeDefined()
  chat!.agent.status = 'running'
}

describe('newMessagePolicy — queue（默认，缺省即 queue）', () => {
  it('运行回合中收到 2 条新消息：按序入队 dispatch、排队提示恰 1 条、零 steer', async () => {
    const h = await makeCmdHarness() // 不传 newMessagePolicy = 缺省 queue
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)

    h.sendText('排队消息一')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    h.sendText('排队消息二')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))

    // 按到达顺序入队（宿主契约：各成下一回合，当前回合结束后按序执行）
    const texts = h.captured.followups.map(f => f.text)
    expect(texts[1]).toContain('排队消息一')
    expect(texts[2]).toContain('排队消息二')
    expect(h.captured.steers).toHaveLength(0)

    // 排队提示同一运行回合只发 1 条（防刷屏）
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes(QUEUE_NOTICE_TEXT))).toBe(true))
    expect(sentTexts(h.outbound).filter(t => t.includes(QUEUE_NOTICE_TEXT))).toHaveLength(1)
    expect(sentTexts(h.outbound).filter(t => t.includes(STEER_ACCEPTED_NOTICE))).toHaveLength(0)
    expect(h.outbound.filter(f => f.action === 'send_msg')).toHaveLength(1) // 除提示外无其他出站

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('turn/end 重置提示计数：下一个运行回合再排队会再次提示', async () => {
    const h = await makeCmdHarness()
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)
    h.sendText('第一条排队')
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes(QUEUE_NOTICE_TEXT))).toBe(true))

    // 当前回合结束 → 提示计数重置 → 新回合开始
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/start', { turn: 2 }))

    h.sendText('第二条排队')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))
    await vi.waitFor(() => expect(sentTexts(h.outbound).filter(t => t.includes(QUEUE_NOTICE_TEXT))).toHaveLength(2))

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})

describe('newMessagePolicy — steer', () => {
  it('运行回合中的普通纯文字经 agent.steer 补充进当前任务：不新开回合、每条一条提交提示', async () => {
    const h = await makeCmdHarness({ newMessagePolicy: 'steer' })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)

    h.sendText('补充指令 A')
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
    // 补充指令文本进入 steer，且保留 <user_message …> 数据边界（注入安全面）
    expect(h.captured.steers[0].text).toContain('补充指令 A')
    expect(h.captured.steers[0].text).toContain('user_message qq="10001"')
    // 不新开回合：followup 只有一条（最初的任务消息）
    expect(h.captured.followups).toHaveLength(1)

    await vi.waitFor(() => expect(sentTexts(h.outbound).filter(t => t.includes(STEER_ACCEPTED_NOTICE))).toHaveLength(1))

    h.sendText('补充指令 B')
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(2))
    expect(h.captured.steers[1].text).toContain('补充指令 B')
    await vi.waitFor(() => expect(sentTexts(h.outbound).filter(t => t.includes(STEER_ACCEPTED_NOTICE))).toHaveLength(2))
    // steer 路径不产生排队提示
    expect(sentTexts(h.outbound).filter(t => t.includes(QUEUE_NOTICE_TEXT))).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('无运行中任务时与 0.8.1 逐字节等价：直接 dispatch、零 steer、零提示', async () => {
    const h = await makeCmdHarness({ newMessagePolicy: 'steer' })
    h.sendText('普通消息')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('普通消息')
    expect(h.captured.steers).toHaveLength(0)
    // 零出站提示（不炸不静默之外无任何附加消息）
    expect(sentTexts(h.outbound)).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})

describe('插话例外规则（两种模式都不进 steer）', () => {
  it('steer 模式下带引用的消息按排队处理：引用展开照常、不 steer、有排队提示', async () => {
    const h = await makeCmdHarness({ newMessagePolicy: 'steer' })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)

    // 带引用段的消息（reply → replyId）：plain=false → 排队分支
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'reply', data: { id: '7' } }, { type: 'text', data: { text: '针对引用的补充' } }],
      raw_message: '[CQ:reply,id=7]针对引用的补充',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2), )
    expect(h.captured.steers).toHaveLength(0)
    expect(h.captured.followups[1].text).toContain('针对引用的补充')
    await vi.waitFor(() => expect(sentTexts(h.outbound).filter(t => t.includes(QUEUE_NOTICE_TEXT))).toHaveLength(1))
    expect(sentTexts(h.outbound).filter(t => t.includes(STEER_ACCEPTED_NOTICE))).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('steer 模式下图片消息按排队处理：媒体管线入口未被绕过、不 steer', async () => {
    const h = await makeCmdHarness({ newMessagePolicy: 'steer' })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)

    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'image', data: { file: 'abc.image' } }],
      raw_message: '[CQ:image,file=abc.image]',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    // 图片消息走完整媒体管线（get_image 解析在 fake 网关上降级为占位符）后按排队 dispatch
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.steers).toHaveLength(0)
    expect(h.captured.followups[1].text).toContain('[图片]')
    await vi.waitFor(() => expect(sentTexts(h.outbound).filter(t => t.includes(QUEUE_NOTICE_TEXT))).toHaveLength(1))

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('受限用户（[受限用户:仅问答]）自动插话不放宽：steer 模式下群成员消息仍按排队', async () => {
    const h = await makeCmdHarness({ newMessagePolicy: 'steer', restrictedMemberPrefix: true })
    // 群管理员先开任务（sendGroupTextAs 自带 @ 满足 requireMention）
    h.sendGroupTextAs('启动群任务', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h, 'group:888')

    h.sendGroupTextAs('群成员想插话', 20003)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.steers).toHaveLength(0)
    // 软限制前缀原样保留：排队消息仍带 [受限用户:仅问答]
    expect(h.captured.followups[1].text).toContain('[受限用户:仅问答]')
    expect(h.captured.followups[1].text).toContain('群成员想插话')
    await vi.waitFor(() => expect(sentTexts(h.outbound).filter(t => t.includes(QUEUE_NOTICE_TEXT))).toHaveLength(1))
    expect(sentTexts(h.outbound).filter(t => t.includes(STEER_ACCEPTED_NOTICE))).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})

describe('autoSteerPolicy（T9-B，用户裁决 2026-10-12）—— steer 模式下自动插话资格', () => {
  it('缺省 admin 档：普通群成员的纯文字不自动插话，按排队处理（入队+排队提示）', async () => {
    const h = await makeCmdHarness({ newMessagePolicy: 'steer' }) // autoSteerPolicy 缺省 = admin
    h.sendGroupTextAs('启动群任务', 10001) // 管理员开任务
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h, 'group:888')

    h.sendGroupTextAs('普通成员的补充', 20003) // 非管理员、非受限、纯文字
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.steers).toHaveLength(0)
    expect(h.captured.followups[1].text).toContain('普通成员的补充')
    await vi.waitFor(() => expect(sentTexts(h.outbound).filter(t => t.includes(QUEUE_NOTICE_TEXT))).toHaveLength(1))
    expect(sentTexts(h.outbound).filter(t => t.includes(STEER_ACCEPTED_NOTICE))).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('all 档：普通群成员的纯文字放行自动插话（steer 提交+提交提示，零排队提示）', async () => {
    const h = await makeCmdHarness({ newMessagePolicy: 'steer', autoSteerPolicy: 'all' })
    h.sendGroupTextAs('启动群任务', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h, 'group:888')

    h.sendGroupTextAs('普通成员的补充', 20003)
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
    expect(h.captured.steers[0].text).toContain('普通成员的补充')
    expect(h.captured.steers[0].text).toContain('user_message qq="20003"')
    expect(h.captured.followups).toHaveLength(1) // 不新开回合
    await vi.waitFor(() => expect(sentTexts(h.outbound).filter(t => t.includes(STEER_ACCEPTED_NOTICE))).toHaveLength(1))
    expect(sentTexts(h.outbound).filter(t => t.includes(QUEUE_NOTICE_TEXT))).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('受限用户任何档都不自动插话：all 档下 [受限用户:仅问答] 群成员消息仍按排队', async () => {
    const h = await makeCmdHarness({ newMessagePolicy: 'steer', autoSteerPolicy: 'all', restrictedMemberPrefix: true })
    h.sendGroupTextAs('启动群任务', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h, 'group:888')

    h.sendGroupTextAs('受限成员的补充', 20003)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.steers).toHaveLength(0)
    expect(h.captured.followups[1].text).toContain('[受限用户:仅问答]')
    expect(h.captured.followups[1].text).toContain('受限成员的补充')
    await vi.waitFor(() => expect(sentTexts(h.outbound).filter(t => t.includes(QUEUE_NOTICE_TEXT))).toHaveLength(1))
    expect(sentTexts(h.outbound).filter(t => t.includes(STEER_ACCEPTED_NOTICE))).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})

describe('/steer 命令（仅管理员，两种模式下均可用）', () => {
  it('无运行中任务时回中文用法提示：不炸、不静默、零 steer', async () => {
    const h = await makeCmdHarness({ newMessagePolicy: 'steer' })
    // agent 空闲（任务未运行）
    h.sendText('/steer 看看进度')
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('用法：/steer'))).toBe(true))
    expect(h.captured.followups).toHaveLength(0)
    expect(h.captured.steers).toHaveLength(0)

    // 空参数同样回用法提示
    h.sendText('/steer')
    await vi.waitFor(() => expect(sentTexts(h.outbound).filter(t => t.includes(STEER_USAGE_HINT))).toHaveLength(2))
    expect(h.captured.steers).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('queue 模式下运行中任务也可显式 /steer：补充指令文本进 steer', async () => {
    const h = await makeCmdHarness() // 缺省 queue
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)

    h.sendText('/steer 优先只跑冒烟部分')
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
    expect(h.captured.steers[0].text).toContain('优先只跑冒烟部分')
    expect(h.captured.followups).toHaveLength(1) // 不新开回合
    await vi.waitFor(() => expect(sentTexts(h.outbound).filter(t => t.includes(STEER_ACCEPTED_NOTICE))).toHaveLength(1))
    // 显式 /steer 不产生排队提示
    expect(sentTexts(h.outbound).filter(t => t.includes(QUEUE_NOTICE_TEXT))).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('T9-A：/steer 文本经 <user_message> 边界包裹进 steer（与自动插话路径同形，含 qq/nickname 属性）', async () => {
    const h = await makeCmdHarness() // 缺省 queue
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)

    h.sendText('/steer 只跑冒烟部分')
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
    // 同形边界：wrapUserMessage 形态（qq=发送者、nickname=sanitizeNickname 后的展示名），
    // 原文整体夹在开闭标签之间 —— 与自动插话路径的边界 posture 一致
    expect(h.captured.steers[0].text).toBe(
      '<user_message qq="10001" nickname="小明">\n只跑冒烟部分\n</user_message>',
    )
    expect(h.captured.followups).toHaveLength(1) // 不新开回合

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('/steer 对非管理员保持全局命令纪律：仅管理员可用', async () => {
    const h = await makeCmdHarness({ newMessagePolicy: 'steer' })
    // 群任务运行中（私聊 dmPolicy=open 仅管理员，群聊走 groupPolicy）
    h.sendGroupTextAs('启动群任务', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h, 'group:888')

    const before = h.outbound.length
    h.sendGroupTextAs('/steer 普通成员的插话', 20003)
    await vi.waitFor(() => {
      expect(h.outbound.slice(before).some(f => JSON.stringify(f.params).includes('该命令仅管理员可用'))).toBe(true)
    })
    expect(h.captured.steers).toHaveLength(0)
    expect(h.captured.followups).toHaveLength(1)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})

describe('T8：自动回执开关（notices）', () => {
  it('notices.queue=false：排队照常，但不发排队提示；缺省（true）行为不变由上方既有用例覆盖', async () => {
    const h = await makeCmdHarness({ notices: { queue: false } })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)

    h.sendText('排队消息一')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    h.sendText('排队消息二')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))

    await new Promise(resolve => setTimeout(resolve, 150))
    expect(sentTexts(h.outbound).filter(t => t.includes(QUEUE_NOTICE_TEXT))).toHaveLength(0)
    expect(h.outbound.filter(f => f.action === 'send_msg')).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('notices.steerAccepted=false：steer 照常受理，但不发提交提示', async () => {
    const h = await makeCmdHarness({ newMessagePolicy: 'steer', notices: { steerAccepted: false } })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)

    h.sendText('补充指令 A')
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
    expect(h.captured.steers[0].text).toContain('补充指令 A')

    await new Promise(resolve => setTimeout(resolve, 150))
    expect(sentTexts(h.outbound).filter(t => t.includes(STEER_ACCEPTED_NOTICE))).toHaveLength(0)
    expect(h.outbound.filter(f => f.action === 'send_msg')).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})
