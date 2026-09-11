/**
 * Outbound delivery pipeline (M2-D1-PR2): the per-chat serial send chain,
 * sendToChat (sensitive audit → [[qq_forward]] blocks → t2i card / split
 * text), raw OneBot segment sends, merged forwards, and the M1-B6 offline
 * resend queue (per-chat FIFO, cap 20, TTL 5 min, drained on reconnect).
 * Extracted verbatim from bridge.ts — send order, queueing, TTL/cap and
 * fallback behavior are byte-identical; the bridge keeps same-name facade
 * methods so tools.ts, the command table and the interim domain (still
 * bridge-resident) keep working unchanged.
 * @module dsh-onebot/outbound
 */
import type { BridgeConfig } from './bridge.js'
import type { ChatId } from './chat.js'
import { splitChatId } from './chat.js'
import { OneBotActionError, OneBotNotConnectedError } from './connection.js'
import { extractForwardBlocks, scanSensitive, splitLongText, stripMarkdown } from './split.js'
import { renderTextImage } from './t2i/index.js'

/** One OneBot message segment for outbound sends. */
export interface OutboundSegment {
  type: string
  data: Record<string, unknown>
}

/** Options for an explicit outbound send (from tools). */
export interface SendOptions {
  replyTo?: string
  /** Queue the send for resend on reconnect instead of failing while the
   * connection is down. Only for model final replies; interim sends carry
   * recall timers + bookkeeping and must never be replayed. */
  queuable?: boolean
}

/** Narrow view of a live chat the outbound pipeline may touch — the
 * structural subset of the bridge's internal ChatAgent: the per-chat send
 * chain head (mutated by enqueue) and the nickname used as the t2i card
 * title. */
export interface OutboundChat {
  /** Per-chat send chain (preserves outbound order). */
  queue: Promise<unknown>
  lastNickname: string
}

/** The bridge capabilities the outbound pipeline touches. Deliberately
 * narrower than BridgeDeps: the connection call gate, the live chat lookup
 * for the per-chat send chain, the stop flag guarding the B6 drain, and the
 * config subset the pipeline reads — never the agent registry, media store,
 * or policy. */
export interface OutboundContext {
  /** Live chat lookup (send-chain head + card-title nickname). */
  getChat(chatId: ChatId): OutboundChat | undefined
  /** Whether the OneBot connection currently accepts sends. */
  connected(): boolean
  /** The connection's own QQ id (forward-node uin). */
  selfId(): string
  /** Raw OneBot action invocation (send_msg / send_*_forward_msg). */
  call(action: string, params: Record<string, unknown>): Promise<unknown>
  /** Bridge stop flag: the B6 drain must never run while stopping. */
  isStopping(): boolean
  /** Bridge log line callback. */
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
  /** The only config fields the outbound pipeline reads. */
  config: Pick<BridgeConfig, 'botQQ' | 'sensitivePatterns' | 'splitLength' | 'textImageThreshold' | 'maxImageBytes' | 'cardFooter' | 'fontFiles' | 'fontFamilies'>
}

/** Queued final replies older than this are dropped at drain time (M1-B6). */
const PENDING_SEND_TTL_MS = 5 * 60_000
/** Max queued final replies per chat; the oldest is dropped beyond this (M1-B6). */
const PENDING_SEND_MAX = 20

/**
 * The outbound pipeline. Owns the B6 pendingSends state; the bridge keeps
 * same-name delegating facades and wires the reconnect drain trigger.
 */
export class OutboundPipeline {
  private readonly ctx: OutboundContext
  /** Per-chat FIFO of model final replies parked while disconnected; drained
   * oldest-first on reconnect (M1-B6). */
  private readonly pendingSends = new Map<ChatId, Array<{ text: string; sentAt: number }>>()

  constructor(ctx: OutboundContext) {
    this.ctx = ctx
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
          this.queuePendingSend(chatId, text)
          return []
        }
        throw new OneBotNotConnectedError()
      }
      const hits = scanSensitive(text, this.ctx.config.sensitivePatterns)
      if (hits.length > 0) {
        this.ctx.log('warn', 'sensitive outbound audit for ' + chatId + ': ' + hits.join(', '))
      }
      const ids: string[] = []
      const { body, nodes } = extractForwardBlocks(text, '助手')
      if (nodes.length > 0) {
        await this.sendForward(chatId, nodes)
        ids.push('forward')
      }
      let sentCard = false
      const threshold = this.ctx.config.textImageThreshold
      if (threshold > 0 && body.length > threshold) {
        try {
          const chat = this.ctx.getChat(chatId)
          const title = chat !== undefined && chat.lastNickname !== ''
            ? 'To ' + chat.lastNickname
            : undefined
          const png = renderTextImage(body, {
            title,
            footerBrand: this.ctx.config.cardFooter,
            fontFiles: this.ctx.config.fontFiles,
            fontFamilies: this.ctx.config.fontFamilies,
          })
          const b64 = 'base64://' + png.toString('base64')
          if (b64.length <= this.ctx.config.maxImageBytes) {
            const id = await this.sendMsg(chatId, [{ type: 'image', data: { file: b64 } }], options)
            if (id !== undefined) ids.push(id)
            sentCard = true
          } else {
            this.ctx.log('warn', 't2i card PNG exceeds maxImageBytes; falling back to text')
          }
        } catch (error) {
          this.ctx.log('warn', 't2i render failed, falling back to text: ' + (error instanceof Error ? error.message : String(error)))
        }
      }
      if (!sentCard) {
        const plain = stripMarkdown(body)
        if (plain !== '') {
          const chunks = splitLongText(plain, this.ctx.config.splitLength)
          for (const chunk of chunks) {
            const id = await this.sendMsg(chatId, [{ type: 'text', data: { text: chunk } }], options)
            if (id !== undefined) ids.push(id)
          }
        }
      }
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
    }
    queue.push({ text, sentAt: Date.now() })
    this.pendingSends.set(chatId, queue)
  }

  /** Resend parked final replies oldest-first after a reconnect (M1-B6).
   * Per-chat send chains keep the order; a send that hits a fresh
   * disconnection re-queues itself via the queuable gate. Expired entries
   * (TTL) are dropped. Never runs while stopping. Wired from the bridge's
   * onStatus(true) handler (bridge.start). */
  drainPendingSends(): void {
    if (this.ctx.isStopping()) return
    const now = Date.now()
    const batch: Array<{ chatId: ChatId; text: string }> = []
    for (const [chatId, queue] of this.pendingSends) {
      this.pendingSends.delete(chatId)
      for (const item of queue) {
        if (now - item.sentAt < PENDING_SEND_TTL_MS) batch.push({ chatId, text: item.text })
      }
    }
    for (const { chatId, text } of batch) {
      void this.sendToChat(chatId, text, { queuable: true }).catch((error: unknown) => {
        this.ctx.log('warn', 'queued resend failed: ' + (error instanceof Error ? error.message : String(error)))
      })
    }
  }

  /**
   * Send raw OneBot segments (used by the media tools).
   * @param chatId - target chat.
   * @param segments - outbound segments.
   * @returns the sent message id.
   */
  sendSegments(chatId: ChatId, segments: OutboundSegment[]): Promise<string | undefined> {
    return this.enqueue(chatId, () => this.sendMsg(chatId, segments, {}))
  }

  /** Serialize work on one chat's send chain. */
  private enqueue<T>(chatId: ChatId, work: () => Promise<T>): Promise<T> {
    const existing = this.ctx.getChat(chatId)
    const chain = (existing?.queue ?? Promise.resolve()) as Promise<unknown>
    const run = chain.then(work, work)
    if (existing !== undefined) {
      existing.queue = run.catch(() => undefined)
    } else {
      void run.catch(() => undefined)
    }
    return run
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
    params.message = segments
    if (options.replyTo !== undefined) {
      params.message = [{ type: 'reply', data: { id: options.replyTo } }, ...segments]
    }
    const data = await this.ctx.call('send_msg', params) as { message_id?: number | string }
    return data.message_id !== undefined ? String(data.message_id) : undefined
  }

  /** Send [[qq_forward]] nodes as a merged-forward message. */
  async sendForward(chatId: ChatId, nodes: Array<{ name: string; content: string }>): Promise<void> {
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
      await this.ctx.call('send_forward_msg', { group_id: target, messages })
    } else {
      await this.ctx.call('send_private_forward_msg', { user_id: target, messages })
    }
  }
}
