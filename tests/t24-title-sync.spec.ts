/**
 * T24 (PR port 会话标题同步) 测试：
 *  - 桥接侧：QQ 用户消息派发回合后按开关门控触发宿主 dsh-session-title 的
 *    refresh（每条消息一次，等价宿主 all-prompts 自动标题）——开关关不调、
 *    开关开+未钉住调、钉住态（snapshot.source.kind==='user'，用户手动命名）
 *    绝不调（refresh 的语义是故意解除钉住）、服务缺失跳过不崩、
 *    get/refresh 异常只 warn 不冒泡；
 *  - 设置键：titleSyncEnabled 默认关（schema 解析与 SCHEMA_DEFAULTS 一致）、
 *    validatePatch 布尔通道可写、类型不符拒绝。
 * @module dsh-onebot/tests/t24-title-sync
 */
import { describe, expect, it, vi } from 'vitest'

import { Config } from '../src/index.js'
import { SCHEMA_DEFAULTS, validatePatch } from '../src/settings-remote.js'
import { makeHarness } from './helpers/bridge-harness.js'

type TitleServiceStub = {
  get: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
}

/** 一个未钉住/可注入的标题服务桩：get 默认返回 undefined（尚无标题）。 */
function makeTitleService(overrides: { get?: () => unknown; refresh?: () => Promise<unknown> } = {}): TitleServiceStub {
  return {
    get: vi.fn(overrides.get ?? (() => undefined)),
    refresh: vi.fn(overrides.refresh ?? (async () => undefined)),
  }
}

describe('T24 桥接：派发回合后的标题同步门控', () => {
  it('开关关（默认缺省）：派发照旧，get/refresh 均不被调用', async () => {
    const service = makeTitleService()
    const h = await makeHarness({ sessionTitle: service })
    h.sendText('开关关的第一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(service.get).not.toHaveBeenCalled()
    expect(service.refresh).not.toHaveBeenCalled()
  }, 15000)

  it('开关开+未钉住：每条消息派发后 refresh 一次，入参是该会话的活 Session 对象', async () => {
    const service = makeTitleService()
    const h = await makeHarness({ titleSyncEnabled: true, sessionTitle: service })
    h.sendText('帮我看看这个报错')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    await vi.waitFor(() => expect(service.refresh).toHaveBeenCalledTimes(1))
    // get 与 refresh 收到同一个 Session 对象（chat.agent.session 的活引用，
    // 宿主活性断言要求 sessions.get(session.id) === session）。
    expect(service.get).toHaveBeenCalledTimes(1)
    expect(service.get.mock.calls[0][0]).toMatchObject({ id: h.sessionIds[0] })
    expect(service.refresh.mock.calls[0][0]).toBe(service.get.mock.calls[0][0])
    // 第二条消息再派发 → 再 refresh 一次（频率=每条消息）。
    h.sendText('第二条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    await vi.waitFor(() => expect(service.refresh).toHaveBeenCalledTimes(2))
  }, 15000)

  it('钉住态（snapshot.source.kind===\'user\'）：绝不调 refresh（用户手动命名的标题永不覆盖）', async () => {
    const service = makeTitleService({ get: () => ({ title: '我的会话', source: { kind: 'user' } }) })
    const h = await makeHarness({ titleSyncEnabled: true, sessionTitle: service })
    h.sendText('钉住态的消息')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(service.get).toHaveBeenCalledTimes(1) // 快照读了
    expect(service.refresh).not.toHaveBeenCalled() // 但钉住态不刷新
  }, 15000)

  it('服务缺失（宿主未部署标题插件）：开关开也跳过，不崩、回合照常派发', async () => {
    const h = await makeHarness({ titleSyncEnabled: true })
    h.sendText('没有标题服务的消息')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('没有标题服务的消息')
  }, 15000)

  it('get 同步抛异常：只 warn 不冒泡，派发主流程不受影响', async () => {
    const service = makeTitleService({ get: () => { throw new Error('session "x" is not live in this store') } })
    const logs: Array<{ level: string; message: string }> = []
    const h = await makeHarness({ titleSyncEnabled: true, sessionTitle: service, log: (level, message) => logs.push({ level, message }) })
    h.sendText('get 抛异常的消息')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    await vi.waitFor(() => expect(logs.some(l => l.level === 'warn' && l.message.includes('会话标题刷新失败') && l.message.includes('is not live'))).toBe(true))
    expect(service.refresh).not.toHaveBeenCalled()
  }, 15000)

  it('refresh 拒绝：catch 落 warn，不产生未处理 rejection、不冒泡', async () => {
    const service = makeTitleService({ refresh: async () => { throw new Error('provider boom') } })
    const logs: Array<{ level: string; message: string }> = []
    const h = await makeHarness({ titleSyncEnabled: true, sessionTitle: service, log: (level, message) => logs.push({ level, message }) })
    h.sendText('refresh 拒绝的消息')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    await vi.waitFor(() => expect(service.refresh).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(logs.some(l => l.level === 'warn' && l.message.includes('会话标题刷新失败') && l.message.includes('provider boom'))).toBe(true))
  }, 15000)
})

describe('T24 设置键：titleSyncEnabled', () => {
  it('schema 默认关，与 SCHEMA_DEFAULTS 一致', () => {
    const resolved = Config({}) as Record<string, unknown>
    expect(SCHEMA_DEFAULTS.titleSyncEnabled).toBe(false)
    expect(resolved.titleSyncEnabled).toBe(false)
  })

  it('validatePatch：布尔通道可写，类型不符拒绝', () => {
    expect(validatePatch({ titleSyncEnabled: true })).toEqual({ titleSyncEnabled: true })
    expect(validatePatch({ titleSyncEnabled: false })).toEqual({ titleSyncEnabled: false })
    expect(() => validatePatch({ titleSyncEnabled: 'yes' })).toThrow()
  })
})
