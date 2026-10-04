/**
 * Event injection channel (W1/T5): a DEBUG-ONLY channel — disabled by
 * default on every layer. When injectEnabled is turned on the bridge polls
 * mediaDir/qq-inject.jsonl every injectIntervalMs (min 500) and feeds each
 * new line into the REAL inbound pipeline (whitelist → @ gate → commands →
 * media → dispatch, the whole path), reusing the traceId anchor so injected
 * rounds are attributed with stage=inject trace events. Lines that already
 * existed at startup are skipped and reported (one trace event + log line —
 * never silently).
 *
 * dry-run (injectDryRun, default TRUE): every outbound WRITE action
 * (send_* / set_* / delete_msg) triggered by an injected round — including
 * the asynchronous agent turn's final reply, which is intercepted at the
 * outbound action layer via the chat→round association — is counted and
 * recorded into the trace stream with the original text, and never reaches
 * the real OneBot connection. The interception resolves with a marker
 * message id (INTERCEPTED_MESSAGE_ID) so the pipeline proceeds without
 * error cascades; recalls of intercepted sends are intercepted too (they can
 * be recognized by the marker id). A real message dispatched to the same
 * chat clears the injected round association immediately (never collaterally
 * intercepting real users' replies).
 *
 * MIT attribution: the poll-interval + dry-run-by-default semantics, the
 * historical-line skip rule and the "injected rounds' async replies are
 * intercepted too" lesson are aligned with dsh-qq-onebot-bridge (MIT
 * License, Copyright (c) 2026 dsh-qq-onebot-bridge contributors, CHANGELOG
 * v0.4.0 阶段 3（含注入安全边界条目）); the ALS round propagation, the
 * traceId-matching guard and the marker-id recall rule are original to this
 * plugin. The full borrowed-item list lives in DEVLOG.md (2026-10-04).
 * @module dsh-onebot/inject
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { OneBotEvent } from './connection.js'
import type { ChatId } from './chat.js'
import { newTraceId } from './trace.js'
import type { TraceSink } from './trace.js'

/** Inject queue file name, polled under the media dir. */
export const INJECT_FILE = 'qq-inject.jsonl'
/** message id returned for intercepted sends; recalls of such sends carry
 * this marker and are intercepted on sight (a real OneBot id is never negative). */
export const INTERCEPTED_MESSAGE_ID = -1
/** Poll interval floor (ms). */
export const MIN_INJECT_INTERVAL_MS = 500
/** Warn dedup window for read failures. */
export const INJECT_WARN_WINDOW_MS = 5 * 60_000

/** One injected round: minted per consumed line, shared with the whole
 * round's async chain so every interception is attributable. */
export interface InjectRound {
  traceId: string
  intercepted: number
}

const roundStorage = new AsyncLocalStorage<InjectRound>()

/** Run `fn` inside an injected round (the bridge wraps injected handleInbound calls). */
export function runInjectRound<T>(round: InjectRound, fn: () => T): T {
  return roundStorage.run(round, fn)
}

/** The active injected round inside the current async chain, if any. */
export function currentInjectRound(): InjectRound | undefined {
  return roundStorage.getStore()
}

/** Whether one OneBot action mutates remote state (the dry-run intercept class). */
export function isWriteAction(action: string): boolean {
  return action.startsWith('send_') || action.startsWith('set_') || action === 'delete_msg'
}

/** Extract the human-readable original text of an outbound action payload
 * (text segments joined; used for the trace event's original copy). */
export function outboundTextOf(params: Record<string, unknown>): string {
  const message = params.message
  if (typeof message === 'string') return message.slice(0, 500)
  if (Array.isArray(message)) {
    return message
      .map(seg => {
        const s = seg as { type?: string; data?: { text?: unknown } }
        return s?.type === 'text' ? String(s.data?.text ?? '') : ''
      })
      .join('')
      .slice(0, 500)
  }
  return ''
}

export interface InjectChannelOptions {
  /** Directory the inject file lives in (the plugin media dir). */
  dir: string
  /** Intercept all outbound writes of injected rounds (default true). */
  dryRun: boolean
  /** Poll interval in ms (floored at MIN_INJECT_INTERVAL_MS). */
  intervalMs: number
  /** Feed one consumed event into the real inbound pipeline. */
  handleEvent(event: OneBotEvent): Promise<void>
  /** Optional trace sink (stage=inject events); absent → log only. */
  trace?: TraceSink | undefined
  /** Log port. */
  log(level: 'info' | 'warn', message: string): void
}

/**
 * The injection channel. Constructed only when injectEnabled is on; start()
 * skips historical lines (reporting the count), then polls for new complete
 * lines. Read/parse failures degrade to rate-limited warns — never thrown.
 */
export class InjectChannel {
  private readonly dryRun: boolean
  /** The effective poll interval (floored at MIN_INJECT_INTERVAL_MS). */
  readonly intervalMs: number
  private readonly opts: InjectChannelOptions
  /** chatId → the unsettled injected round (async-reply guard); cleared by a
   * real dispatch to the same chat (never collaterally intercepting real users). */
  private readonly activeRounds = new Map<ChatId, InjectRound>()
  private timer: ReturnType<typeof setInterval> | undefined
  private consumedBytes = 0
  private lastWarnAt = 0
  private stopped = false
  private readonly stats = { consumed: 0, skippedHistory: 0, intercepted: 0, parseErrors: 0, readFailures: 0 }

  constructor(options: InjectChannelOptions) {
    this.opts = options
    this.dryRun = options.dryRun !== false
    this.intervalMs = Math.max(MIN_INJECT_INTERVAL_MS, options.intervalMs)
  }

  /** Whether this channel intercepts outbound writes (dry-run mode). */
  get intercepting(): boolean {
    return this.dryRun
  }

  /** Skip the lines that already existed at startup (recorded + reported),
   * then start polling. */
  start(): void {
    void this.skipHistory()
    this.stopped = false
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.activeRounds.clear()
  }

  private async skipHistory(): Promise<void> {
    let text: string
    try {
      text = await readFile(join(this.opts.dir, INJECT_FILE), 'utf8')
    } catch {
      return // no queue file yet: nothing to skip
    }
    const complete = text.slice(0, completePrefix(text))
    const lines = complete.split('\n').map(l => l.trim()).filter(l => l !== '')
    this.consumedBytes = complete.length
    if (lines.length === 0) return
    this.stats.skippedHistory = lines.length
    const reason = '注入通道启动：已跳过历史行 ' + lines.length + ' 条（只消费启动之后追加的行）'
    this.emitInjectEvent(reason, { skipped: lines.length })
    this.opts.log('info', reason)
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    let text: string
    try {
      text = await readFile(join(this.opts.dir, INJECT_FILE), 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return
      this.stats.readFailures += 1
      this.warnOnce('注入队列读取失败（5 分钟内不再重复告警）: ' + (error instanceof Error ? error.message : String(error)))
      return
    }
    // A replaced/truncated (rotated or cleared) file restarts from the top.
    if (text.length < this.consumedBytes) this.consumedBytes = 0
    const fresh = text.slice(this.consumedBytes)
    const nl = fresh.lastIndexOf('\n')
    if (nl === -1) return // only a partial line so far
    const complete = fresh.slice(0, nl + 1)
    this.consumedBytes += complete.length
    for (const line of complete.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let event: OneBotEvent
      try {
        event = JSON.parse(trimmed) as OneBotEvent
      } catch {
        this.stats.parseErrors += 1
        this.warnOnce('注入行解析失败，已跳过（5 分钟内不再重复告警）: ' + trimmed.slice(0, 120))
        continue
      }
      await this.consume(event)
    }
  }

  /** Feed one consumed event through the real pipeline inside its round. */
  async consume(event: OneBotEvent): Promise<void> {
    const round: InjectRound = { traceId: newTraceId(), intercepted: 0 }
    this.stats.consumed += 1
    this.emitInjectEvent('注入事件已进入真实管线', { dryRun: this.dryRun }, round.traceId)
    try {
      await this.opts.handleEvent(event)
    } catch (error) {
      this.opts.log('warn', '注入事件处理失败: ' + (error instanceof Error ? error.message : String(error)))
    }
    if (this.dryRun && round.intercepted > 0) {
      this.emitInjectEvent('注入 dry-run：' + round.intercepted + ' 个出站调用已拦截（未发送 QQ）', { intercepted: round.intercepted }, round.traceId)
    }
  }

  /** Bridge hook: register the current ALS round for a chat at dispatch time
   * so the async agent reply is attributable; a real dispatch clears the
   * chat's injected round instead. */
  noteDispatch(chatId: ChatId): void {
    const round = currentInjectRound()
    if (round !== undefined) this.activeRounds.set(chatId, round)
    else this.activeRounds.delete(chatId)
  }

  /** The chat's unsettled injected round, if any. */
  activeRoundFor(chatId: ChatId): InjectRound | undefined {
    return this.activeRounds.get(chatId)
  }

  /** Forget a chat's round (chat removed / stop). */
  clearChat(chatId: ChatId): void {
    this.activeRounds.delete(chatId)
  }

  /**
   * Intercept one outbound write of an injected round (the outbound action
   * layer): count it, record the original text into the trace stream and
   * resolve with a marker message id so the pipeline proceeds error-free.
   */
  intercept(round: InjectRound | undefined, action: string, params: Record<string, unknown>): Promise<unknown> {
    this.stats.intercepted += 1
    if (round !== undefined) round.intercepted += 1
    this.emitInjectEvent(
      '注入 dry-run：出站调用已拦截（未发送）：' + action,
      { action, intercepted: true, text: outboundTextOf(params) },
      round?.traceId,
    )
    return Promise.resolve({ status: 'dry-run', retcode: 0, data: { message_id: INTERCEPTED_MESSAGE_ID } })
  }

  /** Counters for tests / diagnostics. */
  getStats(): { consumed: number; skippedHistory: number; intercepted: number; parseErrors: number; readFailures: number } {
    return { ...this.stats }
  }

  private emitInjectEvent(reason: string, data: Record<string, unknown>, traceId?: string): void {
    const sink = this.opts.trace
    if (sink === undefined || !sink.enabled) return
    sink.emit({ traceId: traceId ?? newTraceId(sink.now()), stage: 'inject', ok: true, reason, data })
  }

  private warnOnce(message: string): void {
    const now = Date.now()
    if (now - this.lastWarnAt < INJECT_WARN_WINDOW_MS) return
    this.lastWarnAt = now
    this.opts.log('warn', message)
  }
}

/** The byte length of the complete (newline-terminated) prefix of `text`. */
function completePrefix(text: string): number {
  const nl = text.lastIndexOf('\n')
  return nl === -1 ? 0 : nl + 1
}
