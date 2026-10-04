/**
 * Trace infrastructure (W1/T4 core observability): per-message traceId +
 * decision-event JSONL sink. Every inbound message gets a traceId; decision
 * points — including every previously silent drop — append one event carrying
 * stage / ok / reason (non-empty Chinese for drops) / chatId / messageId /
 * ms / data. Events are queued in memory and drained by a single async writer
 * to mediaDir/qq-trace.jsonl (append, never awaited by the pipeline), rotated
 * by rename at a size cap with the previous files kept, with same-cause
 * reasons rate-limited to one line per 5 minutes so repetitive drops cannot
 * flood the file.
 *
 * MIT attribution: portions of this file are adapted from
 * dsh-qq-onebot-bridge lib/trace.js (MIT License, Copyright (c) 2026
 * dsh-qq-onebot-bridge contributors): the short sortable traceId form, the
 * 4MiB size cap, the same-cause 5-minute rate limit, the serialization guard
 * (jsonlSafe) and the "silent drops become visible" principle (ok=false plus
 * a non-empty reason). The full borrowed-item list lives in DEVLOG.md
 * (2026-10-04). Everything else — the async queued writer, rename rotation,
 * the reason/stage constant tables and the AsyncLocalStorage propagation —
 * is original to this plugin.
 *
 * Default OFF (traceEnabled=false): the sink is not constructed, no traceId
 * is generated, no file is written and pipeline behavior is byte-identical
 * to 0.6.0.
 * @module dsh-onebot/trace
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Trace jsonl file name, appended under the media dir. */
export const TRACE_FILE = 'qq-trace.jsonl'
/** Rotated file name for one generation (1 → qq-trace.1.jsonl). */
export function traceRotatedFile(generation: number): string {
  return 'qq-trace.' + generation + '.jsonl'
}
/** Size cap per trace file; at the cap the file is renamed aside (rotation). */
export const TRACE_MAX_BYTES = 4 * 1024 * 1024
/** How many rotated files are kept (qq-trace.1.jsonl, qq-trace.2.jsonl). */
export const TRACE_KEEP_ROTATED = 2
/** Max events buffered in the async write queue; beyond it the oldest is dropped. */
export const TRACE_MAX_QUEUE = 1000
/** Same-cause (stage + reason) rate-limit window in ms. */
export const TRACE_SAME_CAUSE_WINDOW_MS = 5 * 60_000
/** Max tracked same-cause keys (LRU-evicted beyond this). */
export const TRACE_MAX_CAUSE_KEYS = 512
/** Max reason length carried by one event (competitor-aligned). */
export const REASON_MAX_LENGTH = 300
/** Write-failure warn dedup window (same 5-minute discipline). */
export const TRACE_WRITE_WARN_WINDOW_MS = 5 * 60_000

/** Stage vocabulary (pipeline-hooks.md §4: competitor table trimmed + this
 * plugin's own branches; `dedup` covers the W2-② window). */
export const TRACE_STAGES = {
  inbound: '收到消息',
  normalize: '消息归一化',
  self: '自身消息过滤',
  whitelist: '白名单',
  mention: '群聊 @ 门',
  dedup: '重复投递',
  command: '命令',
  media: '媒体处理',
  quote: '引用解析',
  forward: '合并转发',
  transcribe: '语音转文字',
  ratelimit: '入站限流',
  dispatch: '交给模型',
  agent: '模型回合',
  outbound: '出站发送',
  queue: '离线队列',
  interim: '中间消息',
  notice: '通知',
  inject: '事件注入',
  replay: '离线回放',
} as const
export type TraceStage = keyof typeof TRACE_STAGES

/** Central Chinese reason table (pipeline-hooks.md §6: maintained in one
 * place so tests can enumerate every reason exhaustively). Reasons with
 * dynamic detail (error text, ids) are composed at the call sites and reuse
 * these as prefixes. */
export const TRACE_REASONS = {
  inboundStopping: '插件停止中，消息丢弃',
  inboundNotChat: '非聊天消息事件，不处理',
  inboundSelf: '机器人自己的消息已忽略',
  inboundDmBlocked: '私聊用户不在允许名单，已忽略',
  inboundGroupBlocked: '群聊不在允许名单，已忽略',
  inboundUnmentioned: '群聊未 @ 机器人，已忽略',
  inboundCommand: '消息已由命令处理',
  inboundDedup: '消息在去重窗口内重复投递，已跳过',
  inboundRateLimited: '消息频率超限，已丢弃',
  inboundRateNoticeFailed: '限流提示发送失败',
  inboundEmptyContent: '消息展开后无有效文本内容，已丢弃',
  mediaResolveFailed: '媒体解析失败，占位符保留原文',
  nasFileTooLarge: 'QQ 文件超过大小上限，已跳过获取',
  nasFileFailed: 'QQ 文件获取失败：无可用来源',
  sttEmpty: '语音转写结果为空',
  transcriptNoChat: '语音转写结果无处投递',
  outboundQueued: '连接断开，回复已排队等待重连补发',
  outboundNotConnected: '连接断开，发送失败',
  queueFull: '离线回复队列已满，丢弃最旧一条',
  queueTtlExpired: '排队回复超过 5 分钟未送达，已丢弃',
  outboundSensitive: '出站内容命中敏感词审计',
  outboundCardTooLarge: '文字图卡片超过大小上限，已降级为文本',
  outboundEmptyText: '正文为空，未发送',
  noticeErrorSendFailed: '错误通知发送失败',
} as const

let traceCounter = 0

/** Short, sortable trace id (`t-<base36 seconds>-<n>`); form aligned with the
 * MIT competitor (trace.js:44-47). */
export function newTraceId(now: number = Date.now()): string {
  traceCounter = (traceCounter + 1) % 0xffffff
  return 't-' + Math.floor(now / 1000).toString(36) + '-' + traceCounter.toString(36)
}

/** One event as appended to the jsonl file. */
export interface TraceEvent {
  v: 1
  ts: number
  traceId: string
  stage: TraceStage
  ok: boolean
  reason?: string
  chatId?: string
  messageId?: string
  ms?: number
  data?: Record<string, unknown>
}

/** The per-message handle the sink hands out: emit() fills the correlation
 * fields (traceId/chatId/messageId) so call sites only name the decision. */
export interface TraceScope {
  readonly traceId: string
  readonly chatId: string
  readonly messageId: string | undefined
  emit(stage: TraceStage, opts?: { ok?: boolean; reason?: string; ms?: number; data?: Record<string, unknown> }): void
}

/** AsyncLocalStorage propagation (pipeline-hooks.md §5 option 1): the whole
 * inbound pipeline runs inside one scope, so decision points read the trace
 * without threading a parameter through every signature. Outbound/session
 * events use the bridge's chat-level association table instead (different
 * async chain). */
const traceStorage = new AsyncLocalStorage<TraceScope | undefined>()

/** Run `fn` inside a trace scope; with no scope (disabled) this is a plain call. */
export function runWithTrace<T>(scope: TraceScope | undefined, fn: () => T): T {
  return scope === undefined ? fn() : traceStorage.run(scope, fn)
}

/** The active trace scope, or undefined outside one / when tracing is off. */
export function currentTrace(): TraceScope | undefined {
  return traceStorage.getStore()
}

export interface TraceSinkOptions {
  /** Directory the jsonl file lives in (the plugin media dir). */
  dir?: string
  /** Master switch; false = emit() is a no-op and no file is ever created. */
  enabled?: boolean
  /** 'debug' records every event; 'warn' records only ok:false events. */
  level?: 'debug' | 'warn'
  /** Rotation size cap (tests shrink it; default 4MiB). */
  maxBytes?: number
  /** Async queue capacity (tests shrink it; default 1000). */
  maxQueue?: number
  /** Rotated files kept (tests may use fewer). */
  keepRotated?: number
  /** Clock override (tests). */
  now?: () => number
  /** Warn port for write failures. */
  log?: (level: 'warn', message: string) => void
}

/** Same-cause limiter entry: the key's last written timestamp and the count
 * of suppressed repeats kept in memory (the real frequency stays observable
 * via stats() even though only one line per window reaches the file). */
interface CauseEntry {
  lastAt: number
  count: number
}

/**
 * The trace sink: async queued JSONL appends with size-cap rename rotation,
 * same-cause 5-minute rate limiting and a level filter. The pipeline only
 * ever calls emit(), which enqueues synchronously (microsecond-scale) and
 * never awaits disk — a burst cannot block message handling, and a full
 * queue drops the oldest events (counted, never thrown).
 */
export class TraceSink {
  readonly enabled: boolean
  private readonly level: 'debug' | 'warn'
  private readonly dir: string
  private readonly maxBytes: number
  private readonly maxQueue: number
  private readonly keepRotated: number
  /** Clock override (tests); shared with scope creators for id minting. */
  private readonly nowFn: () => number
  private readonly log: (level: 'warn', message: string) => void
  private readonly queue: TraceEvent[] = []
  private readonly causes = new Map<string, CauseEntry>()
  /** Serialized writer chain: flushes never interleave appends. */
  private writeChain: Promise<void> = Promise.resolve()
  private dirEnsured = false
  private lastWriteWarnAt = 0
  private readonly stats = { written: 0, dropped: 0, suppressed: 0, writeFailures: 0, rotated: 0 }

  constructor(options: TraceSinkOptions = {}) {
    this.enabled = options.enabled !== false
    this.level = options.level === 'warn' ? 'warn' : 'debug'
    this.dir = options.dir ?? ''
    this.maxBytes = options.maxBytes ?? TRACE_MAX_BYTES
    this.maxQueue = options.maxQueue ?? TRACE_MAX_QUEUE
    this.keepRotated = Math.max(1, options.keepRotated ?? TRACE_KEEP_ROTATED)
    this.nowFn = options.now ?? Date.now
    this.log = options.log ?? (() => undefined)
  }

  /** The sink's clock (id minting at call sites reads the same clock). */
  now(): number {
    return this.nowFn()
  }

  /** Build the per-message scope handle. */
  scope(traceId: string, chatId: string, messageId?: string): TraceScope {
    const sink = this
    return {
      traceId,
      chatId,
      messageId,
      emit(stage, opts = {}) {
        sink.emit({ traceId, chatId, messageId, stage, ...opts })
      },
    }
  }

  /**
   * Record one decision event. Synchronous queue push; disk writes happen on
   * the serialized writer chain. Returns the event when it was enqueued,
   * null when it was filtered (disabled / level / same-cause window).
   */
  emit(input: {
    traceId: string
    stage: TraceStage
    ok?: boolean
    reason?: string
    chatId?: string
    messageId?: string
    ms?: number
    data?: Record<string, unknown>
  }): TraceEvent | null {
    if (!this.enabled) return null
    const ok = input.ok !== false
    if (this.level === 'warn' && ok) return null
    const event: TraceEvent = {
      v: 1,
      ts: this.nowFn(),
      traceId: input.traceId,
      stage: input.stage,
      ok,
    }
    if (input.reason !== undefined && input.reason !== '') event.reason = input.reason.slice(0, REASON_MAX_LENGTH)
    if (input.chatId !== undefined && input.chatId !== '') event.chatId = input.chatId
    if (input.messageId !== undefined && input.messageId !== '') event.messageId = input.messageId
    if (input.ms !== undefined && Number.isFinite(input.ms)) event.ms = Math.max(0, Math.round(input.ms))
    if (input.data !== undefined) event.data = serializableData(input.data)
    // Same-cause 5-minute rate limit (competitor lesson, pipeline-hooks.md §4):
    // identical stage+reason repeats collapse to one line per window.
    if (event.reason !== undefined) {
      const key = event.stage + '\u0000' + event.reason
      const seen = this.causes.get(key)
      if (seen !== undefined && event.ts - seen.lastAt < TRACE_SAME_CAUSE_WINDOW_MS) {
        seen.count += 1
        this.stats.suppressed += 1
        return null
      }
      if (seen === undefined) {
        while (this.causes.size >= TRACE_MAX_CAUSE_KEYS) {
          const oldest = this.causes.keys().next().value
          if (oldest === undefined) break
          this.causes.delete(oldest)
        }
      }
      this.causes.set(key, { lastAt: event.ts, count: 1 })
    }
    this.queue.push(event)
    if (this.queue.length > this.maxQueue) {
      this.queue.shift()
      this.stats.dropped += 1
    }
    void this.flush()
    return event
  }

  /** Drain the queue to disk; safe to call concurrently (the writer chain
   * serializes) and cheap when the queue is empty. */
  flush(): Promise<void> {
    const run = this.writeChain.then(() => this.drain())
    this.writeChain = run.catch(() => undefined)
    return run
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const events = this.queue.splice(0, this.queue.length)
      const text = events.map(event => jsonlSafe(event) + '\n').join('')
      try {
        if (this.dir === '') {
          this.stats.written += events.length
          continue
        }
        if (!this.dirEnsured) {
          await mkdir(this.dir, { recursive: true })
          this.dirEnsured = true
        }
        const file = join(this.dir, TRACE_FILE)
        // Rotation: when the current file sits at the cap, rename it aside
        // (shifting .1 → .2, …) — the previous files are kept, never truncated.
        if (await this.fileAtCap(file)) await this.rotate()
        await appendFile(file, text, 'utf8')
        this.stats.written += events.length
        // Post-append re-check: a single burst may itself cross the cap —
        // rotate now so the next write starts a fresh file without waiting.
        if (await this.fileAtCap(file)) await this.rotate()
      } catch (error) {
        this.stats.writeFailures += events.length
        const now = this.nowFn()
        if (now - this.lastWriteWarnAt >= TRACE_WRITE_WARN_WINDOW_MS) {
          this.lastWriteWarnAt = now
          this.log('warn', '追踪事件写盘失败（5 分钟内不再重复告警）: ' + describe(error))
        }
      }
    }
  }

  private async fileAtCap(file: string): Promise<boolean> {
    try {
      const info = await stat(file)
      return info.size >= this.maxBytes
    } catch {
      return false // missing file: nothing to rotate
    }
  }

  private async rotate(): Promise<void> {
    const file = join(this.dir, TRACE_FILE)
    for (let i = this.keepRotated - 1; i >= 1; i--) {
      try {
        await rename(join(this.dir, traceRotatedFile(i)), join(this.dir, traceRotatedFile(i + 1)))
      } catch {
        // missing source: nothing to shift
      }
    }
    try {
      await rename(file, join(this.dir, traceRotatedFile(1)))
      this.stats.rotated += 1
    } catch (error) {
      this.log('warn', '追踪文件轮转失败: ' + describe(error))
    }
  }

  /** Counters for tests / diagnostics: written / queue-overflow dropped /
   * same-cause suppressed / write failures / rotations. */
  getStats(): { written: number; dropped: number; suppressed: number; writeFailures: number; rotated: number } {
    return { ...this.stats }
  }
}

/** Serialization guard (competitor jsonlSafe): a hostile or exotic data
 * value must never break the file; unserializable events degrade to a
 * minimal error line instead of corrupting the jsonl stream. */
function jsonlSafe(event: TraceEvent): string {
  try {
    return JSON.stringify(event)
  } catch {
    return JSON.stringify({
      v: 1, ts: event.ts, traceId: event.traceId, stage: event.stage, ok: false,
      reason: '追踪事件不可序列化',
    })
  }
}

/** Keep `data` serializable: circular/exotic values degrade to a stub. */
function serializableData(data: unknown): Record<string, unknown> {
  try {
    JSON.stringify(data)
    return data as Record<string, unknown>
  } catch {
    let keys: string[] = []
    try {
      keys = Object.keys(data ?? {}).slice(0, 10)
    } catch {
      keys = []
    }
    return { unserializable: true, type: typeof data, keys }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
