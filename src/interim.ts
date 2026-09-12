/**
 * Interim domain (M2-D1-PR5): the loop-merge outbound mode — live interim
 * sends with per-message auto-recall timers, the turn/end settlement (one t2i
 * summary card → immediate recall of the still-on-screen originals → the
 * deferred final), and the assistant/message interim routing (id dedupe,
 * deferred-text flush, tool-call short-circuit). Extracted verbatim from
 * bridge.ts — method signatures and statement order are unchanged. The interim
 * state stays on ChatAgent (registry.ts): the inbound residue reset, the
 * /stop /retry manual clears and the registry dispose paths read and write
 * those fields directly, so the tracker operates on the same per-chat object
 * through the narrow InterimChat view.
 * @module dsh-onebot/interim
 */
import type { AssistantMessage } from '@deepseek-ai/dsh-llm'

import type { BridgeConfig } from './bridge.js'
import type { ChatId } from './chat.js'
import type { OutboundSegment, SendOptions } from './outbound.js'
import { renderTextImage } from './t2i/index.js'

/** Spacing between recall delete_msg calls (NapCat recallMsg is slow; bursting
 * them pushes borderline-late recalls over the server timeout). */
const RECALL_SPACING_MS = 60

/** Narrow view of a live chat the interim tracker may touch — the structural
 * subset of the bridge's ChatAgent carrying the interim state. The storage
 * itself stays on ChatAgent: the inbound pipeline's residue reset, the /stop
 * /retry manual clears and the registry dispose paths touch the same fields. */
export interface InterimChat {
  /** Buffered last-step text when interimMessages is off. */
  pendingFinal: string
  /** Text deferred one step, awaiting the next assistant/message to prove it
   * interim — the last one is the final. */
  loopPending: string | null
  /** Sent interim messages awaiting turn/end summary (text kept for the recap
   * t2i card). `sentAt` drives the per-message auto-recall scheduled after
   * each interim's send completes. */
  loopBuffer: Array<{ id: string; text: string; sentAt: number }>
  /** Per-interim 90s (config interimRecallMs) auto-recall timers, keyed by
   * message id; cleared when turn/end recalls the originals immediately. */
  recallTimers: Map<string, ReturnType<typeof setTimeout>>
  /** Interim message ids already auto-revoked by their 90s timer during a long
   * turn — skipped by the turn/end immediate recall (already gone from QQ). */
  recalledInterimIds: Set<string>
  /** Last assistant message id already handled — duplicate session events
   * (streaming/usage re-emits of the same message) must not re-send it. */
  lastHandledMessageId: string | undefined
}

/** The bridge capabilities the interim tracker touches. Deliberately narrower
 * than BridgeDeps: the outbound send paths as callbacks (the PR2 facade
 * contract — zero direct dependency on the outbound internals), the raw
 * OneBot action gate (delete_msg recalls), the send-chain tail settleLoop
 * drains, the host-card relay and the per-chat outbound-mode resolver the
 * assistant/message branch reads, the log, and the config subset the interim
 * domain actually reads. */
export interface InterimContext {
  /** Full outbound pipeline send (interim lines, summary-card text fallback,
   * deferred finals). */
  sendToChat(chatId: ChatId, text: string, options?: SendOptions): Promise<string[]>
  /** Raw segment send (the summary t2i card). */
  sendMsg(chatId: ChatId, segments: OutboundSegment[], options: SendOptions): Promise<string | undefined>
  /** Raw OneBot action invocation (delete_msg recalls). */
  call(action: string, params: Record<string, unknown>): Promise<unknown>
  /** The chat's outbound send-chain tail (settleLoop drains it before
   * snapshotting the interim trail). */
  chainTail(chatId: ChatId): Promise<unknown>
  /** Host-plane card relay (assistant/message branch, before any early return). */
  relayHostCards(chatId: ChatId, content: readonly unknown[]): void
  /** Per-chat effective outbound mode (/mode override → global config). */
  effectiveInterim(chatId: ChatId): boolean
  /** Bridge log line callback. */
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
  /** The only config fields the interim domain reads. */
  config: Pick<BridgeConfig, 'interimRecallMs' | 'maxImageBytes' | 'cardFooter' | 'fontFiles' | 'fontFamilies'>
}

/**
 * The interim tracker: one per bridge, operating on the per-chat state through
 * InterimChat. The methods keep receiving chatId + chat exactly as their
 * pre-split bridge signatures did.
 */
export class InterimTracker {
  private readonly ctx: InterimContext

  constructor(ctx: InterimContext) {
    this.ctx = ctx
  }

  /**
   * turn/start (B8): prune the previous turn's recalled-id residue. Message
   * ids are per-send unique, so a pruned id can never be consulted by a later
   * turn/end recall — those reads only see the current turn's own buf. The
   * one benign race: a follow-up turn starting while the previous turn's
   * settleLoop recall is still draining loses the skip entries recorded
   * before the prune, so an already-revoked id gets one extra delete_msg that
   * fails and is logged at debug — no user-visible change.
   */
  onTurnStart(chat: InterimChat): void {
    chat.recalledInterimIds.clear()
  }

  /** The onSessionEvent assistant/message branch: dedupe, host-card relay,
   * then the interim/deferred routing. Verbatim from the pre-split bridge. */
  onAssistantMessage(chatId: ChatId, chat: InterimChat, message: AssistantMessage): void {
    // Dedupe: the session may re-emit the same message (streaming/usage
    // updates); each id is handled exactly once, or interims would send
    // repeatedly and flood the loop buffer.
    const messageId = message.id
    if (messageId !== undefined && chat.lastHandledMessageId === messageId) return
    if (messageId !== undefined) chat.lastHandledMessageId = messageId
    // Host-plane cards (plan review / ask_user_question) never enter the
    // session text stream — the model calls a tool whose arguments carry the
    // content and whose text block is empty, so the `text === ''` early
    // return below would otherwise leave QQ silent. Relay those cards here,
    // before any early return, so the user is never left hanging.
    this.ctx.relayHostCards(chatId, message.content)
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text === '') return
    if (this.ctx.effectiveInterim(chatId)) {
      // The arriving message proves the previously deferred text interim —
      // flush it now, regardless of this message's shape.
      const prior = chat.loopPending
      if (prior !== null) {
        chat.loopPending = null
        this.sendInterim(chatId, chat, prior)
      }
      // A message carrying tool calls can never be the final reply (the
      // model continues after the tool) — send it immediately instead of
      // deferring one step, so QQ receives interims without the one-step
      // lag. Only tool-free text stays deferred until turn/end proves it
      // either interim (next assistant/message) or final.
      const hasToolCall = message.content.some(block => block.type === 'tool-call')
      if (hasToolCall) {
        this.sendInterim(chatId, chat, text)
      } else {
        chat.loopPending = text
      }
    } else {
      chat.pendingFinal = text
    }
  }

  /** The onSessionEvent turn/end interim part: settle the trail when the
   * effective mode is interim, else flush the deferred final. The rest of
   * the branch (error notice, typing, busy, flush) stays bridge-resident. */
  onTurnEnd(chatId: ChatId, chat: InterimChat): void {
    if (this.ctx.effectiveInterim(chatId)) {
      void this.settleLoop(chatId, chat)
    } else if (chat.pendingFinal !== '') {
      const final = chat.pendingFinal
      chat.pendingFinal = ''
      this.ctx.sendToChat(chatId, final, { queuable: true }).catch(error => {
        this.ctx.log('warn', 'final send failed: ' + (error instanceof Error ? error.message : String(error)))
      })
    }
  }

  /** Cancel a message's pending 90s auto-recall timer. */
  private clearInterimTimer(chat: InterimChat, id: string): void {
    const timer = chat.recallTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      chat.recallTimers.delete(id)
    }
  }

  /**
   * Recall the still-on-screen interim originals (turn/end step 2). Ids the
   * 90s timer already revoked during the turn are skipped (already gone).
   * Recall failure is logged only — the summary card still carries the text.
   */
  private async recallLoopMessages(chatId: ChatId, chat: InterimChat, buf: Array<{ id: string; text: string }>): Promise<void> {
    for (const { id } of buf) {
      if (chat.recalledInterimIds.has(id)) continue
      this.clearInterimTimer(chat, id)
      try {
        await this.ctx.call('delete_msg', { message_id: id })
        chat.recalledInterimIds.add(id)
        await new Promise(resolve => setTimeout(resolve, RECALL_SPACING_MS))
      } catch (error) {
        this.ctx.log('debug', 'loop recall delete_msg failed for ' + id + ': ' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }

  /** Fire when an interim's own 90s timer elapses mid-turn: revoke it alone. */
  private revokeInterim(chatId: ChatId, chat: InterimChat, id: string): void {
    chat.recallTimers.delete(id)
    this.ctx.call('delete_msg', { message_id: id }).then(() => {
      chat.recalledInterimIds.add(id)
    }).catch(error => {
      this.ctx.log('debug', 'interim auto-recall failed for ' + id + ': ' + (error instanceof Error ? error.message : String(error)))
    })
  }

  /** Render this turn's interims into one t2i image (summary card, before final). */
  private async sendInterimSummary(chatId: ChatId, buf: Array<{ id: string; text: string }>): Promise<void> {
    const body = buf.map((item, index) => (index + 1) + '. ' + item.text.trim()).filter(line => line !== '').join('\n\n')
    if (body === '') return
    let png: Buffer
    try {
      png = renderTextImage(body, {
        title: '📋 本轮中间记录',
        footerBrand: this.ctx.config.cardFooter,
        fontFiles: this.ctx.config.fontFiles,
        fontFamilies: this.ctx.config.fontFamilies,
      })
    } catch (error) {
      this.ctx.log('warn', 'interim summary t2i failed, sending as text: ' + (error instanceof Error ? error.message : String(error)))
      await this.ctx.sendToChat(chatId, body)
      return
    }
    const b64 = 'base64://' + png.toString('base64')
    if (b64.length <= this.ctx.config.maxImageBytes) {
      await this.ctx.sendMsg(chatId, [{ type: 'image', data: { file: b64 } }], {})
    } else {
      await this.ctx.sendToChat(chatId, body)
    }
  }

  /** Send one interim live and record it: text for the turn/end summary card,
   * plus a per-message auto-recall timer (config interimRecallMs) so long turns
   * clean up their early messages even before the summary arrives. */
  private sendInterim(chatId: ChatId, chat: InterimChat, text: string): void {
    this.ctx.sendToChat(chatId, text).then(ids => {
      const sentAt = Date.now()
      for (const id of ids) {
        chat.loopBuffer.push({ id, text, sentAt })
        const delay = this.ctx.config.interimRecallMs ?? 90_000
        const timer = setTimeout(() => this.revokeInterim(chatId, chat, id), delay)
        chat.recallTimers.set(id, timer)
      }
    }).catch(error => {
      this.ctx.log('warn', 'interim send failed: ' + (error instanceof Error ? error.message : String(error)))
    })
  }

  /**
   * Settle a finished turn's interim trail (interimMessages on): drain the send
   * chain so every interim id is recorded, then render ONE t2i summary card of
   * all interims, immediately recall the still-on-screen originals, and finally
   * send the deferred final text. No merged-forward any more — QQ refuses to
   * recall messages older than ~2 min, and a forward of aged interims would
   * leave the originals plus a duplicate card, so interims are surfaced live
   * and auto-revoked per message (90s) during long turns.
   */
  private async settleLoop(chatId: ChatId, chat: InterimChat): Promise<void> {
    try {
      await this.ctx.chainTail(chatId)
    } catch {
      // failures already settle the enqueue chain; keep going
    }
    const buf = chat.loopBuffer
    chat.loopBuffer = []
    if (buf.length >= 1) {
      try {
        await this.sendInterimSummary(chatId, buf)
      } catch (error) {
        this.ctx.log('warn', 'interim summary send failed: ' + (error instanceof Error ? error.message : String(error)))
      }
      try {
        await this.recallLoopMessages(chatId, chat, buf)
      } catch (error) {
        this.ctx.log('warn', 'loop recall failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    if (chat.loopPending !== null) {
      const final = chat.loopPending
      chat.loopPending = null
      try {
        await this.ctx.sendToChat(chatId, final, { queuable: true })
      } catch (error) {
        this.ctx.log('warn', 'final send failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }
}
