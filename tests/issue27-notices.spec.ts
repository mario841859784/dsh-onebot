/**
 * T1 (#27)：notices 自定义文案/新增三类回执开关回归测试。
 *
 * 语义定稿（issue #27，对 notices 各键统一生效）：
 * - `false` = 不发；`true` / 缺省 = 默认文案（0.9.x 行为不变）；
 *   非空 `string` = 自定义文案；空串 `""` = 不发。
 * - steerAccepted：string 时自动回执（bridge.ts）与 /steer 命令确认
 *   （commands.ts）都改用自定义文案；false 只关自动回执——命令确认是
 *   命令回执，保持默认文案照发。
 * - queue：dedup（每个运行回合至多一条）不受文案/开关影响。
 * - rateLimited：每窗口至多一条的既有语义不变（rateLimitNoticeAt 在
 *   发送前无条件更新——关闭提示不改变窗口推进）。
 * - answerAccepted / deferredTimeout：string=自定义，false/''=不发。
 * 默认文案行为由既有 spec 覆盖（steer-queue / ask-bridge / deferred /
 * inbound），本文件聚焦四态矩阵与新键；每键默认文案各留一条直证用例。
 * @module dsh-onebot/tests/issue27-notices
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ANSWER_ACCEPTED_NOTICE, QUEUE_NOTICE_TEXT } from '../src/bridge.js'
import { resolveNoticeText } from '../src/notices.js'
import { DEFERRED_REGISTRY_FILE } from '../src/deferred.js'
import { STEER_ACCEPTED_NOTICE } from '../src/commands.js'
import { makeCmdHarness, makeEvent, sentTexts } from './helpers/bridge-harness.js'

/** 补发注册表读取助手（与 tests/deferred.spec 同形）：解析 JSONL 为条目数组。 */
function readRegistry(mediaDir: string): Array<{ state: string }> {
  const file = join(mediaDir, DEFERRED_REGISTRY_FILE)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as { state: string })
}

const DEFERRED_TIMEOUT_DEFAULT_HINT = '等待模型回复超时'
const RATE_LIMIT_DEFAULT_TEXT = '消息太频繁'

/** 把指定 chat 的假 agent 置于运行态（真实宿主中由回合驱动自动切换）。 */
function setRunning(h: Awaited<ReturnType<typeof makeCmdHarness>>, chatId = 'private:10001'): void {
  const chat = h.chats().get(chatId) as { agent: { status: string } } | undefined
  expect(chat, 'chat 未创建').toBeDefined()
  chat!.agent.status = 'running'
}

describe('resolveNoticeText（纯函数四态矩阵）', () => {
  it('undefined/true → 默认文案；false/空串 → null；非空 string → 原样', () => {
    const fallback = '默认文案'
    expect(resolveNoticeText(undefined, fallback)).toBe(fallback)
    expect(resolveNoticeText(true, fallback)).toBe(fallback)
    expect(resolveNoticeText(false, fallback)).toBeNull()
    expect(resolveNoticeText('', fallback)).toBeNull()
    expect(resolveNoticeText('自定义', fallback)).toBe('自定义')
  })
})

describe('notices.queue', () => {
  it('缺省 = 默认文案（直证）；自定义 string = 自定义文案且 dedup 不回归（每运行回合至多一条）', async () => {
    const h = await makeCmdHarness()
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)
    h.sendText('排队消息一')
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes(QUEUE_NOTICE_TEXT))).toBe(true))
    h.sendText('排队消息二')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(sentTexts(h.outbound).filter(t => t.includes(QUEUE_NOTICE_TEXT))).toHaveLength(1)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('自定义 string：文案替换、排队照常、每运行回合至多一条', async () => {
    const h = await makeCmdHarness({ notices: { queue: '⏳ 自定义排队提示' } })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)
    h.sendText('排队消息一')
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('自定义排队提示'))).toBe(true))
    expect(sentTexts(h.outbound).some(t => t.includes(QUEUE_NOTICE_TEXT))).toBe(false)
    h.sendText('排队消息二')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(sentTexts(h.outbound).filter(t => t.includes('自定义排队提示'))).toHaveLength(1)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it.each([false, ''] as const)('notices.queue=%j：排队照常但不发提示（默认/自定义都不发）', async (value) => {
    const h = await makeCmdHarness({ notices: { queue: value } })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)
    h.sendText('排队消息一')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(sentTexts(h.outbound).some(t => t.includes(QUEUE_NOTICE_TEXT) || t.includes('排队'))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('notices.steerAccepted', () => {
  it('自定义 string：自动回执与 /steer 命令确认都改用自定义文案', async () => {
    const h = await makeCmdHarness({ newMessagePolicy: 'steer', notices: { steerAccepted: '✅ 自定义受理回执' } })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)
    h.sendText('自动插话内容')
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('自定义受理回执'))).toBe(true))
    expect(sentTexts(h.outbound).some(t => t.includes(STEER_ACCEPTED_NOTICE))).toBe(false)
    // /steer 命令确认同样改用自定义文案。
    h.sendText('/steer 命令插话内容')
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(2))
    await vi.waitFor(() => expect(sentTexts(h.outbound).filter(t => t.includes('自定义受理回执'))).toHaveLength(2))
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('false：自动回执不发；/steer 命令确认保持默认文案（命令回执不受开关影响）', async () => {
    const h = await makeCmdHarness({ notices: { steerAccepted: false } })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)
    h.sendText('/steer 命令插话内容')
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes(STEER_ACCEPTED_NOTICE))).toBe(true))
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('空串：自动回执与 /steer 命令确认都不发（steer 本身照常受理）', async () => {
    const h = await makeCmdHarness({ newMessagePolicy: 'steer', notices: { steerAccepted: '' } })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)
    h.sendText('自动插话内容')
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
    h.sendText('/steer 命令插话内容')
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(2))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(sentTexts(h.outbound).some(t => t.includes(STEER_ACCEPTED_NOTICE))).toBe(false)
    expect(sentTexts(h.outbound).some(t => t.includes('补充指令'))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('notices.answerAccepted', () => {
  /** 既有 spec（ask-bridge）覆盖默认文案；此处走同一条 pending 拦截路径。 */
  const questionBlock = (messageId: string) => ({
    turn: 1, step: 2, message: { role: 'assistant', id: messageId, content: [
      { type: 'tool-call', id: 'c2', name: 'ask_user_question', arguments: JSON.stringify({ questions: [
        { id: 'q1', question: '选哪个方案？', options: [{ label: '方案A' }, { label: '方案B' }], multi_select: true },
      ] }) },
    ] },
  })

  it('自定义 string：回答回执改用自定义文案', async () => {
    const answer = vi.fn(async () => true)
    const h = await makeCmdHarness({ userQuestions: { askTimed: async () => ({ pending: true, callId: 'c2' }), answer }, notices: { answerAccepted: '📨 自定义回答回执' } })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('assistant/message', questionBlock('relay-q-t1')))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('回复编号或字母选择'))).toBe(true))
    h.sendText('1,2')
    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('自定义回答回执'))).toBe(true))
    expect(sentTexts(h.outbound).some(t => t.includes(ANSWER_ACCEPTED_NOTICE))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it.each([false, ''] as const)('notices.answerAccepted=%j：回答回执不发（结算照常）', async (value) => {
    const answer = vi.fn(async () => true)
    const h = await makeCmdHarness({ userQuestions: { askTimed: async () => ({ pending: true, callId: 'c2' }), answer }, notices: { answerAccepted: value } })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('assistant/message', questionBlock('relay-q-t2')))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('回复编号或字母选择'))).toBe(true))
    h.sendText('1,2')
    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(sentTexts(h.outbound).some(t => t.includes(ANSWER_ACCEPTED_NOTICE))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('notices.deferredTimeout', () => {
  it('自定义 string：超时提示改用自定义文案（登记照常）', async () => {
    const h = await makeCmdHarness({ deferredTimeoutMs: 30, notices: { deferredTimeout: '⏳ 自定义超时提示' } })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1), { timeout: 5_000 })
    h.chats().get('private:10001')!.agent.status = 'running'
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/start', { turn: 1 }))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('自定义超时提示'))).toBe(true), { timeout: 5_000 })
    expect(sentTexts(h.outbound).some(t => t.includes(DEFERRED_TIMEOUT_DEFAULT_HINT))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it.each([false, ''] as const)('notices.deferredTimeout=%j：超时提示不发（补发登记照常）', async (value) => {
    const h = await makeCmdHarness({ deferredTimeoutMs: 30, notices: { deferredTimeout: value } })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1), { timeout: 5_000 })
    h.chats().get('private:10001')!.agent.status = 'running'
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/start', { turn: 1 }))
    // 提示被关闭 → 无输出消息；只放宽等待窗验证登记照常发生。
    await vi.waitFor(() => expect(readRegistry(h.mediaDir).some(entry => entry.state === 'pending')).toBe(true), { timeout: 5_000 })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(sentTexts(h.outbound).some(t => t.includes(DEFERRED_TIMEOUT_DEFAULT_HINT))).toBe(false)
    expect(sentTexts(h.outbound).some(t => t.includes('自定义超时提示'))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('notices.rateLimited', () => {
  it('自定义 string：频控提示改用自定义文案，每窗口至多一条不回归', async () => {
    const h = await makeCmdHarness({ rateLimitPerMinute: 2, notices: { rateLimited: '🚦 自定义频控提示' } })
    // 首条消息先于 ChatAgent 创建（空窗口）从不计数 → 第 2+3 条填满窗口，第 4 条触发。
    h.sendText('第一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.sendText('第二条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    h.sendText('第三条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))
    h.sendText('第四条')
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('自定义频控提示'))).toBe(true))
    // 仍超限的第五条被丢弃，但同窗口只提示一次。
    h.sendText('第五条')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(h.captured.followups).toHaveLength(3)
    expect(sentTexts(h.outbound).filter(t => t.includes('自定义频控提示'))).toHaveLength(1)
    expect(sentTexts(h.outbound).some(t => t.includes(RATE_LIMIT_DEFAULT_TEXT))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it.each([false, ''] as const)('notices.rateLimited=%j：限流丢弃照常但提示不发（窗口推进不受影响）', async (value) => {
    const h = await makeCmdHarness({ rateLimitPerMinute: 2, notices: { rateLimited: value } })
    h.sendText('第一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.sendText('第二条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    h.sendText('第三条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))
    h.sendText('第四条')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(h.captured.followups).toHaveLength(3) // 第四条被限流丢弃
    expect(sentTexts(h.outbound).some(t => t.includes(RATE_LIMIT_DEFAULT_TEXT))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
