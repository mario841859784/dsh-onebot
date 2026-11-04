/**
 * Deferred delivery（T3/P2 超时后结果补发）：等待模型回复超时后不放弃回合——
 * 把仍在运行的回合登记进补发注册表（chatId/sessionId/traceId/超时时刻），
 * 继续监听该会话的 assistant/message（静音捕获最终文字，不再插播 interim/
 * 交互卡片）与 turn/end（兑现补发）；完成后向原聊天补发最终文字
 * （「（超时补发）」前缀，走既有 outbound 管线的分段/t2i 规则）。
 *
 * 语义对齐 dsh-im「超时后的结果补发」（research/dsh-im-readme-fetched.md
 * L91-95）：
 * - 发送明确失败最多尝试 3 次（退避 2s/10s）；OneBot 动作超时或非网关错误
 *   视为「结果不确定」（消息可能已到达 QQ），保留记录并停止自动重试防重复。
 * - 注册表逐行 JSONL 落盘 mediaDir（deferred-delivery.jsonl），写纪律对齐
 *   registry.ts：唯一 tmp 后缀 + rename 原子写、逐行损坏降级（坏行跳过不炸
 *   宿主）、文件缺失 = 全新启动。插件启动加载未完结条目恢复跟踪（该会话的
 *   下一次 turn/end 兑现补发；/stop 显式终止该聊天的跟踪）。
 * - 边界：只补最终文字与终态通知——不重放审批/提问卡/文件工具调用/图片；
 *   回合正常完成（未超时）零注册表写入、零补发（对基线无行为差异面）。
 *
 * 时钟与定时器经构造器注入（vitest 时序纪律：假时钟注入 + vi.waitFor 文本
 * 确定性等待），默认回落到全局 setTimeout/Date.now。
 * @module dsh-onebot/deferred
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TRACE_REASONS } from './trace.js';
import { OneBotActionError, OneBotNotConnectedError } from './connection.js';
import { describeError } from './errors.js';
import { failureRefSuffix } from './ref.js';
import { resolveNoticeText } from './notices.js';
/** The registry file name inside the media dir (one JSON entry per line). */
export const DEFERRED_REGISTRY_FILE = 'deferred-delivery.jsonl';
/** Default wait-for-model-reply timeout (ms): conservative 10 minutes. */
export const DEFAULT_DEFERRED_TIMEOUT_MS = 600_000;
/** Max total send attempts per entry（含首次；第 4 次永不尝试）。 */
export const DEFERRED_MAX_SEND_ATTEMPTS = 3;
/** Backoff before retry attempts 2 and 3 (ms). */
export const DEFERRED_RETRY_BACKOFF_MS = [2_000, 10_000];
/** Cap of tracked entries; the oldest terminal entries are pruned beyond it. */
export const DEFERRED_MAX_ENTRIES = 200;
/** Pending entries older than this are auto-cancelled at load（宿主进程级
 * 重启后原回合已不存在，超过该时长仍未兑现的条目视为死回合）。 */
export const DEFERRED_PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The「（超时补发）」prefix prepended to every deferred delivery. */
export const DEFERRED_PREFIX = '（超时补发）\n';
/** Send-failure classification: 'retryable' = the message definitively did
 * NOT reach QQ（断连 / 网关明确拒绝）→ bounded retry; 'uncertain' = the
 * action timed out or failed outside the gateway — the message may still
 * have arrived, so the record is kept and auto-retry stops（防重复消息）. */
export function classifySendError(error) {
    if (error instanceof OneBotNotConnectedError)
        return 'retryable';
    if (error instanceof OneBotActionError) {
        return /timed out/i.test(error.message) ? 'uncertain' : 'retryable';
    }
    return 'uncertain';
}
/** Text-only extraction（不重放媒体/工具调用/卡片：只取 text 块）。 */
function textOnly(message) {
    try {
        return (message.content ?? [])
            .filter(block => block.type === 'text')
            .map(block => block.text ?? '')
            .join('');
    }
    catch {
        return '';
    }
}
/** Build the deferred delivery text for a finished turn. T4 (P3): an error
 * ending carries the turn's MF- reference so the补发 terminal notice and the
 * trace/log/healthcheck surfaces share one number. */
export function buildDeferredText(entry, reason) {
    if (reason?.kind === 'error') {
        return DEFERRED_PREFIX + '任务已结束：运行出错：' + (reason.error?.message ?? '未知错误') + failureRefSuffix(entry.ref);
    }
    const text = (entry.resultText ?? '').trim();
    if (text === '')
        return DEFERRED_PREFIX + '任务已完成，但没有产生文字结果。';
    return DEFERRED_PREFIX + text;
}
/** Strict-ish loader validation: a line that is not a usable entry is skipped
 * （损坏降级）instead of failing the whole file. */
function sanitizeEntry(raw) {
    if (raw === null || typeof raw !== 'object')
        return null;
    const rec = raw;
    if (typeof rec.chatId !== 'string' || rec.chatId === '')
        return null;
    if (typeof rec.sessionId !== 'string' || rec.sessionId === '')
        return null;
    const states = ['pending', 'delivered', 'failed', 'uncertain', 'cancelled'];
    if (typeof rec.state !== 'string' || !states.includes(rec.state))
        return null;
    const registeredAt = typeof rec.registeredAt === 'number' && Number.isFinite(rec.registeredAt) ? rec.registeredAt : 0;
    const updatedAt = typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : registeredAt;
    const entry = {
        chatId: rec.chatId,
        sessionId: rec.sessionId,
        registeredAt,
        updatedAt,
        attempts: typeof rec.attempts === 'number' && Number.isFinite(rec.attempts) ? rec.attempts : 0,
        state: rec.state,
    };
    if (typeof rec.traceId === 'string' && rec.traceId !== '')
        entry.traceId = rec.traceId;
    if (typeof rec.ref === 'string' && rec.ref !== '')
        entry.ref = rec.ref;
    if (typeof rec.reason === 'string' && rec.reason !== '')
        entry.reason = rec.reason;
    if (typeof rec.resultText === 'string' && rec.resultText !== '')
        entry.resultText = rec.resultText;
    return entry;
}
/**
 * The deferred-delivery tracker: timeout timers, the JSONL registry, bounded
 * send retries and the restart-recovery load. Created by the ChatBridge
 * constructor; the bridge feeds it session events and the /stop command
 * cancels a chat's tracking.
 */
export class DeferredDelivery {
    ctx;
    now;
    scheduleFn;
    cancelFn;
    /** Tracked entries by session id（一个会话同一时刻至多一个运行回合）。 */
    entries = new Map();
    /** Per-session silent-wait timers（每次模型输出重置；turn/end 解除）。 */
    timers = new Map();
    /** Serialized registry-write chain（并发 save 不交错）。 */
    saveChain = Promise.resolve();
    /** Session ids with a delivery loop in flight（防双发 in-flight 守卫：
     * 重试退避窗口内新回合 turn/end 不得再起第二条重试循环）。 */
    delivering = new Set();
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        this.now = options.now ?? (() => Date.now());
        this.scheduleFn = options.schedule ?? ((fn, ms) => setTimeout(fn, ms).unref());
        this.cancelFn = options.cancel ?? (handle => clearTimeout(handle));
    }
    // ------------------------------------------------------------ turn wiring
    /** turn/start: arm (or re-arm) the silent-wait window for the session.
     * A session with a pending entry（重启恢复的跟踪中会话）does not re-arm —
     * its next turn/end redeems the entry. */
    onTurnStart(chatId, sessionId) {
        this.clearTimer(sessionId);
        if (this.ctx.timeoutMs <= 0)
            return;
        const entry = this.entries.get(sessionId);
        if (entry !== undefined && entry.state === 'pending')
            return;
        this.armTimer(chatId, sessionId);
    }
    /** assistant/message: returns true when the message is consumed by deferred
     * tracking（静音：不插播 interim、不转卡片，只捕获 text 块作为最终文字）。
     * Otherwise resets the silent-wait window（模型有输出 = 用户并非在干等）。 */
    onAssistantMessage(chatId, sessionId, message) {
        const entry = this.entries.get(sessionId);
        if (entry !== undefined && entry.state === 'pending') {
            const text = textOnly(message).trim();
            if (text !== '')
                entry.resultText = text;
            return true;
        }
        if (this.ctx.timeoutMs > 0 && this.timers.has(sessionId)) {
            this.armTimer(chatId, sessionId);
        }
        return false;
    }
    /** turn/end: cancel the silent-wait timer; complete a pending entry by
     * delivering the final text (async, bounded retries). `ref` is the turn's
     * fault reference（T4：bridge 在错误回合 mint 的 MF- 号——终态补发文本与
     * trace 携带同号；正常回合为 undefined）. Returns true when
     * the turn was under deferred tracking AND its ending is success-class
     * （bridge 据此抑制常规错误通知——终态通知由补发通道送达，避免同一故障
     * 双消息）。两类例外一律返回 false、错误照常走基线 ⚠️ 通知（不静默吞
     * 掉）：terminal entries（delivered/failed/uncertain/cancelled，只是可
     * 观测快照）；以及 in-flight 让位路径上的错误/取消类收尾——在途补发循环
     * 只持有回合 A 的 text 副本，回合 B 的错误 reason 不会被它送达。 */
    onTurnEnd(chatId, sessionId, reason, ref) {
        this.clearTimer(sessionId);
        const entry = this.entries.get(sessionId);
        if (entry === undefined)
            return false;
        if (entry.state !== 'pending')
            return false;
        if (ref !== undefined)
            entry.ref = ref;
        if (this.delivering.has(sessionId)) {
            // 防双发 in-flight 守卫：首发失败后的重试退避窗口内同会话新回合收尾，
            // 让位给在途补发循环——只刷新时间戳（新回合的文字已由
            // onAssistantMessage 捕获进 resultText），不并发启动第二条重试循环
            // （否则同一 entry 双发、attempts/终态互相覆写）。
            // 但 tracked=true 只维持给成功类收尾：错误/取消类收尾返回 false，让
            // bridge 照常发 ⚠️——在途循环补发的是回合 A 收尾时就已构建的 text
            // 副本，回合 B 的错误 reason 不会被它送达，绝不能静默吞掉（不变式：
            // 任何错误回合的 ⚠️ 通知必须可见）。
            entry.updatedAt = this.now();
            return reason === undefined || reason.kind === 'completed';
        }
        const text = buildDeferredText(entry, reason);
        entry.updatedAt = this.now();
        void this.deliverWithRetry(entry, text);
        return true;
    }
    /** /stop：显式终止该聊天的补发跟踪（pending 条目转 cancelled、计时器解除）；
     * 其他聊天不受影响。无运行中生成时也安全（清理陈旧条目）。 */
    cancelChat(chatId) {
        for (const [sessionId, timer] of [...this.timers]) {
            if (timer.chatId === chatId)
                this.clearTimer(sessionId);
        }
        let changed = false;
        for (const entry of this.entries.values()) {
            if (entry.chatId !== chatId || entry.state !== 'pending')
                continue;
            entry.state = 'cancelled';
            entry.reason = '用户已停止该聊天的生成（/stop），补发跟踪终止';
            entry.updatedAt = this.now();
            this.ctx.trace?.(chatId, { stage: 'notice', ok: true, reason: TRACE_REASONS.deferredCancelled, data: { sessionId: entry.sessionId } });
            changed = true;
        }
        if (changed) {
            this.ctx.log('info', '已终止该聊天的超时补发跟踪: ' + chatId);
            void this.save();
        }
    }
    /** Plugin stop: disarm every timer; entries stay as-is（pending 条目已
     * 落盘，重启后恢复跟踪）。 */
    stopAll() {
        for (const sessionId of [...this.timers.keys()])
            this.clearTimer(sessionId);
    }
    // ------------------------------------------------------------ timeout
    armTimer(chatId, sessionId) {
        this.clearTimer(sessionId);
        const record = { chatId, handle: undefined, cancelled: false };
        record.handle = this.scheduleFn(() => {
            if (record.cancelled)
                return;
            this.timers.delete(sessionId);
            this.onTimeout(chatId, sessionId);
        }, this.ctx.timeoutMs);
        if (!record.cancelled)
            this.timers.set(sessionId, record);
    }
    clearTimer(sessionId) {
        const timer = this.timers.get(sessionId);
        if (timer === undefined)
            return;
        timer.cancelled = true;
        this.cancelFn(timer.handle);
        this.timers.delete(sessionId);
    }
    /** The silent window elapsed while the turn is still running: register the
     * entry, tell the chat, and mute the turn（takePendingText 清空 loopPending，
     * 正常终局路径不再有内容可刷）。 */
    onTimeout(chatId, sessionId) {
        if (this.ctx.isStopping())
            return;
        if (this.entries.get(sessionId)?.state === 'pending')
            return;
        if (!this.ctx.isTurnRunning(chatId))
            return;
        const at = this.now();
        const entry = {
            chatId,
            sessionId,
            registeredAt: at,
            updatedAt: at,
            attempts: 0,
            state: 'pending',
        };
        const traceId = this.ctx.traceIdFor?.(chatId);
        if (traceId !== undefined)
            entry.traceId = traceId;
        const pending = this.ctx.takePendingText(chatId);
        if (pending !== null && pending.trim() !== '')
            entry.resultText = pending;
        this.entries.set(sessionId, entry);
        this.prune();
        void this.save();
        this.ctx.log('info', '等待模型回复超时，已登记超时补发跟踪: chat=' + chatId + ' session=' + sessionId);
        this.ctx.trace?.(chatId, { stage: 'notice', ok: true, reason: TRACE_REASONS.deferredRegistered, data: { sessionId } });
        const seconds = Math.round(this.ctx.timeoutMs / 1000);
        // T1 (#27): notices.deferredTimeout — false/'' = 不发，非空 string =
        // 自定义文案，true/缺省 = 默认文案（0.9.x 行为不变）。
        const notice = resolveNoticeText(this.ctx.notices?.deferredTimeout, '⏳ 等待模型回复超时（已静默等待约 ' + seconds + ' 秒），任务仍在后台运行；完成后将自动补发最终结果。如需停止请发送 /stop。');
        if (notice === null)
            return;
        void this.ctx.sendToChat(chatId, notice, { queuable: true }).catch((error) => {
            this.ctx.log('debug', '超时提醒发送失败: ' + describeError(error));
            this.ctx.trace?.(chatId, { stage: 'notice', ok: false, reason: TRACE_REASONS.deferredNoticeFailed + ': ' + describeError(error) });
        });
    }
    // ------------------------------------------------------------ delivery
    async deliverWithRetry(entry, text) {
        this.delivering.add(entry.sessionId);
        try {
            for (let attempt = 1; attempt <= DEFERRED_MAX_SEND_ATTEMPTS; attempt += 1) {
                if (this.ctx.isStopping())
                    return; // 条目保持 pending：重启后恢复跟踪续投
                entry.attempts = attempt;
                try {
                    await this.ctx.sendToChat(entry.chatId, text, {});
                }
                catch (error) {
                    const described = describeError(error);
                    if (classifySendError(error) === 'uncertain') {
                        entry.state = 'uncertain';
                        entry.reason = '发送结果不确定（' + described + '），已保留记录并停止自动重试，避免重复消息';
                        entry.updatedAt = this.now();
                        this.ctx.log('warn', '超时补发第 ' + attempt + ' 次发送结果不确定，停止自动重试: chat=' + entry.chatId + ' ' + described);
                        this.ctx.trace?.(entry.chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.deferredUncertain + ': ' + described, data: { sessionId: entry.sessionId, attempt, ...(entry.ref !== undefined ? { ref: entry.ref } : {}) } });
                        void this.save();
                        return;
                    }
                    if (attempt < DEFERRED_MAX_SEND_ATTEMPTS) {
                        const backoff = DEFERRED_RETRY_BACKOFF_MS[attempt - 1] ?? DEFERRED_RETRY_BACKOFF_MS[DEFERRED_RETRY_BACKOFF_MS.length - 1] ?? 10_000;
                        this.ctx.log('debug', '超时补发第 ' + attempt + ' 次发送明确失败，' + Math.round(backoff / 1000) + 's 后重试: ' + described);
                        this.ctx.trace?.(entry.chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.deferredRetryable + '（第 ' + attempt + '/' + DEFERRED_MAX_SEND_ATTEMPTS + ' 次）: ' + described, data: { sessionId: entry.sessionId, attempt, ...(entry.ref !== undefined ? { ref: entry.ref } : {}) } });
                        await this.sleep(backoff);
                        continue;
                    }
                    entry.state = 'failed';
                    entry.reason = '发送明确失败，已尝试 ' + DEFERRED_MAX_SEND_ATTEMPTS + ' 次（最后错误: ' + described + '）';
                    entry.updatedAt = this.now();
                    this.ctx.log('warn', '超时补发连续 ' + DEFERRED_MAX_SEND_ATTEMPTS + ' 次发送失败，停止自动重试: chat=' + entry.chatId + ' ' + described);
                    this.ctx.trace?.(entry.chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.deferredExhausted + ': ' + described, data: { sessionId: entry.sessionId, attempt, ...(entry.ref !== undefined ? { ref: entry.ref } : {}) } });
                    void this.save();
                    return;
                }
                entry.state = 'delivered';
                entry.reason = '超时补发已送达';
                entry.updatedAt = this.now();
                this.ctx.log('info', '超时补发已送达: chat=' + entry.chatId + ' session=' + entry.sessionId);
                this.ctx.trace?.(entry.chatId, { stage: 'queue', ok: true, reason: TRACE_REASONS.deferredDelivered, data: { sessionId: entry.sessionId, attempt } });
                void this.save();
                return;
            }
        }
        finally {
            this.delivering.delete(entry.sessionId);
        }
    }
    sleep(ms) {
        return new Promise(resolve => {
            this.scheduleFn(() => resolve(), ms);
        });
    }
    // ------------------------------------------------------------ registry
    /** Prune the oldest terminal entries beyond the cap（pending 永不裁剪）。 */
    prune() {
        if (this.entries.size <= DEFERRED_MAX_ENTRIES)
            return;
        const terminal = [...this.entries.values()]
            .filter(entry => entry.state !== 'pending')
            .sort((a, b) => a.updatedAt - b.updatedAt);
        for (const entry of terminal) {
            if (this.entries.size <= DEFERRED_MAX_ENTRIES)
                break;
            this.entries.delete(entry.sessionId);
        }
    }
    registryPath() {
        return join(this.ctx.mediaDir, DEFERRED_REGISTRY_FILE);
    }
    /** Atomic full rewrite（唯一 tmp 后缀 + rename，对齐 registry.ts 纪律）。 */
    save() {
        const run = this.saveChain.then(async () => {
            if (this.ctx.mediaDir === '')
                return;
            await mkdir(this.ctx.mediaDir, { recursive: true });
            const lines = [...this.entries.values()].map(entry => JSON.stringify(entry));
            const tmpPath = this.registryPath() + '.tmp-' + this.now() + '-' + Math.random().toString(36).slice(2, 8);
            await writeFile(tmpPath, lines.length === 0 ? '' : lines.join('\n') + '\n', 'utf8');
            await rename(tmpPath, this.registryPath());
        });
        this.saveChain = run.catch(() => undefined);
        return run.catch(error => {
            this.ctx.log('warn', '超时补发注册表写入失败: ' + describeError(error));
        });
    }
    /** Startup recovery: load every persisted entry; pending ones resume
     * tracking（该会话的下一次 turn/end 兑现）。Per-line corrupt degrade:
     * 坏行跳过并告警，其余条目照常恢复；文件缺失 = 全新启动。 */
    async loadPersisted() {
        let content;
        try {
            content = await readFile(this.registryPath(), 'utf8');
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                this.ctx.log('warn', '超时补发注册表读取失败；按空注册表继续: ' + describeError(error));
            }
            return;
        }
        let restored = 0;
        let skipped = 0;
        let pending = 0;
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed === '')
                continue;
            try {
                const entry = sanitizeEntry(JSON.parse(trimmed));
                if (entry === null) {
                    skipped += 1;
                    continue;
                }
                if (entry.state === 'pending' && this.now() - entry.registeredAt > DEFERRED_PENDING_MAX_AGE_MS) {
                    entry.state = 'cancelled';
                    entry.reason = '补发跟踪超过 24 小时未兑现（原回合已随上次进程结束），自动终止';
                    entry.updatedAt = this.now();
                }
                if (entry.state === 'pending')
                    pending += 1;
                this.entries.set(entry.sessionId, entry);
                restored += 1;
            }
            catch {
                skipped += 1;
            }
        }
        if (skipped > 0) {
            this.ctx.log('warn', '超时补发注册表有 ' + skipped + ' 行损坏，已跳过（损坏降级，不影响其余条目）');
        }
        if (restored > 0) {
            this.ctx.log('info', '已恢复 ' + restored + ' 条超时补发跟踪（其中 ' + pending + ' 条等待兑现）');
            void this.save();
        }
    }
    /** Test/diagnostic snapshot: the live entries (registry order). */
    snapshot() {
        return [...this.entries.values()];
    }
}
