/**
 * Issue #26 回归：回复正文末尾不得拼上用户消息原文。
 *
 * 根因（#26 诊断结论）：插件与宿主均无「把用户文本并进回复文本」的代码路径
 * ——queue 策略下后到消息经 agent.followup 只进宿主下一回合（成为独立回合），
 * steer 策略下经 agent.steer 在最近 step 边界进入当前回合。两者中模型都可能
 * 把 <user_message …>…</user_message> 边界包裹（wrapUserMessage）整块回显在
 * 回复末尾，而 stripBoundaryLeakage 的「全包裹剥标签保留内容」策略把回显
 * 内容逐字留在正文尾部 —— 用户看到「回复 + 后到消息原文」拼在同一条消息里。
 *
 * 修复：stripBoundaryLeakage 增加尾部整包裹规则 —— 正文（trim 后）以完整
 * 包裹收尾且前面还有其他正文时，连内容整块删除（尾部回显 = 泄漏签名）；
 * 包裹覆盖全文（T9 原语义）与中段包裹（有意引用，T9 :403）不变。
 *
 * 两条 e2e 时序：
 * - queue（默认）：第一条回复已发出，第二条消息作为下一回合的独立输入，
 *   模型尾部回显自己的输入包裹 —— 修复前回复逐字拼上第二条原文（红）。
 * - steer（插话）：第一条回复尚未发出第二条即到达（插话进当前回合），
 *   模型尾部回显插话文本的包裹 —— 修复前同样拼上（红）。
 * @module dsh-onebot/tests/issue26-reply-echo
 */
import { describe, expect, it, vi } from 'vitest'

import { STEER_ACCEPTED_NOTICE } from '../src/commands.js'
import { makeCmdHarness, makeEvent, sentTexts } from './helpers/bridge-harness.js'

function setRunning(h: Awaited<ReturnType<typeof makeCmdHarness>>, chatId = 'private:10001'): void {
  const chat = (h as unknown as { chats: Map<string, { agent: { status: string } }> }).chats().get(chatId)
  expect(chat, 'chat 未创建').toBeDefined()
  chat!.agent.status = 'running'
}

/** 模型回复正文 + 尾部整块回显 <user_message> 包裹（#26 症状形态）。 */
function replyWithTailEcho(reply: string, userText: string): string {
  return reply + '<user_message qq="10001" nickname="小明">\n' + userText + '\n</user_message>'
}

describe('#26：回复正文不拼接后到/回显的用户消息', () => {
  it('queue：第二条消息进入下一回合（独立 followup），其原文不得出现在任何回复正文里', async () => {
    const h = await makeCmdHarness() // 缺省 queue + interim
    h.sendText('在吗')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '在的，有什么事？' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    // 第一条回复先行送达（与报告截图一致：拼接待发生时回复已发出）
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('在的，有什么事？'))).toBe(true))

    h.sendText('帮我看下今天天气')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    // 后到消息成为自己的独立回合（宿主契约：followup = 下一回合唯一普通消息）
    expect(h.captured.followups[1].text).toContain('帮我看下今天天气')

    const session2 = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session2 as never, makeEvent('turn/start', { turn: 2 }))
    h.ctx.emit('session/event', session2 as never, makeEvent('assistant/message', {
      turn: 2, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: replyWithTailEcho('好的，我查一下……', '帮我看下今天天气') }] },
    }))
    h.ctx.emit('session/event', session2 as never, makeEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('好的，我查一下……'))).toBe(true))
    // 第二回合回复不含第二条原文（修复前：正文尾部逐字拼上「帮我看下今天天气」）
    expect(sentTexts(h.outbound).some(t => t.includes('帮我看下今天天气'))).toBe(false)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('steer：第一条回复发出前第二条消息插话进当前回合，其原文不得拼进该回合回复', async () => {
    const h = await makeCmdHarness({ newMessagePolicy: 'steer' })
    h.sendText('在吗')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '在的，有什么事？' }] },
    }))
    // 第一条回复尚未发出（turn 未结束）第二条即到达 → 插话进当前任务
    h.sendText('帮我看下今天天气')
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
    expect(h.captured.steers[0].text).toContain('帮我看下今天天气')
    expect(h.captured.followups).toHaveLength(1) // 不新开回合
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes(STEER_ACCEPTED_NOTICE))).toBe(true))

    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 2,
      message: { role: 'assistant', content: [{ type: 'text', text: replyWithTailEcho('好的，我查一下……', '帮我看下今天天气') }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('好的，我查一下……'))).toBe(true))
    // 该回合回复正文不含插话原文（修复前：尾部逐字拼上「帮我看下今天天气」）
    expect(sentTexts(h.outbound).some(t => t.includes('帮我看下今天天气'))).toBe(false)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})
