/**
 * T7 (PR port 入站连发合并) 测试：
 *  - 单元侧：InboundScheduler 合并窗口/最长等待/超限丢弃/斜杠命令直通/
 *    注入直通/每会话串行链/stop 清理/合成事件 mid=最后一条；
 *  - 桥接侧：开关开（合并为单回合、mid=最后一条 message_id）、开关关
 *    （不排队不合并，逐字节等价的既有两条回合路径）；
 *  - 设置键：inboxQueueEnabled/inboxQueueDelayMs 进 schema/键表/校验。
 * 卡片 json 解析（本批第②项）已在 src/cq.ts（319a97a，先于 T1 入库）且由
 * tests/cq.spec.ts 覆盖全角化/控制字符/码点截断，无需重复。
 * @module dsh-onebot/tests/t7-port
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  INBOUND_MAX_PENDING,
  INBOUND_MERGE_MAX_WAIT_MS,
  INBOUND_MERGE_WINDOW_MS,
  InboundScheduler,
  inboundChatKey,
  isCommandText,
  mergeInboundEvents,
} from '../src/inbound-queue.js'
import type { OneBotEvent } from '../src/connection.js'
import { makeHarness } from './helpers/bridge-harness.js'
import { SCHEMA_DEFAULTS, SETTINGS_GROUPS, validatePatch } from '../src/settings-remote.js'

let seq = 0
function makeEvent(text: string, overrides: Partial<OneBotEvent> = {}): OneBotEvent {
  seq += 1
  return {
    post_type: 'message', message_type: 'group', group_id: 888, user_id: 10001, self_id: 10002,
    message_id: 9000 + seq, time: 1700000000 + seq,
    message: [{ type: 'text', data: { text } }], raw_message: text,
    sender: { user_id: 10001, nickname: '小明' },
    ...overrides,
  } as OneBotEvent
}

afterEach(() => {
  vi.useRealTimers()
})

describe('T7 单元：InboundScheduler 连发合并', () => {
  it('常量与贡献者一致：600ms 窗口 / 3000ms 封顶 / 50 上限', () => {
    expect(INBOUND_MERGE_WINDOW_MS).toBe(600)
    expect(INBOUND_MERGE_MAX_WAIT_MS).toBe(3000)
    expect(INBOUND_MAX_PENDING).toBe(50)
  })

  it('窗口内两条合并为一条：raw join 换行、mid/time 取最后一条、段序保留', async () => {
    vi.useFakeTimers()
    const delivered: OneBotEvent[] = []
    const q = new InboundScheduler({ log: () => undefined, deliver: async e => { delivered.push(e) } })
    const p1 = q.push(makeEvent('你好'))
    await vi.advanceTimersByTimeAsync(100)
    const p2 = q.push(makeEvent('在吗'))
    expect(delivered).toHaveLength(0) // 窗口内不投递
    await vi.advanceTimersByTimeAsync(600) // 最后一条起等满窗口
    await Promise.all([p1, p2])
    expect(delivered).toHaveLength(1)
    expect(delivered[0].raw_message).toBe('你好\n在吗')
    expect(delivered[0].message_id).toBe(9002) // 最后一条的 mid（T7 口径）
    expect(delivered[0].time).toBe(1700000002)
    expect(delivered[0].message).toEqual([{ type: 'text', data: { text: '你好' } }, { type: 'text', data: { text: '在吗' } }])
  })

  it('窗口边界：最后一条进来后等满 mergeWindowMs 才投递', async () => {
    vi.useFakeTimers()
    const delivered: OneBotEvent[] = []
    const q = new InboundScheduler({ log: () => undefined, deliver: async e => { delivered.push(e) } })
    void q.push(makeEvent('a'))
    await vi.advanceTimersByTimeAsync(599)
    expect(delivered).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(delivered).toHaveLength(1)
  })

  it('首条起最多等 mergeMaxWaitMs：连续重置窗口也会在封顶时立即 flush', async () => {
    vi.useFakeTimers()
    const delivered: OneBotEvent[] = []
    const q = new InboundScheduler({ log: () => undefined, deliver: async e => { delivered.push(e) } })
    void q.push(makeEvent('m1'))
    for (let i = 2; i <= 6; i++) {
      await vi.advanceTimersByTimeAsync(550) // 每次都在窗口内（重置定时器）
      void q.push(makeEvent('m' + String(i)))
    }
    // t=2750 时首条已过 2750ms，剩余配额只有 250ms < 600ms 窗口 → 封顶生效
    await vi.advanceTimersByTimeAsync(300)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].raw_message).toBe('m1\nm2\nm3\nm4\nm5\nm6')
  })

  it('全局积压超过 maxPending：丢弃一条并 warn，不投递', async () => {
    vi.useFakeTimers()
    const warns: string[] = []
    let releaseFirst = (): void => undefined
    const delivered: string[] = []
    const q = new InboundScheduler({
      log: (level, message) => { if (level === 'warn') warns.push(message) },
      deliver: async e => {
        delivered.push(String(e.raw_message))
        if (e.raw_message === '/hold') await new Promise<void>(resolve => { releaseFirst = resolve })
      },
      maxPending: 2,
    })
    // 斜杠命令走串行链（enqueue），可精确控制 pending 计数。
    const p1 = q.push(makeEvent('/hold'))
    const p2 = q.push(makeEvent('/b'))
    const p3 = q.push(makeEvent('/c'))
    await p3
    await Promise.resolve()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('入站队列已满(2)')
    expect(delivered).toEqual(['/hold'])
    releaseFirst()
    await Promise.all([p1, p2])
    await vi.advanceTimersByTimeAsync(10)
    expect(delivered).toEqual(['/hold', '/b']) // /c 已丢弃
  })

  it('斜杠命令不合并：绕过窗口立即按原样投递', async () => {
    vi.useFakeTimers()
    const delivered: OneBotEvent[] = []
    const q = new InboundScheduler({ log: () => undefined, deliver: async e => { delivered.push(e) } })
    await q.push(makeEvent('/help'))
    expect(delivered).toEqual([expect.objectContaining({ raw_message: '/help' })])
    // 命令之后 0ms 到达的普通消息也不被并进命令
    void q.push(makeEvent('普通消息'))
    await vi.advanceTimersByTimeAsync(600)
    expect(delivered.map(e => e.raw_message)).toEqual(['/help', '普通消息'])
    expect(isCommandText(makeEvent('/status'))).toBe(true)
    expect(isCommandText(makeEvent('帮个忙'))).toBe(false)
  })

  it('注入消息直通：不排队不合并，走 injectDeliver', async () => {
    vi.useFakeTimers()
    const delivered: string[] = []
    const injected: string[] = []
    const q = new InboundScheduler({
      log: () => undefined,
      deliver: async e => { delivered.push(String(e.raw_message)) },
      injectDeliver: async e => { injected.push(String(e.raw_message)) },
    })
    void q.push(makeEvent('普通消息')) // 占住窗口
    await q.push(makeEvent('注入内容'), { injected: true })
    expect(injected).toEqual(['注入内容'])
    expect(delivered).toHaveLength(0) // 注入不打断合并窗口
    await vi.advanceTimersByTimeAsync(600)
    expect(delivered).toEqual(['普通消息'])
  })

  it('每会话串行链：同一会话先到先答，慢消息不插队', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const q = new InboundScheduler({
      log: () => undefined,
      deliver: async e => {
        order.push('enter:' + String(e.raw_message))
        if (e.raw_message === '/慢命令') await new Promise<void>(resolve => { setTimeout(resolve, 500) })
        order.push('exit:' + String(e.raw_message))
      },
    })
    // 斜杠命令绕过合并窗口直进串行链，正好逐一验证先后。
    void q.push(makeEvent('/a'))
    void q.push(makeEvent('/慢命令'))
    void q.push(makeEvent('/c'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(order).toEqual(['enter:/a', 'exit:/a', 'enter:/慢命令', 'exit:/慢命令', 'enter:/c', 'exit:/c'])
  })

  it('不同会话互不阻塞：两条链并行推进', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const q = new InboundScheduler({
      log: () => undefined,
      deliver: async e => {
        order.push(String(e.raw_message))
        if (e.raw_message === '/慢命令') await new Promise<void>(resolve => { setTimeout(resolve, 300) })
      },
    })
    // 两个不同会话（群 888 与私聊 10002）各一条命令，各自串行链并行。
    void q.push(makeEvent('/慢命令'))
    void q.push(makeEvent('/fast', { message_type: 'private', group_id: undefined, user_id: 10002 }))
    await vi.advanceTimersByTimeAsync(50)
    expect(order).toEqual(['/慢命令', '/fast'])
  })

  it('链尾错误吞掉并记 error，不污染后续消息', async () => {
    vi.useFakeTimers()
    const errors: string[] = []
    const delivered: string[] = []
    const q = new InboundScheduler({
      log: (level, message) => { if (level === 'error') errors.push(message) },
      deliver: async e => {
        if (e.raw_message === '/boom') throw new Error('kaboom')
        delivered.push(String(e.raw_message))
      },
    })
    await q.push(makeEvent('/boom'))
    await q.push(makeEvent('/ok'))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('inbound handling failed')
    expect(errors[0]).toContain('kaboom')
    expect(delivered).toEqual(['/ok'])
  })

  it('stop()：清合并定时器并放行等待者，之后不再投递', async () => {
    vi.useFakeTimers()
    const delivered: OneBotEvent[] = []
    const q = new InboundScheduler({ log: () => undefined, deliver: async e => { delivered.push(e) } })
    const pending = q.push(makeEvent('还没投'))
    q.stop()
    await pending
    await vi.advanceTimersByTimeAsync(2000)
    expect(delivered).toHaveLength(0)
  })

  it('mergeInboundEvents/inboundChatKey 纯函数：段序保留、mid 取最后一条、键按会话', () => {
    const merged = mergeInboundEvents([makeEvent('一', { message_id: 11 }), makeEvent('二', { message_id: 22, time: 555 })])
    expect(merged.raw_message).toBe('一\n二')
    expect(merged.message_id).toBe(22)
    expect(merged.time).toBe(555)
    expect(inboundChatKey(makeEvent('x', { message_type: 'private', user_id: 7 }))).toBe('private:7')
    expect(inboundChatKey(makeEvent('x', { message_type: 'group', group_id: 9, user_id: 7 }))).toBe('group:9')
    expect(inboundChatKey(undefined)).toBe('other')
  })
})

describe('T7 桥接：开关开/关两侧', () => {
  it('开侧：同会话连发两条合并为一个回合，合成消息 mid=最后一条', async () => {
    const h = await makeHarness({ inboxQueueEnabled: true, inboxQueueDelayMs: 80 })
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message_id: 101, time: 1700000101,
      message: [{ type: 'text', data: { text: '第一句' } }], raw_message: '第一句',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message_id: 102, time: 1700000102,
      message: [{ type: 'text', data: { text: '第二句' } }], raw_message: '第二句',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    // mid=最后一条 102（与 review-t2.md <user_message mid=…> / [[reply:]] 口径衔接）
    expect(h.captured.followups[0].text).toContain('mid="102"')
    expect(h.captured.followups[0].text).toContain('第一句')
    expect(h.captured.followups[0].text).toContain('第二句')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(h.captured.followups).toHaveLength(1) // 只有一个回合，没有被拆成两条
  }, 15000)

  it('开侧：斜杠命令不合并，连发的普通消息也不被并进命令回合', async () => {
    const h = await makeHarness({ inboxQueueEnabled: true, inboxQueueDelayMs: 80 })
    h.sendText('/help')
    h.sendText('跟着命令的普通消息')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).not.toContain('/help')
    // /help 走命令路由立即回执（不被 80ms 窗口拖住）
    await vi.waitFor(() => expect(h.outbound.some(f => JSON.stringify(f.params).includes('可用命令'))).toBe(true))
  }, 15000)

  it('关侧（默认缺省）：不排队不合并，连发两条照旧两个独立回合', async () => {
    const h = await makeHarness()
    h.sendText('关侧第一条')
    h.sendText('关侧第二条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[0].text).toContain('关侧第一条')
    expect(h.captured.followups[1].text).toContain('关侧第二条')
  }, 15000)
})

describe('T7 设置键：inboxQueueEnabled/inboxQueueDelayMs', () => {
  it('schema 默认值与 SCHEMA_DEFAULTS 一致（开关默认关、窗口 600ms）', () => {
    expect(SCHEMA_DEFAULTS.inboxQueueEnabled).toBe(false)
    expect(SCHEMA_DEFAULTS.inboxQueueDelayMs).toBe(600)
  })

  it('validatePatch：布尔与数字均可写，负数窗口被拒', () => {
    expect(validatePatch({ inboxQueueEnabled: true, inboxQueueDelayMs: 1000 }))
      .toEqual({ inboxQueueEnabled: true, inboxQueueDelayMs: 1000 })
    expect(() => validatePatch({ inboxQueueDelayMs: -1 })).toThrow()
    expect(() => validatePatch({ inboxQueueEnabled: 'yes' })).toThrow()
  })

  it('behavior 组键序：deferredTimeoutMs 之后追加两键', () => {
    expect(SETTINGS_GROUPS.behavior.slice(-4)).toEqual(['deferredTimeoutMs', 'inboxQueueEnabled', 'inboxQueueDelayMs', 'titleSyncEnabled'])
  })
})
