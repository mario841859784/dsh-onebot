import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { apply, Config, name, defaultMediaDir } from '../src/index.js'

/**
 * T12: capture the deps the plugin entry hands to the ChatBridge constructor
 * so config→bridge wiring (monoFamilies 一行接线) is observable. bridge.js is
 * mocked file-wide; the existing plugin-entry tests never start the bridge, so
 * the no-op lifecycle methods keep them behaving identically.
 */
const bridgeDepsCaptured = vi.hoisted(() => [] as Array<{ config?: { monoFamilies?: readonly string[] } }>)
/** Issue #37: start/stop call counters so the failure-rollback is observable. */
const bridgeLifecycle = vi.hoisted(() => ({ startCalls: 0, stopCalls: 0 }))
vi.mock('../src/bridge.js', () => ({
  ChatBridge: class {
    constructor(deps: { config?: { monoFamilies?: readonly string[] } }) {
      bridgeDepsCaptured.push(deps)
    }
    start(): void {
      bridgeLifecycle.startCalls++
    }
    async stop(): Promise<void> {
      bridgeLifecycle.stopCalls++
    }
  },
}))

/**
 * T3 lifecycle regression: mock InjectChannel so start() can be suspended on
 * a gate, letting the test unload the plugin while start is still in flight.
 * startCompleted mirrors the real channel's invariant that arming the poll
 * timer happens only after the awaited history skip (inject.ts start()).
 * 闸门只在用例显式置 holdStart 时挂起（T3/T2-board 持闸），其余显式开启
 * injectEnabled 的用例 start() 直接完成，不会被无人释放的闸门拖到超时。
 * constructed 记构造次数：默认配置下通道不该被构造。
 */
const injectLifecycle = vi.hoisted(() => ({
  constructed: 0,
  startCalls: 0,
  stopCalls: 0,
  startCompleted: false,
  stopAfterStartCompleted: false,
  holdStart: false,
  releaseStart: null as null | (() => void),
}))
vi.mock('../src/inject.js', () => ({
  InjectChannel: class {
    constructor() {
      injectLifecycle.constructed++
    }
    async start(): Promise<void> {
      injectLifecycle.startCalls++
      injectLifecycle.startCompleted = false
      if (injectLifecycle.holdStart) {
        await new Promise<void>(resolve => {
          injectLifecycle.releaseStart = resolve
        })
      }
      injectLifecycle.startCompleted = true
    }
    async stop(): Promise<void> {
      injectLifecycle.stopCalls++
      injectLifecycle.stopAfterStartCompleted = injectLifecycle.startCompleted
    }
  },
}))

/** A stubbed cordis service registry carrying the injected surface. */
function makeCtx() {
  const ctx = new Context()
  const tools: Array<{ name: string }> = []
  const sections: Array<{ name: string; order?: number; text?: string }> = []
  const followups: Array<{ text: string }> = []
  const sessionIds: string[] = []
  ctx.provide('tools' as never, {
    register: (tool: { name: string }) => {
      tools.push(tool)
      return () => {
        const idx = tools.indexOf(tool)
        if (idx >= 0) tools.splice(idx, 1)
      }
    },
  } as never)
  ctx.provide('systemPrompt' as never, {
    section: (section: { name: string; order?: number; text?: string }) => {
      sections.push(section)
      return () => {
        const idx = sections.indexOf(section)
        if (idx >= 0) sections.splice(idx, 1)
      }
    },
  } as never)
  ctx.provide('agents' as never, {
    create: async (options: { sessionId: string }) => {
      sessionIds.push(String(options.sessionId))
      return {
        agent: {
          session: { id: String(options.sessionId) },
          followup: (message: { content: Array<{ type: string; text?: string }> }) => {
            followups.push({ text: message.content.map(b => b.text ?? '').join('') })
          },
          whenIdle: async () => undefined,
        },
        dispose: async () => undefined,
      }
    },
    resume: async () => { throw new Error('no persistence') },
  } as never)
  ctx.provide('sessions' as never, {
    flush: async () => undefined,
  } as never)
  ctx.provide('agentDefaultModel' as never, {
    currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
  } as never)
  return { ctx, tools, sections, followups, sessionIds }
}

describe('plugin entry', () => {
  it('validates config defaults', () => {
    const config = Config({})
    expect(config.mode).toBe('forward') // T5 翻转：连接模式默认 forward（原 reverse）
    expect(config.port).toBe(8643)
    expect(config.requireMention).toBe(true)
    expect(config.unknownCommand).toBe('intercept')
    expect(config.sttModel).toBe('small')
  })

  it('applies, registers tools and prompt, then unwinds on disposal', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-plugin-'))
    const { ctx, tools, sections } = makeCtx()
    const config = Config({
      mediaDir,
      port: 0,
      // T5 后 mode 默认 forward 会真发起出站连接；本用例只测注册/卸载生命周期，
      // 显式钉回 reverse（port 0 不监听）保持离线确定性。
      mode: 'reverse',
      accessToken: 'test-token',
      botQQ: '10002',
      sttEnabled: false,
      sensitivePatterns: [],
    })
    // apply() registers its lifecycle via ctx.effect; capture the disposer.
    const effectSpy = vi.spyOn(ctx as { effect: (cb: () => unknown, label?: string) => unknown }, 'effect')
    apply(ctx as never, config)

    // New design (§3.24): channel tools and the platform section register per
    // agent scope (installChannelScope in bridge.ts); the plugin scope stays
    // clean so Web/local sessions never see the QQ channel surface.
    expect(tools).toHaveLength(0)
    expect(sections.some(s => s.name === 'channel:dsh-onebot')).toBe(false)

    // Teardown: run the plugin's effect disposer (stops bridge + connection).
    expect(effectSpy).toHaveBeenCalled()
    const disposer = effectSpy.mock.results[0].value as () => Promise<void>
    await disposer()
  })

  it('不写 injectEnabled 时不建注入通道：启动链走完，InjectChannel 不构造、不启动', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-plugin-'))
    const { ctx } = makeCtx()
    injectLifecycle.constructed = 0
    injectLifecycle.startCalls = 0
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const effectSpy = vi.spyOn(ctx as { effect: (cb: () => unknown, label?: string) => unknown }, 'effect')
      apply(ctx as never, Config({
        mediaDir,
        port: 0,
        mode: 'reverse',
        accessToken: 'test-token',
        botQQ: '10002',
        sttEnabled: false,
        sensitivePatterns: [],
      }))
      const texts = () => log.mock.calls.map(c => String(c[0]))
      await vi.waitFor(() => expect(texts().some(t => t.startsWith('[dsh-onebot] mounted (mode='))).toBe(true))
      expect(injectLifecycle.constructed).toBe(0)
      expect(injectLifecycle.startCalls).toBe(0)
      const disposer = effectSpy.mock.results[0].value as () => Promise<void>
      await disposer()
    } finally {
      log.mockRestore()
    }
  })

  it('warns once at mount when workspacePath is unset; silent when configured (T3 方案 B)', () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-plugin-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      // Unset (schema default ''): exactly one mount-time warn naming the cwd.
      const unset = makeCtx()
      apply(unset.ctx as never, Config({ mediaDir, port: 0, accessToken: 'test-token', botQQ: '10002', sttEnabled: false, sensitivePatterns: [] }))
      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0]?.[0])
      expect(line).toContain('未配置 workspacePath')
      expect(line).toContain(process.cwd())

      // Configured: no warn.
      warn.mockClear()
      const set = makeCtx()
      apply(set.ctx as never, Config({ mediaDir, port: 0, accessToken: 'test-token', botQQ: '10002', sttEnabled: false, sensitivePatterns: [], workspacePath: mediaDir }))
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('logs and unwinds the started chain when the start effect fails (#37)', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-plugin-'))
    const { ctx } = makeCtx()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    bridgeLifecycle.startCalls = 0
    bridgeLifecycle.stopCalls = 0
    try {
      const effectSpy = vi.spyOn(ctx as { effect: (cb: () => unknown, label?: string) => unknown }, 'effect')
      // Reverse mode (T5 前默认) + 空 accessToken 使 connection.start() 在
      // async effect 内同步抛错；T5 默认翻转为 forward 后显式钉回该失败路径。
      apply(ctx as never, Config({ mediaDir, port: 0, mode: 'reverse', accessToken: '', botQQ: '10002', sttEnabled: false, sensitivePatterns: [] }))
      const effect = effectSpy.mock.results[0]?.value as { then: (onFulfilled?: unknown, onRejected?: (error: unknown) => unknown) => unknown }
      await expect(new Promise((resolve, reject) => {
        effect.then(resolve, reject)
      })).rejects.toThrow('reverse mode requires a non-empty accessToken')
      // The failure is surfaced through the plugin log, not swallowed.
      const errorLine = errorSpy.mock.calls.map(call => String(call[0])).join('\n')
      expect(errorLine).toContain('dsh-onebot 启动失败')
      expect(errorLine).toContain('reverse mode requires a non-empty accessToken')
      // The already-started bridge was rolled back.
      expect(bridgeLifecycle.startCalls).toBe(1)
      expect(bridgeLifecycle.stopCalls).toBe(1)
      // And the plugin never claims to be mounted.
      expect(logSpy.mock.calls.some(call => String(call[0]).includes('mounted'))).toBe(false)
    } finally {
      errorSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  it('derives a sensible default media dir', () => {
    const dir = defaultMediaDir()
    expect(dir).toContain('.dsh')
  })

  it('forwards config.monoFamilies into the bridge constructor (T12 端到端接线收尾)', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-plugin-'))
    const { ctx } = makeCtx()
    bridgeDepsCaptured.length = 0
    apply(ctx as never, Config({
      mediaDir,
      port: 0,
      accessToken: 'test-token',
      botQQ: '10002',
      sttEnabled: false,
      sensitivePatterns: [],
      monoFamilies: ['Cascadia Code', 'Consolas'],
    }))
    expect(bridgeDepsCaptured).toHaveLength(1)
    expect(bridgeDepsCaptured[0]?.config?.monoFamilies).toEqual(['Cascadia Code', 'Consolas'])
  })

  it('T3 lifecycle: unload while injectChannel.start() is still pending waits for start, then unwinds exactly once', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-plugin-'))
    const { ctx } = makeCtx()
    injectLifecycle.startCalls = 0
    injectLifecycle.stopCalls = 0
    injectLifecycle.startCompleted = false
    injectLifecycle.stopAfterStartCompleted = false
    injectLifecycle.holdStart = true
    const effectSpy = vi.spyOn(ctx as { effect: (cb: () => unknown, label?: string) => unknown }, 'effect')
    apply(ctx as never, Config({
      mediaDir,
      port: 0,
      accessToken: 'test-token',
      botQQ: '10002',
      sttEnabled: false,
      sensitivePatterns: [],
      injectEnabled: true,
    }))

    // start 链已启动但被闸门挂起：start 调用过恰一次、尚未完成
    // （effect 回调由宿主调度执行，用 waitFor 等到 start 已进入闸门）
    await vi.waitFor(() => expect(injectLifecycle.startCalls).toBe(1))
    expect(injectLifecycle.startCompleted).toBe(false)
    const disposer = effectSpy.mock.results[0].value as () => Promise<void>
    const disposed = disposer()
    // 放行全部微任务/宏任务：修复前 stop 会在此处穿插进未完成的 start
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(injectLifecycle.stopCalls).toBe(0)

    // 放行 start：清理必须在 start 完成后展开，且恰一次（无重复注入、无悬挂 timer/监听）
    injectLifecycle.releaseStart?.()
    await disposed
    expect(injectLifecycle.startCalls).toBe(1)
    expect(injectLifecycle.stopCalls).toBe(1)
    expect(injectLifecycle.stopAfterStartCompleted).toBe(true)
  })

  it('T2-board: two-phase lifecycle log — mounted prints only after the start chain settles', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-plugin-'))
    const { ctx } = makeCtx()
    injectLifecycle.startCalls = 0
    injectLifecycle.startCompleted = false
    injectLifecycle.holdStart = true
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const effectSpy = vi.spyOn(ctx as { effect: (cb: () => unknown, label?: string) => unknown }, 'effect')
      apply(ctx as never, Config({
        mediaDir,
        port: 0,
        accessToken: 'test-token',
        botQQ: '10002',
        sttEnabled: false,
        sensitivePatterns: [],
        injectEnabled: true,
      }))
      const texts = () => log.mock.calls.map(c => String(c[0]))
      // start 链已进入闸门：starting 已打印，mounted 尚未打印（旧实现此间就打印 mounted）。
      await vi.waitFor(() => expect(injectLifecycle.startCalls).toBe(1))
      expect(texts().some(t => t.startsWith('[dsh-onebot] starting (mode='))).toBe(true)
      expect(texts().some(t => t.startsWith('[dsh-onebot] mounted'))).toBe(false)
      // 放行 start：mounted 在整条链完成后才出现。
      injectLifecycle.releaseStart?.()
      await vi.waitFor(() => expect(texts().some(t => t.startsWith('[dsh-onebot] mounted (mode='))).toBe(true))
      const disposer = effectSpy.mock.results[0].value as () => Promise<void>
      await disposer()
    } finally {
      injectLifecycle.holdStart = false
      log.mockRestore()
    }
  })
})
