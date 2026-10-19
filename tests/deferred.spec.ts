/**
 * 超时后结果补发回归测试（T3/P2 deferred delivery）。
 *
 * 语义定案（计划 §P2 + dsh-im readme L91-95 + registry.ts 持久化纪律）：
 * - 等待模型回复超时（deferredTimeoutMs 内无任何模型输出）→ 提示超时、登记
 *   补发注册表（chatId/sessionId/traceId/超时时刻），静音该回合（不插播
 *   interim、不转卡片），继续监听 turn/end；完成后向原聊天补发最终文字
 *   （「（超时补发）」前缀，走既有 outbound 管线），恰一次。
 * - 发送明确失败（断连 / 网关明确拒绝）最多尝试 3 次（退避 2s/10s），第 4 次
 *   永不尝试；动作超时或其他错误 = 结果不确定（消息可能已到达）→ 保留记录、
 *   停止自动重试（防重复消息）。
 * - 注册表逐行 JSONL 落盘 mediaDir（原子写、逐行损坏降级、缺失=全新）；重启
 *   后加载未完结条目恢复跟踪（该会话下一次 turn/end 兑现）；/stop 显式终止
 *   该聊天的跟踪（其他聊天不受影响）。
 * - 正常完成（未超时）零注册表写入、零补发。
 * 时序纪律：单元用构造器注入假时钟/调度器；集成用小阈值真实定时器 +
 * vi.waitFor 文本确定性等待。
 * @module dsh-onebot/tests/deferred
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TraceSink } from '../src/trace.js'
import { OneBotActionError, OneBotNotConnectedError } from '../src/connection.js'
import {
  DEFERRED_MAX_ENTRIES,
  DEFERRED_MAX_SEND_ATTEMPTS,
  DEFERRED_PREFIX,
  DEFERRED_REGISTRY_FILE,
  DEFERRED_RETRY_BACKOFF_MS,
  DeferredDelivery,
} from '../src/deferred.js'
import type { DeferredContext, DeferredEntry } from '../src/deferred.js'
import { makeCmdHarness, makeEvent, makeHarness, sentTexts } from './helpers/bridge-harness.js'

/** 注册表读取助手：解析 JSONL 为条目数组。 */
function readRegistry(mediaDir: string): DeferredEntry[] {
  const file = join(mediaDir, DEFERRED_REGISTRY_FILE)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as DeferredEntry)
}

const flush = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)) }

/** 注入式调度器（假时钟替身）：计时器与重试退避共用同一条任务列。 */
class FakeScheduler {
  tasks: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  schedule = (fn: () => void, ms: number): unknown => {
    const task = { fn, ms, cancelled: false }
    this.tasks.push(task)
    return task
  }

  cancel = (handle: unknown): void => {
    ;(handle as { cancelled: boolean }).cancelled = true
  }

  /** 运行最早的未取消任务（并从队列移除）。 */
  runNext(): void {
    const at = this.tasks.findIndex(task => !task.cancelled)
    expect(at, '没有可运行的定时任务').toBeGreaterThanOrEqual(0)
    const [task] = this.tasks.splice(at, 1)
    task.fn()
  }

  active(): Array<{ ms: number }> {
    return this.tasks.filter(task => !task.cancelled).map(task => ({ ms: task.ms }))
  }
}

/** 单元测试用最小 DeferredContext。 */
function makeUnitCtx(overrides: Partial<DeferredContext> = {}): { ctx: DeferredContext; sends: Array<{ chatId: string; text: string; options?: { queuable?: boolean } }>; mediaDir: string } {
  const mediaDir = mkdtempSync(join(tmpdir(), 'deferred-unit-'))
  const sends: Array<{ chatId: string; text: string; options?: { queuable?: boolean } }> = []
  const ctx: DeferredContext = {
    sendToChat: async (chatId, text, options) => {
      sends.push({ chatId, text, options })
      return ['1']
    },
    isTurnRunning: () => true,
    takePendingText: () => null,
    log: () => undefined,
    mediaDir,
    timeoutMs: 1_000,
    isStopping: () => false,
    ...overrides,
  }
  return { ctx, sends, mediaDir }
}

/** 走完整登记路径：onTurnStart → 触发超时计时器 → 条目 pending。 */
function registerUnit(scheduler: FakeScheduler, delivery: DeferredDelivery, chatId = 'private:10001', sessionId = 's-1'): void {
  delivery.onTurnStart(chatId, sessionId)
  scheduler.runNext()
}

// ─────────────────────────────── 单元：重试与分类 ───────────────────────────────

describe('deferred 单元 — 发送失败分类与重试上限', () => {
  it('明确失败（网关拒绝）恰好尝试 3 次、退避 2s/10s、第 4 次不试，终态 failed 落盘', async () => {
    const scheduler = new FakeScheduler()
    let sendAttempts = 0
    const { ctx, mediaDir } = makeUnitCtx({
      sendToChat: async () => {
        sendAttempts += 1
        throw new OneBotActionError('send_msg failed: retcode 400')
      },
    })
    const delivery = new DeferredDelivery(ctx, { now: () => 1_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    registerUnit(scheduler, delivery)
    const before = sendAttempts // 超时提醒发送（同样被拒）不计入补发重试计数
    delivery.onTurnEnd('private:10001', 's-1', { kind: 'completed' })
    for (let i = 0; i < DEFERRED_MAX_SEND_ATTEMPTS; i += 1) {
      await flush()
      if (i < DEFERRED_MAX_SEND_ATTEMPTS - 1) scheduler.runNext() // 退避到点
    }
    await flush()
    expect(sendAttempts - before).toBe(DEFERRED_MAX_SEND_ATTEMPTS) // 3 次尝试
    // 第 4 次永不尝试：再放行任何残余任务也不产生新发送
    while (scheduler.active().length > 0) scheduler.runNext()
    await flush()
    expect(sendAttempts - before).toBe(DEFERRED_MAX_SEND_ATTEMPTS)
    // 落盘是异步链（mkdir → 写临时文件 → rename），机器忙时一个节拍不够：确定性等待终态
    await vi.waitFor(() => expect(readRegistry(mediaDir)[0]?.state).toBe('failed'))
    const entries = readRegistry(mediaDir)
    expect(entries).toHaveLength(1)
    expect(entries[0].state).toBe('failed')
    expect(entries[0].attempts).toBe(3)
    expect(entries[0].reason).toContain('发送明确失败')
    // 退避间隔：2s → 10s
    expect(DEFERRED_RETRY_BACKOFF_MS).toEqual([2_000, 10_000])
  })

  it('断连（OneBotNotConnectedError）= 明确失败，走同一重试上限', async () => {
    const scheduler = new FakeScheduler()
    let sendAttempts = 0
    const { ctx } = makeUnitCtx({
      sendToChat: async () => {
        sendAttempts += 1
        throw new OneBotNotConnectedError()
      },
    })
    const delivery = new DeferredDelivery(ctx, { now: () => 1_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    registerUnit(scheduler, delivery)
    const before = sendAttempts
    delivery.onTurnEnd('private:10001', 's-1', { kind: 'completed' })
    for (let i = 0; i < DEFERRED_MAX_SEND_ATTEMPTS; i += 1) {
      await flush()
      if (i < DEFERRED_MAX_SEND_ATTEMPTS - 1) scheduler.runNext()
    }
    await flush()
    expect(sendAttempts - before).toBe(3)
  })

  it('不确定结果（动作超时）：恰 1 次尝试、零自动重试、记录保留为 uncertain', async () => {
    const scheduler = new FakeScheduler()
    let sendAttempts = 0
    const { ctx, mediaDir } = makeUnitCtx({
      sendToChat: async () => {
        sendAttempts += 1
        throw new OneBotActionError('OneBot action send_msg timed out after 3000ms')
      },
    })
    const delivery = new DeferredDelivery(ctx, { now: () => 1_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    registerUnit(scheduler, delivery)
    const before = sendAttempts
    delivery.onTurnEnd('private:10001', 's-1', { kind: 'completed' })
    await flush()
    expect(sendAttempts - before).toBe(1)
    while (scheduler.active().length > 0) scheduler.runNext()
    await flush()
    expect(sendAttempts - before).toBe(1) // 零自动重试
    // 落盘是异步链，机器忙时一个节拍不够：确定性等待终态
    await vi.waitFor(() => expect(readRegistry(mediaDir)[0]?.state).toBe('uncertain'))
    const entries = readRegistry(mediaDir)
    expect(entries[0].state).toBe('uncertain')
    expect(entries[0].reason).toContain('结果不确定')
  })

  it('非网关异常同样视为结果不确定：零自动重试', async () => {
    const scheduler = new FakeScheduler()
    let sendAttempts = 0
    const { ctx } = makeUnitCtx({
      sendToChat: async () => {
        sendAttempts += 1
        throw new Error('socket hung up mid-send')
      },
    })
    const delivery = new DeferredDelivery(ctx, { now: () => 1_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    registerUnit(scheduler, delivery)
    const before = sendAttempts
    delivery.onTurnEnd('private:10001', 's-1', { kind: 'completed' })
    await flush()
    while (scheduler.active().length > 0) scheduler.runNext()
    await flush()
    expect(sendAttempts - before).toBe(1)
    expect(delivery.snapshot()[0].state).toBe('uncertain')
  })

  it('首次发送成功：恰一次补发、终态 delivered 落盘（attempts=1）', async () => {
    const scheduler = new FakeScheduler()
    const { ctx, sends, mediaDir } = makeUnitCtx()
    const delivery = new DeferredDelivery(ctx, { now: () => 1_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    registerUnit(scheduler, delivery)
    delivery.onAssistantMessage('private:10001', 's-1', { id: 'm1', content: [{ type: 'text', text: '最终答案' }] })
    delivery.onTurnEnd('private:10001', 's-1', { kind: 'completed' })
    await vi.waitFor(() => expect(readRegistry(mediaDir)[0]?.state).toBe('delivered'))
    const deferredSends = sends.filter(send => send.text.startsWith(DEFERRED_PREFIX))
    expect(deferredSends).toHaveLength(1)
    expect(deferredSends[0].text).toBe(DEFERRED_PREFIX + '最终答案')
    const entries = readRegistry(mediaDir)
    expect(entries[0].attempts).toBe(1)
    expect(entries[0].sessionId).toBe('s-1')
    expect(entries[0].chatId).toBe('private:10001')
  })

  it('回合出错终态：补发终态通知（运行出错 reason），不重放结果文字', async () => {
    const scheduler = new FakeScheduler()
    const { ctx, sends } = makeUnitCtx()
    const delivery = new DeferredDelivery(ctx, { now: () => 1_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    registerUnit(scheduler, delivery)
    delivery.onAssistantMessage('private:10001', 's-1', { id: 'm1', content: [{ type: 'text', text: '半成品' }] })
    delivery.onTurnEnd('private:10001', 's-1', { kind: 'error', error: { message: '额度不足' } })
    await flush()
    const deferredSends = sends.filter(send => send.text.startsWith(DEFERRED_PREFIX))
    expect(deferredSends).toHaveLength(1)
    expect(deferredSends[0].text).toBe(DEFERRED_PREFIX + '任务已结束：运行出错：额度不足')
  })
})

describe('deferred 单元 — terminal 条目与 in-flight 守卫（T11/T12）', () => {
  it('terminal 条目只是可观测快照：onTurnEnd 返回 false、零补发（后续回合错误不静默）', async () => {
    const scheduler = new FakeScheduler()
    const { ctx, sends } = makeUnitCtx()
    const delivery = new DeferredDelivery(ctx, { now: () => 1_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    registerUnit(scheduler, delivery)
    delivery.onAssistantMessage('private:10001', 's-1', { id: 'm1', content: [{ type: 'text', text: '最终答案' }] })
    delivery.onTurnEnd('private:10001', 's-1', { kind: 'completed' })
    await vi.waitFor(() => expect(delivery.snapshot()[0]?.state).toBe('delivered'))
    expect(sends.filter(send => send.text.startsWith(DEFERRED_PREFIX))).toHaveLength(1)
    // 同会话后续回合（含错误回合）不再算 tracked：返回 false，bridge 照常发 ⚠️
    expect(delivery.onTurnEnd('private:10001', 's-1', { kind: 'error', error: { message: '新回合出错' } })).toBe(false)
    await flush()
    expect(sends.filter(send => send.text.startsWith(DEFERRED_PREFIX))).toHaveLength(1) // 零补发
  })

  it('防双发 in-flight 守卫：首发失败退避窗口内新回合收尾不并发启动第二条重试循环', async () => {
    const scheduler = new FakeScheduler()
    let deferredAttempts = 0
    const { ctx, sends, mediaDir } = makeUnitCtx({
      sendToChat: async (chatId, text, options) => {
        if (text.startsWith(DEFERRED_PREFIX)) {
          deferredAttempts += 1
          if (deferredAttempts === 1) throw new OneBotActionError('send_msg failed: retcode 500') // 首发明确失败 → 进入 2s 退避
        }
        sends.push({ chatId, text, options })
        return ['1']
      },
    })
    const delivery = new DeferredDelivery(ctx, { now: () => 1_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    registerUnit(scheduler, delivery)
    expect(sends).toHaveLength(1) // 超时提醒
    // 回合 A 收尾：补发首发失败，进入退避（状态仍 pending、in-flight）
    delivery.onTurnEnd('private:10001', 's-1', { kind: 'completed' })
    await flush()
    expect(deferredAttempts).toBe(1)
    expect(scheduler.active()).toEqual([{ ms: 2_000 }]) // 仅一条退避任务
    // 退避窗口内回合 B 收尾（同 entry 仍 pending）：让位，不再起新循环
    expect(delivery.onTurnEnd('private:10001', 's-1', { kind: 'completed' })).toBe(true)
    await flush()
    expect(deferredAttempts).toBe(1) // 未立即二次发送
    expect(scheduler.active()).toEqual([{ ms: 2_000 }]) // 未叠加第二条退避任务
    // 退避到点：在途循环第 2 次尝试成功，终态唯一且一致
    scheduler.runNext()
    await flush()
    while (scheduler.active().length > 0) scheduler.runNext()
    await flush()
    expect(sends.filter(send => send.text.startsWith(DEFERRED_PREFIX))).toHaveLength(1) // 恰一次补发
    await vi.waitFor(() => expect(readRegistry(mediaDir)[0]?.state).toBe('delivered')) // 落盘是异步链，确定性等待终态
    const entries = readRegistry(mediaDir)
    expect(entries).toHaveLength(1)
    expect(entries[0].attempts).toBe(2) // attempts 未被并发循环互相覆写
  })

  it('退避窗口内新回合错误收尾：让位路径返回 false（bridge 照常 ⚠️）、不产生回合 B 补发、在途回合 A 补发仍恰一次（T12 🔴-3）', async () => {
    const scheduler = new FakeScheduler()
    let deferredAttempts = 0
    const { ctx, sends, mediaDir } = makeUnitCtx({
      sendToChat: async (chatId, text, options) => {
        if (text.startsWith(DEFERRED_PREFIX)) {
          deferredAttempts += 1
          if (deferredAttempts === 1) throw new OneBotActionError('send_msg failed: retcode 500') // 首发明确失败 → 进入 2s 退避
        }
        sends.push({ chatId, text, options })
        return ['1']
      },
    })
    const delivery = new DeferredDelivery(ctx, { now: () => 1_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    registerUnit(scheduler, delivery)
    delivery.onAssistantMessage('private:10001', 's-1', { id: 'm1', content: [{ type: 'text', text: '回合A的最终答案' }] })
    // 回合 A 收尾：补发首发失败，进入退避（状态仍 pending、in-flight）
    delivery.onTurnEnd('private:10001', 's-1', { kind: 'completed' })
    await flush()
    expect(deferredAttempts).toBe(1)
    expect(scheduler.active()).toEqual([{ ms: 2_000 }])
    // 退避窗口内回合 B 错误收尾：让位路径不得声称 tracked——tracked=true
    // 会让 bridge 吞掉 ⚠️，而在途循环只持有回合 A 的 text 副本，回合 B 的
    // 错误 reason 不会被它送达（不变式：任何错误回合的 ⚠️ 通知必须可见）
    expect(delivery.onTurnEnd('private:10001', 's-1', { kind: 'error', error: { message: '退避窗口内的新错误' } })).toBe(false)
    await flush()
    expect(sends.filter(send => send.text.startsWith(DEFERRED_PREFIX))).toHaveLength(0) // 回合 B 不产生补发条目
    expect(scheduler.active()).toEqual([{ ms: 2_000 }]) // 在途回合 A 的补发循环不受影响（未叠加/未中断）
    // 退避到点：在途循环第 2 次尝试成功，补发仍恰一次（回合 A 的文字副本）
    scheduler.runNext()
    await flush()
    const deferredSends = sends.filter(send => send.text.startsWith(DEFERRED_PREFIX))
    expect(deferredSends).toHaveLength(1)
    expect(deferredSends[0].text).toBe(DEFERRED_PREFIX + '回合A的最终答案')
    await vi.waitFor(() => expect(readRegistry(mediaDir)[0]?.state).toBe('delivered'))
    const entries = readRegistry(mediaDir)
    expect(entries).toHaveLength(1)
    expect(entries[0].state).toBe('delivered')
    expect(entries[0].attempts).toBe(2) // attempts 未被让位路径破坏
  })
})

describe('deferred 单元 — 注册表上限 prune（T11）', () => {
  it('超过 200 条上限时淘汰最旧 terminal 条目，pending 永不裁剪', async () => {
    const { ctx, mediaDir } = makeUnitCtx()
    const lines: string[] = [
      // 最旧条目是 pending：prune 必须跳过它
      JSON.stringify({ chatId: 'private:10001', sessionId: 's-old-pending', state: 'pending', registeredAt: 1, updatedAt: 1, attempts: 0 }),
    ]
    for (let i = 1; i <= DEFERRED_MAX_ENTRIES - 1; i += 1) {
      lines.push(JSON.stringify({ chatId: 'private:10001', sessionId: 's-' + i, state: 'delivered', registeredAt: i + 1, updatedAt: i + 1, attempts: 1, reason: '超时补发已送达' }))
    }
    writeFileSync(join(mediaDir, DEFERRED_REGISTRY_FILE), lines.join('\n') + '\n', 'utf8')
    const scheduler = new FakeScheduler()
    const delivery = new DeferredDelivery(ctx, { now: () => 10_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    await delivery.loadPersisted()
    expect(delivery.snapshot()).toHaveLength(DEFERRED_MAX_ENTRIES) // 恢复 200 条
    // 新登记一条 → 201 → prune 收敛回 200：淘汰 updatedAt 最旧的 terminal（s-1）
    delivery.onTurnStart('private:10001', 's-new')
    scheduler.runNext()
    const ids = delivery.snapshot().map(entry => entry.sessionId)
    expect(delivery.snapshot()).toHaveLength(DEFERRED_MAX_ENTRIES)
    expect(ids).not.toContain('s-1')
    expect(ids).toContain('s-2')
    expect(ids).toContain('s-new')
    expect(ids).toContain('s-old-pending') // pending 永不裁剪
  })
})

describe('deferred 单元 — 计时器与静音语义', () => {
  it('模型输出重置静默窗口（旧计时器取消）；turn/end 解除计时器', () => {
    const scheduler = new FakeScheduler()
    const { ctx } = makeUnitCtx()
    const delivery = new DeferredDelivery(ctx, { now: () => 1_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    delivery.onTurnStart('private:10001', 's-1')
    expect(scheduler.active()).toEqual([{ ms: 1_000 }])
    delivery.onAssistantMessage('private:10001', 's-1', { id: 'm1', content: [{ type: 'text', text: '有输出' }] })
    expect(scheduler.active()).toEqual([{ ms: 1_000 }]) // 重置：仍是单条满窗计时
    const first = scheduler.tasks[0]
    expect(first.cancelled).toBe(true)
    delivery.onTurnEnd('private:10001', 's-1', { kind: 'completed' })
    expect(scheduler.active()).toEqual([]) // 计时解除
  })

  it('超时登记时捕获并清空 loopPending（正常终局路径无内容可重复刷）', () => {
    const scheduler = new FakeScheduler()
    let pending: string | null = '超时前已生成的文字'
    const { ctx } = makeUnitCtx({ takePendingText: () => { const t = pending; pending = null; return t } })
    const delivery = new DeferredDelivery(ctx, { now: () => 1_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    registerUnit(scheduler, delivery)
    expect(delivery.snapshot()[0].resultText).toBe('超时前已生成的文字')
    expect(pending).toBeNull()
  })

  it('回合已不在运行（/stop 后无 turn/end 等情形）：只解除计时、不登记', () => {
    const scheduler = new FakeScheduler()
    const { ctx, mediaDir } = makeUnitCtx({ isTurnRunning: () => false })
    const delivery = new DeferredDelivery(ctx, { now: () => 1_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    delivery.onTurnStart('private:10001', 's-1')
    scheduler.runNext()
    expect(delivery.snapshot()).toHaveLength(0)
    expect(existsSync(join(mediaDir, DEFERRED_REGISTRY_FILE))).toBe(false)
  })

  it('deferredTimeoutMs=0：整体关闭，不计时、不登记', () => {
    const scheduler = new FakeScheduler()
    const { ctx } = makeUnitCtx({ timeoutMs: 0 })
    const delivery = new DeferredDelivery(ctx, { now: () => 1_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    delivery.onTurnStart('private:10001', 's-1')
    expect(scheduler.active()).toEqual([])
    expect(delivery.snapshot()).toHaveLength(0)
  })

  it('/stop（cancelChat）只终止该聊天的 pending 条目，其他聊天不受影响', async () => {
    const scheduler = new FakeScheduler()
    const { ctx, sends, mediaDir } = makeUnitCtx()
    const delivery = new DeferredDelivery(ctx, { now: () => 1_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    registerUnit(scheduler, delivery, 'private:10001', 's-1')
    registerUnit(scheduler, delivery, 'group:888', 's-2')
    delivery.cancelChat('private:10001')
    // 落盘为异步链（登记 save → 终止 save 串行），按文件内容确定性等待
    await vi.waitFor(() => {
      const entries = readRegistry(mediaDir)
      expect(entries.find(entry => entry.sessionId === 's-1')?.state).toBe('cancelled')
      expect(entries.find(entry => entry.sessionId === 's-2')?.state).toBe('pending')
    })
    // 已终止条目在 turn/end 不再兑现（零补发；此前的发送只有两条超时提醒）
    const before = sends.length
    expect(sends).toHaveLength(2)
    delivery.onTurnEnd('private:10001', 's-1', { kind: 'completed' })
    await flush()
    expect(sends).toHaveLength(before)
    expect(sends.some(send => send.text.startsWith(DEFERRED_PREFIX))).toBe(false)
  })
})

describe('deferred 单元 — 注册表持久化纪律（对齐 registry.ts）', () => {
  it('损坏降级：坏行跳过、好行恢复；超龄 pending 自动终止；写盘不炸', async () => {
    const { ctx, mediaDir } = makeUnitCtx()
    const file = join(mediaDir, DEFERRED_REGISTRY_FILE)
    const staleAt = Date.now() - 25 * 60 * 60 * 1000
    writeFileSync(file, [
      '这不是 JSON{{{',
      JSON.stringify({ chatId: 'private:10001', sessionId: 's-live', state: 'pending', registeredAt: Date.now(), updatedAt: Date.now(), attempts: 0 }),
      JSON.stringify({ chatId: 'group:888', sessionId: 's-stale', state: 'pending', registeredAt: staleAt, updatedAt: staleAt, attempts: 0 }),
      JSON.stringify({ chatId: 'private:10001', sessionId: 's-done', state: 'delivered', registeredAt: 1, updatedAt: 2, attempts: 1, reason: '超时补发已送达' }),
      JSON.stringify({ nonsense: true }),
      '',
    ].join('\n'), 'utf8')
    const delivery = new DeferredDelivery(ctx)
    await delivery.loadPersisted()
    const snapshot = delivery.snapshot()
    expect(snapshot).toHaveLength(3)
    const bySession = new Map(snapshot.map(entry => [entry.sessionId, entry]))
    expect(bySession.get('s-live')?.state).toBe('pending')
    expect(bySession.get('s-stale')?.state).toBe('cancelled') // 超 24h 未兑现 → 自动终止
    expect(bySession.get('s-done')?.state).toBe('delivered')
    // 原子重写后文件逐行可解析（坏行被清洗）
    await delivery.save()
    for (const line of readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '')) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it('整文件损坏（非 JSONL）：降级为全新启动，不炸宿主', async () => {
    const { ctx, mediaDir } = makeUnitCtx()
    writeFileSync(join(mediaDir, DEFERRED_REGISTRY_FILE), 'garbage-binary\u0000\u0001not-json', 'utf8')
    const delivery = new DeferredDelivery(ctx)
    await expect(delivery.loadPersisted()).resolves.toBeUndefined()
    expect(delivery.snapshot()).toHaveLength(0)
  })

  it('注册表文件缺失 = 全新启动；正常完成（未超时）零注册表写入', async () => {
    const scheduler = new FakeScheduler()
    const { ctx, sends, mediaDir } = makeUnitCtx()
    const delivery = new DeferredDelivery(ctx, { now: () => 1_000, schedule: scheduler.schedule, cancel: scheduler.cancel })
    await expect(delivery.loadPersisted()).resolves.toBeUndefined()
    // 一整个正常回合：登记计时 → 正常结束
    delivery.onTurnStart('private:10001', 's-1')
    delivery.onAssistantMessage('private:10001', 's-1', { id: 'm1', content: [{ type: 'text', text: '正常答案' }] })
    delivery.onTurnEnd('private:10001', 's-1', { kind: 'completed' })
    await flush()
    expect(existsSync(join(mediaDir, DEFERRED_REGISTRY_FILE))).toBe(false)
    expect(sends).toHaveLength(0) // 零补发（也零超时提醒）
  })
})

// ─────────────────────────────── 集成：bridge 全链路 ───────────────────────────────

describe('deferred 集成 — 超时→登记→完成→补发恰一次', () => {
  it('超时后静音捕获最终文字，turn/end 补发一次；trace/注册表可查；正常路径零重复', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'deferred-it-'))
    const sink = new TraceSink({ dir: mediaDir })
    const h = await makeHarness({ mediaDir, deferredTimeoutMs: 30, trace: sink })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    ;(h.bridge as unknown as { chats: Map<string, { agent: { status: string } }> }).chats.get('private:10001')!.agent.status = 'running'
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/start', { turn: 1 }))

    // 超时：登记 + 超时提醒
    await vi.waitFor(() => expect(readRegistry(mediaDir).some(entry => entry.state === 'pending')).toBe(true))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(text => text.includes('等待模型回复超时'))).toBe(true))
    const pending = readRegistry(mediaDir).find(entry => entry.state === 'pending')!
    expect(pending.chatId).toBe('private:10001')
    expect(pending.sessionId).toBe(h.sessionIds[0])
    expect(pending.traceId).toMatch(/^t-/)

    // 静音：超时后的模型输出不再插播（interim/卡片全不发）
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('assistant/message', {
      turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '超时后的最终答案' }] },
    }))
    expect(sentTexts(h.outbound).some(text => text.includes('超时后的最终答案'))).toBe(false)

    // 完成：补发恰一次（带「（超时补发）」前缀 + 最终文字）
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(text => text.includes('（超时补发）'))).toBe(true))
    const deferredSends = sentTexts(h.outbound).filter(text => text.includes('（超时补发）'))
    expect(deferredSends).toHaveLength(1)
    expect(deferredSends[0]).toContain('超时后的最终答案')

    // 终态落盘 + trace 中文 reason（登记 notice + 补发 queue）
    await vi.waitFor(() => expect(readRegistry(mediaDir)[0]?.state).toBe('delivered'))
    await sink.flush()
    const traceText = readFileSync(join(mediaDir, 'qq-trace.jsonl'), 'utf8')
    expect(traceText).toContain('等待模型回复超时，已登记超时补发跟踪')
    expect(traceText).toContain('超时补发：回合完成，最终结果已补发')

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('重启恢复：注册表 pending 条目在新 bridge 实例恢复跟踪并在回合完成后补发（坏行同时降级跳过）', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'deferred-restart-'))
    const h1 = await makeHarness({ mediaDir, deferredTimeoutMs: 30, resumeOk: true })
    h1.sendText('启动任务')
    await vi.waitFor(() => expect(h1.captured.followups).toHaveLength(1))
    ;(h1.bridge as unknown as { chats: Map<string, { agent: { status: string } }> }).chats.get('private:10001')!.agent.status = 'running'
    const sessionId = h1.sessionIds[0]
    h1.ctx.emit('session/event', { id: sessionId } as never, makeEvent('turn/start', { turn: 1 }))
    await vi.waitFor(() => expect(readRegistry(mediaDir).some(entry => entry.state === 'pending')).toBe(true))

    // 持久化 chat→session 映射（默认 2s 防抖，测试直接强制落盘），注入一行
    // 损坏数据后重启（坏行降级跳过，不影响其余条目恢复）
    await (h1.bridge as unknown as { registry: { saveMapping(): Promise<void> } }).registry.saveMapping()
    h1.client.close()
    await h1.bridge.stop()
    await h1.connection.stop()
    const registryFile = join(mediaDir, DEFERRED_REGISTRY_FILE)
    writeFileSync(registryFile, readFileSync(registryFile, 'utf8') + 'corrupt-line{{{{\n', 'utf8')

    const h2 = await makeHarness({ mediaDir, deferredTimeoutMs: 30, resumeOk: true })
    await (h2.bridge as unknown as { registry: { mappingLoaded: Promise<void> } }).registry.mappingLoaded
    // 恢复跟踪：条目仍 pending；该会话的后续模型输出被静音捕获
    const restored = readRegistry(mediaDir).find(entry => entry.sessionId === sessionId)
    expect(restored?.state).toBe('pending')
    h2.ctx.emit('session/event', { id: sessionId } as never, makeEvent('assistant/message', {
      turn: 1, step: 3, message: { role: 'assistant', content: [{ type: 'text', text: '重启后的最终答案' }] },
    }))
    expect(sentTexts(h2.outbound).some(text => text.includes('重启后的最终答案'))).toBe(false)
    h2.ctx.emit('session/event', { id: sessionId } as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => expect(sentTexts(h2.outbound).some(text => text.includes('（超时补发）'))).toBe(true))
    expect(sentTexts(h2.outbound).filter(text => text.includes('（超时补发）'))).toHaveLength(1)
    expect(sentTexts(h2.outbound).find(text => text.includes('（超时补发）'))).toContain('重启后的最终答案')
    await vi.waitFor(() => expect(readRegistry(mediaDir).find(entry => entry.sessionId === sessionId)?.state).toBe('delivered'))

    h2.client.close()
    await h2.bridge.stop()
    await h2.connection.stop()
  }, 60_000)
})

describe('deferred 集成 — terminal 条目不吞错误通知 / 防双发抑制路径（T11/T12）', () => {
  it('重启恢复 terminal 条目后同会话错误回合：⚠️ 运行出错照常发送（不被抑制）、零补发', async () => {
    // 第一段：超时登记 → 正常完成，条目落盘为 delivered
    const mediaDir = mkdtempSync(join(tmpdir(), 'deferred-restart-terminal-'))
    const h1 = await makeHarness({ mediaDir, deferredTimeoutMs: 30, resumeOk: true })
    h1.sendText('启动任务')
    await vi.waitFor(() => expect(h1.captured.followups).toHaveLength(1))
    ;(h1.bridge as unknown as { chats: Map<string, { agent: { status: string } }> }).chats.get('private:10001')!.agent.status = 'running'
    const sessionId = h1.sessionIds[0]
    h1.ctx.emit('session/event', { id: sessionId } as never, makeEvent('turn/start', { turn: 1 }))
    await vi.waitFor(() => expect(readRegistry(mediaDir).some(entry => entry.sessionId === sessionId && entry.state === 'pending')).toBe(true))
    h1.ctx.emit('session/event', { id: sessionId } as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => expect(readRegistry(mediaDir).find(entry => entry.sessionId === sessionId)?.state).toBe('delivered'))
    h1.client.close()
    await h1.bridge.stop()
    await h1.connection.stop()

    // 第二段：重启（loadPersisted 恢复 terminal 条目）；同会话新回合出错
    // → ⚠️ 运行出错必须照常可见（terminal 条目不再是 tracked），且无补发
    const h2 = await makeHarness({ mediaDir, deferredTimeoutMs: 30, resumeOk: true })
    await (h2.bridge as unknown as { registry: { mappingLoaded: Promise<void> } }).registry.mappingLoaded
    h2.ctx.emit('session/event', { id: sessionId } as never, makeEvent('turn/start', { turn: 2 }))
    h2.ctx.emit('session/event', { id: sessionId } as never, makeEvent('turn/end', { turn: 2, reason: { kind: 'error', error: { message: '重启后的新错误' } } }))
    await vi.waitFor(() => expect(sentTexts(h2.outbound).some(text => text.includes('⚠️ 运行出错：重启后的新错误'))).toBe(true))
    expect(sentTexts(h2.outbound).filter(text => text.includes('（超时补发）'))).toHaveLength(0)

    h2.client.close()
    await h2.bridge.stop()
    await h2.connection.stop()
  }, 60_000)

  it('/stop cancelled 条目的收尾回合出错：⚠️ 运行出错照常发送（不被抑制）、零补发', async () => {
    const h = await makeCmdHarness({ deferredTimeoutMs: 30 })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.chats().get('private:10001')!.agent.status = 'running'
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/start', { turn: 1 }))
    await vi.waitFor(() => expect(readRegistry(h.mediaDir).some(entry => entry.state === 'pending')).toBe(true))
    // /stop：pending 条目转 cancelled
    h.sendText('/stop')
    await vi.waitFor(() => expect(readRegistry(h.mediaDir).find(entry => entry.chatId === 'private:10001')?.state).toBe('cancelled'))
    // 收尾回合出错：cancelled 条目只是快照 → ⚠️ 照常发送、零补发
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'error', error: { message: '停止后收尾出错' } } }))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(text => text.includes('⚠️ 运行出错：停止后收尾出错'))).toBe(true))
    expect(sentTexts(h.outbound).filter(text => text.includes('（超时补发）'))).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('bridge 层防双发：deferred tracked 回合错误终态时 ⚠️ 运行出错被抑制，补发终态通知恰一条', async () => {
    const h = await makeCmdHarness({ deferredTimeoutMs: 30 })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.chats().get('private:10001')!.agent.status = 'running'
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/start', { turn: 1 }))
    await vi.waitFor(() => expect(readRegistry(h.mediaDir).some(entry => entry.state === 'pending')).toBe(true))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'error', error: { message: '任务失败原因' } } }))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(text => text.includes('（超时补发）') && text.includes('任务已结束：运行出错：任务失败原因'))).toBe(true))
    expect(sentTexts(h.outbound).filter(text => text.includes('（超时补发）'))).toHaveLength(1) // 补发恰一条
    expect(sentTexts(h.outbound).some(text => text.includes('⚠️ 运行出错'))).toBe(false) // 常规错误通知被抑制（无双发）

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('退避窗口内新回合错误收尾：⚠️ 照常发送（不被让位路径吞掉）、回合 B 不产生补发、在途回合 A 补发仍恰一次（T12 🔴-3）', async () => {
    const h = await makeCmdHarness({ deferredTimeoutMs: 30 })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.chats().get('private:10001')!.agent.status = 'running'
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/start', { turn: 1 }))
    await vi.waitFor(() => expect(readRegistry(h.mediaDir).some(entry => entry.state === 'pending')).toBe(true))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('assistant/message', {
      turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '回合A的最终答案' }] },
    }))
    // 补发首发明确失败一次（网关拒绝 → retryable → 2s 退避），其后恢复
    const realCall = h.connection.call.bind(h.connection)
    let failedOnce = false
    h.connection.call = (async (action: string, params: unknown) => {
      if (action === 'send_msg' && !failedOnce) {
        failedOnce = true
        throw new OneBotActionError('send_msg failed: retcode 500')
      }
      return realCall(action, params)
    }) as never
    // 回合 A 收尾：补发首发失败 → 进入退避（in-flight）
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    // 退避窗口内回合 B 收尾且出错：让位路径返回 false → bridge 照常发 ⚠️
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/start', { turn: 2 }))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('assistant/message', {
      turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回合B的输出' }] },
    }))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/end', { turn: 2, reason: { kind: 'error', error: { message: '退避窗口内的新错误' } } }))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(text => text.includes('⚠️ 运行出错：退避窗口内的新错误'))).toBe(true), { timeout: 8_000 })
    // 在途循环不受影响：退避到点第 2 次尝试成功，补发恰一次且是回合 A 的文字副本
    await vi.waitFor(() => expect(readRegistry(h.mediaDir)[0]?.state).toBe('delivered'), { timeout: 10_000 })
    const deferredSends = sentTexts(h.outbound).filter(text => text.includes('（超时补发）'))
    expect(deferredSends).toHaveLength(1)
    expect(deferredSends[0]).toContain('回合A的最终答案')
    expect(deferredSends[0]).not.toContain('回合B的输出') // 回合 B 不产生补发条目
    const entries = readRegistry(h.mediaDir)
    expect(entries).toHaveLength(1)
    expect(entries[0].state).toBe('delivered')
    expect(entries[0].attempts).toBe(2)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})

describe('deferred 集成 — /stop 与零差异面', () => {
  it('/stop 终止该聊天补发跟踪，其他聊天条目不受影响并正常兑现', async () => {
    const h = await makeCmdHarness({ deferredTimeoutMs: 30 })
    // 聊天 1（私聊）：超时登记
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.chats().get('private:10001')!.agent.status = 'running'
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/start', { turn: 1 }))
    await vi.waitFor(() => expect(readRegistry(h.mediaDir).some(entry => entry.state === 'pending')).toBe(true))
    // 聊天 2（群聊）：同样超时登记
    h.sendGroupTextAs('启动群任务', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    h.chats().get('group:888')!.agent.status = 'running'
    h.ctx.emit('session/event', { id: h.sessionIds[1] } as never, makeEvent('turn/start', { turn: 1 }))
    await vi.waitFor(() => expect(readRegistry(h.mediaDir).filter(entry => entry.state === 'pending')).toHaveLength(2))

    // /stop：只终止当前聊天（私聊）的提交回合与补发跟踪
    h.sendText('/stop')
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(text => text.includes('已停止生成'))).toBe(true))
    await vi.waitFor(() => {
      const entries = readRegistry(h.mediaDir)
      expect(entries.find(entry => entry.chatId === 'private:10001')?.state).toBe('cancelled')
      expect(entries.find(entry => entry.chatId === 'group:888')?.state).toBe('pending')
    })

    // 私聊 turn/end：零补发；群聊 turn/end：正常补发
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('assistant/message', {
      turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '私聊答案' }] },
    }))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    h.ctx.emit('session/event', { id: h.sessionIds[1] } as never, makeEvent('assistant/message', {
      turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '群聊答案' }] },
    }))
    h.ctx.emit('session/event', { id: h.sessionIds[1] } as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(text => text.includes('群聊答案'))).toBe(true))
    const deferredSends = sentTexts(h.outbound).filter(text => text.includes('（超时补发）'))
    expect(deferredSends).toHaveLength(1)
    expect(deferredSends[0]).toContain('群聊答案')
    expect(deferredSends[0]).not.toContain('私聊答案')

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('正常完成（未超时）：零补发、零注册表写入，最终回复与基线一致', async () => {
    const h = await makeCmdHarness() // 缺省 deferredTimeoutMs = 10 分钟
    h.sendText('普通任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/start', { turn: 1 }))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '正常最终答案' }] },
    }))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(text => text.includes('正常最终答案'))).toBe(true))
    expect(sentTexts(h.outbound).some(text => text.includes('（超时补发）'))).toBe(false)
    expect(sentTexts(h.outbound).some(text => text.includes('等待模型回复超时'))).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 50)) // 留出任何（不应存在的）异步写盘窗口
    expect(existsSync(join(h.mediaDir, DEFERRED_REGISTRY_FILE))).toBe(false)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})
