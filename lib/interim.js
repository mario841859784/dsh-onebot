import { renderTextImage } from './t2i/index.js';
/** Spacing between recall delete_msg calls (NapCat recallMsg is slow; bursting
 * them pushes borderline-late recalls over the server timeout). */
const RECALL_SPACING_MS = 60;
/**
 * The interim tracker: one per bridge, operating on the per-chat state through
 * InterimChat. The methods keep receiving chatId + chat exactly as their
 * pre-split bridge signatures did.
 */
export class InterimTracker {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
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
    onTurnStart(chat) {
        chat.recalledInterimIds.clear();
    }
    /** The onSessionEvent assistant/message branch: dedupe, host-card relay,
     * then the interim/deferred routing. Verbatim from the pre-split bridge. */
    onAssistantMessage(chatId, chat, message) {
        // Dedupe: the session may re-emit the same message (streaming/usage
        // updates); each id is handled exactly once, or interims would send
        // repeatedly and flood the loop buffer.
        const messageId = message.id;
        if (messageId !== undefined && chat.lastHandledMessageId === messageId)
            return;
        if (messageId !== undefined)
            chat.lastHandledMessageId = messageId;
        // Host-plane cards (plan review / ask_user_question) never enter the
        // session text stream — the model calls a tool whose arguments carry the
        // content and whose text block is empty, so the `text === ''` early
        // return below would otherwise leave QQ silent. Relay those cards here,
        // before any early return, so the user is never left hanging.
        this.ctx.relayHostCards(chatId, message.content);
        const text = message.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('');
        if (text === '')
            return;
        if (this.ctx.effectiveInterim(chatId)) {
            // The arriving message proves the previously deferred text interim —
            // flush it now, regardless of this message's shape.
            const prior = chat.loopPending;
            if (prior !== null) {
                chat.loopPending = null;
                this.sendInterim(chatId, chat, prior);
            }
            // A message carrying tool calls can never be the final reply (the
            // model continues after the tool) — send it immediately instead of
            // deferring one step, so QQ receives interims without the one-step
            // lag. Only tool-free text stays deferred until turn/end proves it
            // either interim (next assistant/message) or final.
            const hasToolCall = message.content.some(block => block.type === 'tool-call');
            if (hasToolCall) {
                this.sendInterim(chatId, chat, text);
            }
            else {
                chat.loopPending = text;
            }
        }
        else {
            chat.pendingFinal = text;
        }
    }
    /** The onSessionEvent turn/end interim part: settle the trail when the
     * effective mode is interim, else flush the deferred final. The rest of
     * the branch (error notice, typing, busy, flush) stays bridge-resident. */
    onTurnEnd(chatId, chat) {
        if (this.ctx.effectiveInterim(chatId)) {
            void this.settleLoop(chatId, chat);
        }
        else if (chat.pendingFinal !== '') {
            const final = chat.pendingFinal;
            chat.pendingFinal = '';
            this.ctx.sendToChat(chatId, final, { queuable: true }).catch(error => {
                this.ctx.log('warn', 'final send failed: ' + (error instanceof Error ? error.message : String(error)));
            });
        }
    }
    /** Cancel a message's pending 90s auto-recall timer. */
    clearInterimTimer(chat, id) {
        const timer = chat.recallTimers.get(id);
        if (timer !== undefined) {
            clearTimeout(timer);
            chat.recallTimers.delete(id);
        }
    }
    /**
     * Recall the still-on-screen interim originals (turn/end step 2). Ids the
     * 90s timer already revoked during the turn are skipped (already gone).
     * Recall failure is logged only — the summary card still carries the text.
     */
    async recallLoopMessages(chatId, chat, buf) {
        for (const { id } of buf) {
            if (chat.recalledInterimIds.has(id))
                continue;
            this.clearInterimTimer(chat, id);
            try {
                await this.ctx.call('delete_msg', { message_id: id });
                chat.recalledInterimIds.add(id);
                await new Promise(resolve => setTimeout(resolve, RECALL_SPACING_MS));
            }
            catch (error) {
                this.ctx.log('debug', 'loop recall delete_msg failed for ' + id + ': ' + (error instanceof Error ? error.message : String(error)));
            }
        }
    }
    /** Fire when an interim's own 90s timer elapses mid-turn: revoke it alone. */
    revokeInterim(chatId, chat, id) {
        chat.recallTimers.delete(id);
        this.ctx.call('delete_msg', { message_id: id }).then(() => {
            chat.recalledInterimIds.add(id);
        }).catch(error => {
            this.ctx.log('debug', 'interim auto-recall failed for ' + id + ': ' + (error instanceof Error ? error.message : String(error)));
        });
    }
    /** Render this turn's interims into one t2i image (summary card, before final). */
    async sendInterimSummary(chatId, buf) {
        const body = buf.map((item, index) => (index + 1) + '. ' + item.text.trim()).filter(line => line !== '').join('\n\n');
        if (body === '')
            return;
        let png;
        try {
            png = renderTextImage(body, {
                title: '📋 本轮中间记录',
                footerBrand: this.ctx.config.cardFooter,
                fontFiles: this.ctx.config.fontFiles,
                fontFamilies: this.ctx.config.fontFamilies,
            });
        }
        catch (error) {
            this.ctx.log('warn', 'interim summary t2i failed, sending as text: ' + (error instanceof Error ? error.message : String(error)));
            await this.ctx.sendToChat(chatId, body);
            return;
        }
        const b64 = 'base64://' + png.toString('base64');
        if (b64.length <= this.ctx.config.maxImageBytes) {
            await this.ctx.sendMsg(chatId, [{ type: 'image', data: { file: b64 } }], {});
        }
        else {
            await this.ctx.sendToChat(chatId, body);
        }
    }
    /** Send one interim live and record it: text for the turn/end summary card,
     * plus a per-message auto-recall timer (config interimRecallMs) so long turns
     * clean up their early messages even before the summary arrives. */
    sendInterim(chatId, chat, text) {
        this.ctx.sendToChat(chatId, text).then(ids => {
            const sentAt = Date.now();
            for (const id of ids) {
                chat.loopBuffer.push({ id, text, sentAt });
                const delay = this.ctx.config.interimRecallMs ?? 90_000;
                const timer = setTimeout(() => this.revokeInterim(chatId, chat, id), delay);
                chat.recallTimers.set(id, timer);
            }
        }).catch(error => {
            this.ctx.log('warn', 'interim send failed: ' + (error instanceof Error ? error.message : String(error)));
        });
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
    async settleLoop(chatId, chat) {
        try {
            await this.ctx.chainTail(chatId);
        }
        catch {
            // failures already settle the enqueue chain; keep going
        }
        const buf = chat.loopBuffer;
        chat.loopBuffer = [];
        if (buf.length >= 1) {
            try {
                await this.sendInterimSummary(chatId, buf);
            }
            catch (error) {
                this.ctx.log('warn', 'interim summary send failed: ' + (error instanceof Error ? error.message : String(error)));
            }
            try {
                await this.recallLoopMessages(chatId, chat, buf);
            }
            catch (error) {
                this.ctx.log('warn', 'loop recall failed: ' + (error instanceof Error ? error.message : String(error)));
            }
        }
        if (chat.loopPending !== null) {
            const final = chat.loopPending;
            chat.loopPending = null;
            try {
                await this.ctx.sendToChat(chatId, final, { queuable: true });
            }
            catch (error) {
                this.ctx.log('warn', 'final send failed: ' + (error instanceof Error ? error.message : String(error)));
            }
        }
    }
}
