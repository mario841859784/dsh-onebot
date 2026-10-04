/**
 * Inbound recording (W1/T5): optional capture of every inbound OneBot event
 * into mediaDir/qq-inbox.jsonl in a replayable shape — one JSON line per
 * event: { v:1, ts, kind, frame, decision? }. The line is written once the
 * bridge settles the event's synchronous decision, so gate-skipped events
 * carry the decision reason that was current at that moment (dispatched
 * messages carry the dispatch confirmation). The recorder is a pure bypass:
 * it owns its own serialized async writer (the pipeline never awaits disk),
 * a write failure only warns (rate-limited to one line per 5 minutes) and
 * can never affect the reply path. Rotation is by rename at 2 MiB with the
 * previous files kept (same scheme as the trace sink).
 *
 * Redaction (inboxRedact, default false): every digit run of length ≥6
 * (QQ/group numbers and anything numeric of that shape) is masked in the
 * frame's string values before the line is serialized; numeric id fields are
 * masked too (converted to their redacted string form), so a redacted
 * recording can be shared for offline replay without leaking ids.
 *
 * Injected events are never recorded (the bridge passes the injected flag),
 * so "inject → record → replay → inject" feedback loops are impossible.
 *
 * MIT attribution: the replayable single-line shape, the redact-on-record
 * idea and the 2 MiB rotation are aligned with dsh-qq-onebot-bridge
 * lib/inbox.js (MIT License, Copyright (c) 2026 dsh-qq-onebot-bridge
 * contributors); the decision-capture writer, the business-field frame
 * whitelist and the redaction walk are original to this plugin. The full
 * borrowed-item list lives in DEVLOG.md (2026-10-04).
 * @module dsh-onebot/record
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { OneBotEvent } from './connection.js'
import type { TraceScope } from './trace.js'

/** Recorded inbox file name, appended under the media dir. */
export const INBOX_FILE = 'qq-inbox.jsonl'
/** Rotated file name for one generation (1 → qq-inbox.1.jsonl). */
export function inboxRotatedFile(generation: number): string {
  return 'qq-inbox.' + generation + '.jsonl'
}
/** Size cap per inbox file (competitor-aligned 2 MiB); at the cap the file is renamed aside. */
export const INBOX_MAX_BYTES = 2 * 1024 * 1024
/** How many rotated files are kept. */
export const INBOX_KEEP_ROTATED = 2
/** Sender-controlled text is truncated to this length before serialization. */
export const INBOX_TEXT_MAX_CHARS = 2000
/** Write-failure warn dedup window. */
export const INBOX_WRITE_WARN_WINDOW_MS = 5 * 60_000

/** One frame's recorded business fields (socket/unknown fields dropped). */
export interface InboxFrame {
  post_type?: string
  message_type?: string
  sub_type?: string
  notice_type?: string
  request_type?: string
  user_id?: string
  group_id?: string
  self_id?: string
  message_id?: string
  message?: unknown
  raw_message?: string
  sender?: { user_id?: string; nickname?: string; card?: string; role?: string }
}

/** The decision captured while the bridge settled the event. */
export interface InboxDecision {
  stage: string
  ok: boolean
  reason?: string
}

/** One line as appended to the jsonl file. */
export interface InboxLine {
  v: 1
  ts: number
  kind: string
  frame: InboxFrame
  decision?: InboxDecision
}

export interface InboundRecorderOptions {
  /** Directory the jsonl file lives in (the plugin media dir). */
  dir: string
  /** Mask 6+ digit runs before serialization (default false). */
  redact?: boolean
  /** Rotation size cap (tests shrink it; default 2 MiB). */
  maxBytes?: number
  /** Rotated files kept (tests may use fewer). */
  keepRotated?: number
  /** Clock override (tests). */
  now?: () => number
  /** Warn port for write failures. */
  log?: (level: 'warn', message: string) => void
}

/** Mask every digit run of length ≥6 (the first three digits stay readable). */
export function redactDigits(text: string): string {
  return text.replace(/\d{6,}/g, match => match.slice(0, 3) + '****')
}

/** Numeric id keys that are masked even when the event carries them as numbers. */
const ID_KEYS = new Set(['user_id', 'group_id', 'self_id', 'message_id', 'operator_id', 'target_id', 'discuss_id'])

/** Deep-redact a frame: strings get redactDigits, numeric/other id values are
 * converted to their redacted string form, unknown fields are dropped. */
export function redactFrame(frame: InboxFrame): InboxFrame {
  const out: InboxFrame = {}
  for (const [key, value] of Object.entries(frame)) {
    if (value === undefined) continue
    if (ID_KEYS.has(key)) {
      out[key as keyof InboxFrame] = redactDigits(String(value)) as never
      continue
    }
    if (typeof value === 'string') {
      out[key as keyof InboxFrame] = redactDigits(value) as never
      continue
    }
    if (key === 'raw_message' || key === 'message') {
      out[key as keyof InboxFrame] = value as never
      continue
    }
    if (key === 'sender' && typeof value === 'object' && value !== null) {
      const sender = value as NonNullable<InboxFrame['sender']>
      out.sender = {
        ...(sender.user_id !== undefined ? { user_id: redactDigits(String(sender.user_id)) } : {}),
        ...(sender.nickname !== undefined ? { nickname: redactDigits(sender.nickname) } : {}),
        ...(sender.card !== undefined ? { card: redactDigits(sender.card) } : {}),
        ...(sender.role !== undefined ? { role: sender.role } : {}),
      }
      continue
    }
    out[key as keyof InboxFrame] = value as never
  }
  return out
}

/** Reduce one raw event to the replayable business frame; sender-controlled
 * text fields are truncated to INBOX_TEXT_MAX_CHARS. */
export function toInboxFrame(event: OneBotEvent): InboxFrame {
  const str = (value: unknown): string | undefined =>
    value === undefined || value === null ? undefined : String(value)
  const text = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined
    return value.length > INBOX_TEXT_MAX_CHARS ? value.slice(0, INBOX_TEXT_MAX_CHARS) : value
  }
  const message = Array.isArray(event.message)
    ? event.message
    : text(event.message)
  const frame: InboxFrame = {
    post_type: str(event.post_type),
    message_type: str(event.message_type),
    sub_type: str(event.sub_type),
    notice_type: str(event.notice_type),
    request_type: str(event.request_type),
    user_id: str(event.user_id),
    group_id: str(event.group_id),
    self_id: str(event.self_id),
    message_id: str(event.message_id),
    message: message as InboxFrame['message'],
    raw_message: text(event.raw_message),
  }
  const sender = event.sender
  if (typeof sender === 'object' && sender !== null) {
    frame.sender = {
      user_id: str(sender.user_id),
      nickname: text(sender.nickname),
      card: text(sender.card),
      role: str(sender.role),
    }
  }
  return frame
}

/** Per-event session: the bridge fills the decision through the scope while
 * the pipeline settles, then calls end() exactly once. */
export interface InboundRecordSession {
  /** The capture scope handed to runWithTrace when the trace sink is off:
   * it only records the decision chain, never writes a trace file. */
  captureScope(): TraceScope
  /** Wrap an existing (trace-enabled) scope so decisions are captured too. */
  wrapScope(scope: TraceScope): TraceScope
  /** Write the line (frame + last captured decision) on the writer chain. */
  end(): void
}

/**
 * The inbound recorder. Default OFF — constructed only when recordInbound is
 * enabled; the bridge skips it entirely otherwise (zero overhead, zero files).
 */
export class InboundRecorder {
  private readonly dir: string
  /** Whether 6+ digit runs are masked before serialization (health reads this). */
  readonly redact: boolean
  private readonly maxBytes: number
  private readonly keepRotated: number
  private readonly nowFn: () => number
  private readonly log: (level: 'warn', message: string) => void
  private writeChain: Promise<void> = Promise.resolve()
  private dirEnsured = false
  private lastWriteWarnAt = 0
  private readonly stats = { written: 0, dropped: 0, writeFailures: 0, rotated: 0 }

  constructor(options: InboundRecorderOptions) {
    this.dir = options.dir
    this.redact = options.redact === true
    this.maxBytes = options.maxBytes ?? INBOX_MAX_BYTES
    this.keepRotated = Math.max(1, options.keepRotated ?? INBOX_KEEP_ROTATED)
    this.nowFn = options.now ?? Date.now
    this.log = options.log ?? (() => undefined)
  }

  /** Begin one inbound event's record; the returned session must be ended by
   * the bridge once the synchronous decision settled. */
  begin(event: OneBotEvent): InboundRecordSession {
    const frame = toInboxFrame(event)
    const line: InboxLine = {
      v: 1,
      ts: this.nowFn(),
      kind: String(event.post_type ?? ''),
      frame: this.redact ? redactFrame(frame) : frame,
    }
    let decision: InboxDecision | undefined
    const recorder = this
    const capture = (stage: string, opts: { ok?: boolean; reason?: string }): void => {
      decision = { stage, ok: opts.ok !== false, ...(opts.reason !== undefined ? { reason: opts.reason } : {}) }
    }
    return {
      captureScope(): TraceScope {
        return {
          traceId: 'record-' + line.ts.toString(36),
          chatId: frame.group_id !== undefined && frame.group_id !== ''
            ? 'group:' + frame.group_id
            : 'private:' + (frame.user_id ?? ''),
          messageId: frame.message_id,
          emit(stage, opts = {}) { capture(stage, opts) },
        }
      },
      wrapScope(scope: TraceScope): TraceScope {
        return {
          traceId: scope.traceId,
          chatId: scope.chatId,
          messageId: scope.messageId,
          emit(stage, opts = {}) {
            capture(stage, opts)
            scope.emit(stage, opts)
          },
        }
      },
      end(): void {
        if (decision !== undefined) line.decision = decision
        recorder.write(line)
      },
    }
  }

  /** Enqueue one line on the serialized writer chain; never awaited by the
   * pipeline, never throws. */
  private write(line: InboxLine): void {
    this.writeChain = this.writeChain.then(async () => {
      try {
        if (!this.dirEnsured) {
          await mkdir(this.dir, { recursive: true })
          this.dirEnsured = true
        }
        const file = join(this.dir, INBOX_FILE)
        if (await this.fileAtCap(file)) await this.rotate()
        await appendFile(file, JSON.stringify(line) + '\n', 'utf8')
        this.stats.written += 1
        if (await this.fileAtCap(file)) await this.rotate()
      } catch (error) {
        this.stats.writeFailures += 1
        const now = this.nowFn()
        if (now - this.lastWriteWarnAt >= INBOX_WRITE_WARN_WINDOW_MS) {
          this.lastWriteWarnAt = now
          this.log('warn', '入站录制写盘失败（5 分钟内不再重复告警）: ' + describe(error))
        }
      }
    }).catch(() => undefined)
  }

  private async fileAtCap(file: string): Promise<boolean> {
    try {
      const info = await stat(file)
      return info.size >= this.maxBytes
    } catch {
      return false
    }
  }

  private async rotate(): Promise<void> {
    const file = join(this.dir, INBOX_FILE)
    for (let i = this.keepRotated - 1; i >= 1; i--) {
      try {
        await rename(join(this.dir, inboxRotatedFile(i)), join(this.dir, inboxRotatedFile(i + 1)))
      } catch {
        // missing source: nothing to shift
      }
    }
    try {
      await rename(file, join(this.dir, inboxRotatedFile(1)))
      this.stats.rotated += 1
    } catch (error) {
      this.log('warn', '录制文件轮转失败: ' + describe(error))
    }
  }

  /** Flush the writer chain (tests). */
  flush(): Promise<void> {
    return this.writeChain
  }

  /** Counters for tests / diagnostics. */
  getStats(): { written: number; dropped: number; writeFailures: number; rotated: number } {
    return { ...this.stats }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
