/**
 * Outbound delivery pipeline (M2-D1-PR2): the per-chat serial send chain,
 * sendToChat (sensitive audit → [[qq_forward]] blocks → t2i card / plain
 * text), raw OneBot segment sends, merged forwards, and the M1-B6 offline
 * resend queue (per-chat FIFO, cap 20, TTL 5 min, drained on reconnect).
 * Extracted verbatim from bridge.ts — send order, queueing, TTL/cap and
 * fallback behavior are byte-identical; the bridge keeps same-name facade
 * methods so tools.ts, the command table and the interim domain (still
 * bridge-resident) keep working unchanged.
 * @module dsh-onebot/outbound
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { BridgeConfig } from './bridge.js'
import type { ChatId } from './chat.js'
import { splitChatId } from './chat.js'
import { OneBotActionError, OneBotNotConnectedError } from './connection.js'
import { extractForwardBlocks, scanSensitive, stripMarkdown } from './split.js'
import { renderTextImage } from './t2i/index.js'
import { describeError } from './errors.js'
import { TRACE_REASONS } from './trace.js'
import type { TraceStage } from './trace.js'

/** One OneBot message segment for outbound sends. */
export interface OutboundSegment {
  type: string
  data: Record<string, unknown>
}

/**
 * SnowLuma's send_msg validates text segments: `text === ''` is treated as a
 * compatibility placeholder and a whitespace-only text still goes through
 * normal validation — both get rejected. Strip empty/whitespace-only text
 * segments before the wire; non-text segments pass untouched.
 */
export function filterBlankTextSegments(segments: OutboundSegment[]): OutboundSegment[] {
  return segments.filter(seg => {
    if (seg.type !== 'text') return true
    const text = seg.data?.text
    return !(typeof text === 'string' && text.trim() === '')
  })
}

/** Options for an explicit outbound send (from tools). */
export interface SendOptions {
  replyTo?: string
  /** Queue the send for resend on reconnect instead of failing while the
   * connection is down. Only for model final replies; interim sends carry
   * recall timers + bookkeeping and must never be replayed. */
  queuable?: boolean
}

/**
 * T9 (#2): strip a leaked <user_message> boundary. wrapUserMessage (chat.ts)
 * wraps every inbound payload in `<user_message qq="…" nickname="…">…</user_message>`,
 * and a model may echo those markers back inside its reply. Only the literal
 * `user_message` tag name is recognized, in attribute-constrained shapes, so
 * ordinary angle-bracket text (`<tag>`, XML, `a < b`) passes untouched: a
 * full wrapper loses just its tags (the enclosed content stays), stray
 * opening/closing/self-closing tags are dropped verbatim. Clean text is
 * returned unchanged (no re-trim side effects).
 *
 * #26: a trailing full wrapper after other reply prose is the echo signature
 * of a message that reached the model mid-turn (steer policy) or of the
 * question being answered — the model repeats the wrapped user text at the
 * very end of its reply, and keeping the enclosed content then appends the
 * user's message verbatim. That trailing block is dropped whole (tags AND
 * content), however many lines the prose before it has, and consecutive
 * trailing blocks all go. A wrapper still carrying the entire reply keeps its
 * content (T9), and a mid-reply wrapper keeps its content (an intentional
 * quote).
 *
 * #46: host-internal metadata echoed into the reply is stripped too. Whole
 * lines starting with a fixed host time-sampling/context prefix ("Time
 * sampled while preparing turn", "Browser time zone for this request:",
 * "Elapsed since the preceding model-visible message:") are dropped with
 * the line, and the host role boundary tags <user> / </user> are removed in
 * line-edge shapes only (alone on a line, or glued at a line start/end) —
 * mid-line occurrences (ordinary `<`, XML, comparisons, prose mentions of
 * the prefixes) stay untouched.
 */
export function stripBoundaryLeakage(text: string): string {
  // #46: host metadata echoed as whole lines/line-edge tags — drop the line
  // (or just the glued tag). Line-anchored shapes only; when something was
  // removed, the blank-line runs left behind collapse like the user_message
  // path below.
  let base = text
    .replace(/^[ \t]*(?:Time sampled while preparing turn|Browser time zone for this request:|Elapsed since the preceding model-visible message:).*\r?\n?/gm, '')
    .replace(/(\S)<\/user>[ \t]*$/gm, '$1')
    .replace(/^[ \t]*<\/?user>[ \t]*\r?\n?/gm, '')
  if (base !== text) base = base.replace(/\n{3,}/g, '\n\n').trim()
  if (!/<\/?user_message[\s/>]/i.test(base)) return base
  // #26: trailing full wrapper preceded by other prose — drop the whole
  // block including the enclosed content (leakage, not a quote). The greedy
  // prefix reaches the last opening tag, so one pass takes only the last
  // wrapper: an earlier mid-reply quote survives, and the loop takes
  // consecutive echoes.
  let cleaned = base
  let previous: string
  do {
    previous = cleaned
    cleaned = previous.replace(/^([\s\S]*\S)\s*<user_message\s[^>]*>[\s\S]*<\/user_message\s*>\s*$/i, '$1')
  } while (cleaned !== previous)
  return cleaned
    // Full wrapper: drop the tags, keep the enclosed content (inner edge
    // whitespace trimmed so the removal leaves no doubled blank lines). Trimmed
    // in the callback: \s* on both sides of a lazy group backtracks in cubic time
    // on an unclosed tag followed by a long run of whitespace.
    .replace(/<user_message\s[^>]*?>([\s\S]*?)<\/user_message\s*>/gi, (_match, inner: string) => inner.trim())
    // Stray tags without a matching pair: opening (with attrs), bare
    // opening, closing, and self-closing forms.
    .replace(/<\/?user_message(?:\s[^>]*?)?\/?>/gi, '')
    // Collapse blank-line runs the removal left behind.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Narrow view of a live chat the outbound pipeline may touch — the
 * structural subset of the bridge's ChatAgent the pipeline reads: the
 * nickname used as the t2i card title. Re-evaluated for B8d: the per-chat
 * send chain now lives in the pipeline itself (sendChains), so the chat view
 * no longer carries the queue field. */
export interface OutboundChat {
  lastNickname: string
}

/** The bridge capabilities the outbound pipeline touches. Deliberately
 * narrower than BridgeDeps: the connection call gate, the live chat lookup
 * for the per-chat send chain, the stop flag guarding the B6 drain, and the
 * config subset the pipeline reads — never the agent registry, media store,
 * or policy. */
export interface OutboundContext {
  /** Live chat lookup (card-title nickname). */
  getChat(chatId: ChatId): OutboundChat | undefined
  /** Whether the OneBot connection currently accepts sends. */
  connected(): boolean
  /** The connection's own QQ id (forward-node uin). */
  selfId(): string
  /** Raw OneBot action invocation (send_msg / send_*_forward_msg). W1/T5:
   * the target chatId rides along when known so the bridge's inject dry-run
   * guard can attribute the call to a chat's injected round. */
  call(action: string, params: Record<string, unknown>, chatId?: ChatId): Promise<unknown>
  /** Bridge stop flag: the B6 drain must never run while stopping. */
  isStopping(): boolean
  /** Bridge log line callback. */
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
  /** W1: emit one outbound/queue decision event for a chat. The bridge owns
   * the traceId resolution (chat-level association table; unmapped proactive
   * writes mint a fresh id) — absent = tracing off, zero cost. */
  trace?: (chatId: ChatId, event: { stage: TraceStage; ok?: boolean; reason?: string; data?: Record<string, unknown> }) => void
  /** The only config fields the outbound pipeline reads. The W2-③ write-gate
   * fields ride as optional intersection members so the bridge's BridgeConfig
   * type stays untouched (absent → the defaults below). */
  config: Pick<BridgeConfig, 'botQQ' | 'sensitivePatterns' | 'textImageThreshold' | 'maxImageBytes' | 'cardFooter' | 'fontFiles' | 'fontFamilies' | 'monoFamilies'> & Partial<{
    /** Audit file directory (W2-③: mediaDir/qq-actions.log); absent → no audit. */
    mediaDir: string
    /** W2-③ bridge-wide proactive-write cap per sliding minute; 0 disables. */
    actionRatePerMinute: number
    /** W2-③ bridge-wide proactive-write cap per calendar day; 0 disables. */
    actionRatePerDay: number
    /** W2-③ proactive-write audit switch (default on). */
    actionAuditEnabled: boolean
  }>
}

/** Queued final replies older than this are dropped at drain time (M1-B6). */
const PENDING_SEND_TTL_MS = 5 * 60_000
/** Max queued final replies per chat; the oldest is dropped beyond this (M1-B6). */
const PENDING_SEND_MAX = 20

/** W2-③: default bridge-wide proactive-write caps, aligned with the MIT
 * competitor's actionRatePerMinute(20) / actionRatePerDay(500). */
export const DEFAULT_ACTION_RATE_PER_MINUTE = 20
export const DEFAULT_ACTION_RATE_PER_DAY = 500
/** W2-③: proactive-write audit file name, appended under mediaDir (jsonl). */
export const ACTION_AUDIT_FILE = 'qq-actions.log'

/**
 * The outbound pipeline. Owns the B6 pendingSends state; the bridge keeps
 * same-name delegating facades and wires the reconnect drain trigger.
 */
export class OutboundPipeline {
  private readonly ctx: OutboundContext
  /** Clock override (tests); behavior-affecting timestamps (send chains,
   * offline queue, write gate) all read it — never the wall clock directly. */
  private readonly now: () => number
  /** Per-chat FIFO of model final replies parked while disconnected; drained
   * oldest-first on reconnect (M1-B6). */
  private readonly pendingSends = new Map<ChatId, Array<{ text: string; sentAt: number }>>()

  constructor(ctx: OutboundContext, options: { now?: () => number } = {}) {
    this.ctx = ctx
    // Lazy default: read Date.now through a wrapper so an injected clock is
    // optional and callers without one keep the dynamic global lookup (fake
    // timers in tests must keep influencing the wall-clock path).
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Send plain text to a chat with the full outbound pipeline (forward
   * blocks, Markdown strip, sentence splitting).
   * @param chatId - target chat.
   * @param text - model-produced text.
   * @param options - optional reply target.
   * @returns the sent message ids.
   */
  sendToChat(chatId: ChatId, text: string, options: SendOptions = {}): Promise<string[]> {
    return this.enqueue(chatId, async () => {
      if (!this.ctx.connected()) {
        if (options.queuable === true) {
          // pipeline-hooks.md #23: the park used to be silent.
          this.ctx.log('debug', '连接断开，回复已排队等待重连补发: ' + chatId)
          this.ctx.trace?.(chatId, { stage: 'queue', ok: true, reason: TRACE_REASONS.outboundQueued })
          this.queuePendingSend(chatId, text)
          return []
        }
        this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundNotConnected })
        throw new OneBotNotConnectedError()
      }
      const hits = scanSensitive(text, this.ctx.config.sensitivePatterns)
      if (hits.length > 0) {
        this.ctx.log('warn', 'sensitive outbound audit for ' + chatId + ': ' + hits.join(', '))
        this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: TRACE_REASONS.outboundSensitive, data: { hits: hits.slice(0, 5) } })
      }
      const ids: string[] = []
      const { body, nodes } = extractForwardBlocks(text, '助手')
      // T9 (#2): the model may echo the <user_message> boundary that
      // wrapUserMessage injected — strip the markers before delivery so both
      // the t2i card and the plain-text branch stay clean.
      const clean = stripBoundaryLeakage(body)
      if (nodes.length > 0) {
        // Passive reply path: [[qq_forward]] blocks inside a turn reply are
        // NOT gated as proactive writes (see the W2-③ 口径 note).
        await this.sendForwardNodes(chatId, nodes)
        ids.push('forward')
      }
      let sentCard = false
      const threshold = this.ctx.config.textImageThreshold
      if (threshold > 0 && clean.length > threshold) {
        try {
          const chat = this.ctx.getChat(chatId)
          const title = chat !== undefined && chat.lastNickname !== ''
            ? 'To ' + chat.lastNickname
            : undefined
          const png = renderTextImage(clean, {
            title,
            footerBrand: this.ctx.config.cardFooter,
            fontFiles: this.ctx.config.fontFiles,
            fontFamilies: this.ctx.config.fontFamilies,
            monoFamilies: this.ctx.config.monoFamilies,
          })
          const b64 = 'base64://' + png.toString('base64')
          if (b64.length <= this.ctx.config.maxImageBytes) {
            const id = await this.sendMsg(chatId, [{ type: 'image', data: { file: b64 } }], options)
            if (id !== undefined) ids.push(id)
            sentCard = true
          } else {
            this.ctx.log('warn', 't2i card PNG exceeds maxImageBytes; falling back to text')
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundCardTooLarge })
          }
        } catch (error) {
          this.ctx.log('warn', 't2i render failed, falling back to text: ' + describeError(error))
          this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '文字图卡片渲染失败，已降级为文本: ' + describeError(error) })
        }
      }
      if (!sentCard) {
        const plain = stripMarkdown(clean)
        if (plain !== '') {
          const id = await this.sendMsg(chatId, [{ type: 'text', data: { text: plain } }], options)
          if (id !== undefined) ids.push(id)
        } else {
          // pipeline-hooks.md #30: the empty-body skip used to be silent.
          this.ctx.log('debug', '正文为空，未发送: ' + chatId)
          this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundEmptyText })
        }
      }
      this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '回复已发送', data: { segments: ids.length } })
      return ids
    })
  }

  /** Park one queuable send for a chat while disconnected (M1-B6):
   * per-chat FIFO, capped — the oldest entry is dropped beyond the cap. */
  private queuePendingSend(chatId: ChatId, text: string): void {
    const queue = this.pendingSends.get(chatId) ?? []
    if (queue.length >= PENDING_SEND_MAX) {
      queue.shift()
      this.ctx.log('warn', 'pending send queue full for ' + chatId + ', dropped oldest')
      this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueFull })
    }
    queue.push({ text, sentAt: this.now() })
    this.pendingSends.set(chatId, queue)
  }

  // ── W2-③ proactive-write gate (minute/day caps + audit) ─────────────────
  // 口径（per outbound.ts structure）：「主动写」= 模型/命令经 qq_* 工具发起、
  // 不属于某个入站回合回复链的出站写 —— 即 sendSegments（qq_send_image/voice/
  // video/file/segments）与公开 sendForward（qq_send_forward）。被动回复不受此
  // 闸：sendToChat 整条链（最终回复/interim/错误与命令通知、[[qq_forward]] 块，
  // 后者走未设闸的 sendForwardNodes）由入站 rateLimitPerMinute + B6 队列上限
  // 约束。两类计数都是全桥合计（不分会话）。

  /** Sliding-60s timestamps of allowed proactive writes (bridge-wide). */
  private writeActionTimes: number[] = []
  /** Calendar-day (local) counter of allowed proactive writes. */
  private writeDayKey = ''
  private writeDayCount = 0
  /** Serialized audit-append chain (order discipline, see auditWrite). */
  private auditChain: Promise<void> = Promise.resolve()

  /** W1/T5 health snapshot: the write gate's current usage against its
   * limits (minute sliding window pruned at read time; day counter). */
  writeGateStats(): { minuteUsed: number; minuteLimit: number; dayUsed: number; dayLimit: number } {
    const perMinute = this.ctx.config.actionRatePerMinute ?? DEFAULT_ACTION_RATE_PER_MINUTE
    const perDay = this.ctx.config.actionRatePerDay ?? DEFAULT_ACTION_RATE_PER_DAY
    const now = this.now()
    const minuteUsed = perMinute > 0
      ? this.writeActionTimes.filter(t => now - t < 60_000).length
      : 0
    const d = new Date(now)
    const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    const dayUsed = perDay > 0 && this.writeDayKey === dayKey ? this.writeDayCount : 0
    return { minuteUsed, minuteLimit: perMinute, dayUsed, dayLimit: perDay }
  }

  /** W2-③: check + consume one proactive-write slot. Returns a non-empty
   * Chinese rejection reason when the write must be dropped (a warn with the
   * chatId and the limit name is logged and the rejection is audited);
   * returns null when allowed (slot consumed). Rejected attempts do not
   * consume quota. */
  private writeGateRejectReason(chatId: ChatId, action: string): string | null {
    const perMinute = this.ctx.config.actionRatePerMinute ?? DEFAULT_ACTION_RATE_PER_MINUTE
    const perDay = this.ctx.config.actionRatePerDay ?? DEFAULT_ACTION_RATE_PER_DAY
    if (perMinute <= 0 && perDay <= 0) return null
    const now = this.now()
    this.writeActionTimes = this.writeActionTimes.filter(t => now - t < 60_000)
    const d = new Date(now)
    const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    if (this.writeDayKey !== dayKey) {
      this.writeDayKey = dayKey
      this.writeDayCount = 0
    }
    if (perMinute > 0 && this.writeActionTimes.length >= perMinute) {
      const reason = '写操作频率超限：60 秒内主动写已达 ' + perMinute + ' 次上限（actionRatePerMinute=' + perMinute + '），请稍后再试'
      this.ctx.log('warn', '已拒发主动写操作: chat=' + chatId + ' action=' + action + '，' + reason)
      this.auditWrite(chatId, action, false, reason)
      this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason })
      return reason
    }
    if (perDay > 0 && this.writeDayCount >= perDay) {
      const reason = '写操作次数超限：今日主动写已达 ' + perDay + ' 次上限（actionRatePerDay=' + perDay + '），明日自动恢复'
      this.ctx.log('warn', '已拒发主动写操作: chat=' + chatId + ' action=' + action + '，' + reason)
      this.auditWrite(chatId, action, false, reason)
      this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason })
      return reason
    }
    this.writeActionTimes.push(now)
    this.writeDayCount += 1
    return null
  }

  /** W2-③: append one proactive-write (or rejection / send failure) audit
   * line to mediaDir/qq-actions.log (jsonl: ts/chatId/action/ok/reason).
   * Fire-and-forget: a write failure only warns and never affects the send
   * path. Writes are chained so lines land in call order even when the fs
   * thread pool completes them out of schedule. No-op when auditing is
   * disabled or no mediaDir is configured. */
  private auditWrite(chatId: ChatId, action: string, ok: boolean, reason: string): void {
    if (this.ctx.config.actionAuditEnabled === false) return
    const dir = this.ctx.config.mediaDir
    if (dir === undefined || dir === '') return
    const line = JSON.stringify({ ts: this.now(), chatId, action, ok, reason }) + '\n'
    this.auditChain = this.auditChain.then(async () => {
      await mkdir(dir, { recursive: true })
      await appendFile(join(dir, ACTION_AUDIT_FILE), line, 'utf8')
    }).catch(error => {
      this.ctx.log('warn', '写操作审计写入失败: ' + describeError(error))
    })
  }

  /** Resend parked final replies oldest-first after a reconnect (M1-B6).
   * Per-chat send chains keep the order; a send that hits a fresh
   * disconnection re-queues itself via the queuable gate. Expired entries
   * (TTL) are dropped. Never runs while stopping. Wired from the bridge's
   * onStatus(true) handler (bridge.start). */
  drainPendingSends(): void {
    if (this.ctx.isStopping()) return
    const now = this.now()
    const batch: Array<{ chatId: ChatId; text: string }> = []
    for (const [chatId, queue] of this.pendingSends) {
      this.pendingSends.delete(chatId)
      for (const item of queue) {
        if (now - item.sentAt < PENDING_SEND_TTL_MS) {
          batch.push({ chatId, text: item.text })
        } else {
          // pipeline-hooks.md #25: the TTL drop used to be silent.
          this.ctx.log('debug', '排队回复超过 5 分钟未送达，已丢弃: ' + chatId)
          this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueTtlExpired })
        }
      }
    }
    for (const { chatId, text } of batch) {
      void this.sendToChat(chatId, text, { queuable: true }).catch((error: unknown) => {
        this.ctx.log('warn', 'queued resend failed: ' + describeError(error))
        this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: '排队回复补发失败: ' + describeError(error) })
      })
    }
  }

  /**
   * Send raw OneBot segments (used by the media tools). W2-③: counts as a
   * proactive write — subject to the minute/day caps and audited.
   * @param chatId - target chat.
   * @param segments - outbound segments.
   * @returns the sent message id.
   */
  sendSegments(chatId: ChatId, segments: OutboundSegment[]): Promise<string | undefined> {
    return this.enqueue(chatId, async () => {
      const reject = this.writeGateRejectReason(chatId, 'send_msg')
      if (reject !== null) throw new OneBotActionError(reject)
      try {
        const id = await this.sendMsg(chatId, segments, {})
        this.auditWrite(chatId, 'send_msg', true, '发送成功')
        return id
      } catch (error) {
        this.auditWrite(chatId, 'send_msg', false, '发送失败: ' + describeError(error))
        this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '主动写发送失败: ' + describeError(error) })
        throw error
      }
    })
  }

  /** B8d: per-chat send chains owned by the pipeline (decoupled from the
   * registry's chat lifecycle — unregistered chats serialize too, the
   * original C6b ask). Entries clean themselves up once settled so evicted
   * chats do not accumulate. */
  private readonly sendChains = new Map<ChatId, Promise<unknown>>()

  /** Serialize work on one chat's send chain. */
  private enqueue<T>(chatId: ChatId, work: () => Promise<T>): Promise<T> {
    const chain = this.sendChains.get(chatId) ?? Promise.resolve()
    const run = chain.then(work, work)
    const tail = run.catch(() => undefined)
    this.sendChains.set(chatId, tail)
    void tail.then(() => {
      if (this.sendChains.get(chatId) === tail) this.sendChains.delete(chatId)
    })
    return run
  }

  /** The chat's send-chain tail; resolves once every queued send has settled
   * (settleLoop snapshots the interim trail after it, preserving order). */
  chainTail(chatId: ChatId): Promise<unknown> {
    return this.sendChains.get(chatId) ?? Promise.resolve()
  }

  /** Send one message to a chat and return its message id. */
  async sendMsg(chatId: ChatId, segments: OutboundSegment[], options: SendOptions): Promise<string | undefined> {
    const ref = splitChatId(chatId)
    const params: Record<string, unknown> = {}
    let target: number
    try {
      target = Number(ref.target)
      if (!Number.isFinite(target)) throw new Error('bad target')
    } catch {
      throw new OneBotActionError('invalid chat target: ' + chatId)
    }
    if (ref.kind === 'group') params.group_id = target
    else params.user_id = target
    // SnowLuma rejects empty/whitespace-only text segments — strip them at
    // the single wire chokepoint (both the pipeline and the tools funnel
    // through here).
    const filtered = filterBlankTextSegments(segments)
    if (filtered.length === 0 && options.replyTo === undefined) {
      this.ctx.log('debug', '过滤空白文本段后无有效消息段，未发送: ' + chatId)
      this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundEmptyText })
      return undefined
    }
    params.message = filtered
    if (options.replyTo !== undefined) {
      params.message = [{ type: 'reply', data: { id: options.replyTo } }, ...filtered]
    }
    const data = await this.ctx.call('send_msg', params, chatId) as { message_id?: number | string }
    return data.message_id !== undefined ? String(data.message_id) : undefined
  }

  /** Send [[qq_forward]] nodes as a merged-forward message (proactive write
   * from the qq_send_forward tool). W2-③: subject to the minute/day caps
   * and audited; the passive [[qq_forward]] blocks inside sendToChat bypass
   * this gate via sendForwardNodes. */
  async sendForward(chatId: ChatId, nodes: Array<{ name: string; content: string }>): Promise<void> {
    const reject = this.writeGateRejectReason(chatId, 'send_forward_msg')
    if (reject !== null) throw new OneBotActionError(reject)
    try {
      await this.sendForwardNodes(chatId, nodes)
      this.auditWrite(chatId, 'send_forward_msg', true, '发送成功')
    } catch (error) {
      this.auditWrite(chatId, 'send_forward_msg', false, '发送失败: ' + describeError(error))
      this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '主动写发送失败: ' + describeError(error) })
      throw error
    }
  }

  /** Ungated merged-forward send (shared by the gated tool path and the
   * passive [[qq_forward]] blocks inside sendToChat). */
  private async sendForwardNodes(chatId: ChatId, nodes: Array<{ name: string; content: string }>): Promise<void> {
    const ref = splitChatId(chatId)
    const target = Number(ref.target)
    if (!Number.isFinite(target)) throw new OneBotActionError('invalid chat target: ' + chatId)
    const messages = nodes.map(node => ({
      type: 'node',
      data: {
        uin: this.ctx.selfId() || this.ctx.config.botQQ,
        name: node.name.slice(0, 24),
        content: [{ type: 'text', data: { text: node.content.slice(0, 500) } }],
      },
    }))
    if (ref.kind === 'group') {
      await this.ctx.call('send_forward_msg', { group_id: target, messages }, chatId)
    } else {
      await this.ctx.call('send_private_forward_msg', { user_id: target, messages }, chatId)
    }
  }
}
