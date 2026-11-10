/**
 * 入站调度：排队 + 连发合并（T7 PR port，源自贡献者 lib/local/inbound-queue.js，
 * 逐行对齐移植为 TypeScript；常量、窗口算法、丢弃与日志文案保持贡献者原样）。
 *
 * 治两个毛病（贡献者审计第 4/11 条）：
 *   串序 —— 原来同一个会话的消息完全不排队。带图那条要下载解析，比纯文字慢，
 *           所以「先发图、再发文字」，它先答后一句、再答前一句。现在每个
 *           会话一条串行链。
 *   碎   —— 连发三条短消息就是三个回合、三句回复，理解不成一整句话。现在
 *           同会话紧挨着的几条并成一条投递：最后一条进来后等 MERGE_WINDOW_MS，
 *           但从第一条算起最多等 MERGE_MAX_WAIT_MS。
 *
 * 用法（见 src/bridge.ts 接线）：
 *   const q = new InboundScheduler({ log, deliver, injectDeliver });
 *   await q.push(event);                    // 普通消息（会合并）
 *   await q.push(event, { injected:true }); // 注入轮（不排队不合并，直接串行）
 *   q.stop();                               // 关闭时清定时器、放行所有等待者
 *
 * 本模块整体由 inboxQueueEnabled 开关控制（默认关）：关闭时 bridge 走既有
 * 路径，与上游逐字节等价；本文件不触碰网络行为与退避参数。
 * @module dsh-onebot/inbound-queue
 */
/** 全局待处理上限：超过就丢一条并记 warn。 */
export const INBOUND_MAX_PENDING = 50;
/** 连发合并窗口——最后一条进来后等这么久。 */
export const INBOUND_MERGE_WINDOW_MS = 600;
/** 从第一条算起最多等这么久，超了不再等。 */
export const INBOUND_MERGE_MAX_WAIT_MS = 3000;
/** 把同一会话里紧挨着的几条并成一条：段的顺序保持原样，id/时间取最后一条
 *  （T7 口径：合并后的合成消息 mid = 最后一条的 message_id，与 review-t2.md
 *  的 <user_message mid=…> 语义衔接——模型 [[reply:]] 引用的是最后一句）。 */
export function mergeInboundEvents(events) {
    const first = events[0];
    const last = events[events.length - 1];
    const message = [];
    const raws = [];
    for (const event of events) {
        if (Array.isArray(event.message))
            message.push(...event.message);
        else if (typeof event.message === 'string')
            message.push({ type: 'text', data: { text: event.message } });
        raws.push(typeof event.raw_message === 'string' ? event.raw_message : '');
    }
    return {
        ...first,
        message,
        raw_message: raws.join('\n'),
        message_id: last.message_id,
        time: last.time,
    };
}
/** 排队用的会话键。拿不到会话就归到 other，至少保证同一批 unknown 也是串行的。 */
export function inboundChatKey(event) {
    const type = event?.message_type;
    if (type === 'private')
        return 'private:' + String(event?.user_id ?? '');
    if (type === 'group')
        return 'group:' + String(event?.group_id ?? '');
    return 'other';
}
/** 斜杠命令不合并：命令要一条一条按原样执行。 */
export function isCommandText(event) {
    const segs = Array.isArray(event?.message) ? event?.message : [];
    const text = segs
        .filter(seg => seg?.type === 'text')
        .map(seg => String(seg.data?.text ?? ''))
        .join('')
        .trim();
    return text.startsWith('/');
}
export class InboundScheduler {
    log;
    deliver;
    injectDeliver;
    maxPending;
    mergeWindowMs;
    mergeMaxWaitMs;
    /** 每会话串行链：key → 链尾 promise。 */
    chains = new Map();
    /** 全局待处理计数（含合并槽里未投递的）。 */
    pending = 0;
    /** 每会话合并槽。 */
    slots = new Map();
    constructor(options) {
        this.log = options.log;
        this.deliver = options.deliver;
        this.injectDeliver = options.injectDeliver ?? options.deliver;
        this.maxPending = options.maxPending ?? INBOUND_MAX_PENDING;
        this.mergeWindowMs = options.mergeWindowMs ?? INBOUND_MERGE_WINDOW_MS;
        this.mergeMaxWaitMs = options.mergeMaxWaitMs ?? INBOUND_MERGE_MAX_WAIT_MS;
    }
    /**
     * 投一条消息进来。注入轮不排队也不合并，直接串进本会话的链里跑；
     * 其余走连发合并（斜杠命令除外，命令一条一条按原样执行）。
     */
    push(event, opts = {}) {
        if (opts.injected === true) {
            return this.enqueue(inboundChatKey(event), () => this.injectDeliver(event));
        }
        if (isCommandText(event)) {
            return this.enqueue(inboundChatKey(event), () => this.deliver(event));
        }
        const key = inboundChatKey(event);
        let slot = this.slots.get(key);
        if (slot === undefined) {
            slot = { events: [], waiters: [], timer: undefined, firstAt: Date.now() };
            this.slots.set(key, slot);
        }
        slot.events.push(event);
        const done = new Promise(resolve => {
            slot.waiters.push(resolve);
        });
        if (slot.timer !== undefined)
            clearTimeout(slot.timer);
        const elapsed = Date.now() - slot.firstAt;
        const wait = Math.max(0, Math.min(this.mergeWindowMs, this.mergeMaxWaitMs - elapsed));
        slot.timer = setTimeout(() => this.flush(key), wait);
        return done;
    }
    /** 把一条投进它所属会话的串行链；全局积压超过上限就丢并记 warn。 */
    enqueue(key, run) {
        if (this.pending >= this.maxPending) {
            this.log('warn', '入站队列已满(' + String(this.maxPending) + ')，丢弃一条: ' + key);
            return Promise.resolve();
        }
        this.pending += 1;
        const prev = this.chains.get(key) ?? Promise.resolve();
        const next = prev
            .catch(() => undefined)
            .then(run)
            .catch((error) => {
            const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
            this.log('error', 'inbound handling failed: ' + detail);
        })
            .finally(() => {
            this.pending -= 1;
            if (this.chains.get(key) === next)
                this.chains.delete(key);
        });
        this.chains.set(key, next);
        return next;
    }
    /** 把攒着的几条并成一条投出去，然后放行所有等着的调用方。 */
    flush(key) {
        const slot = this.slots.get(key);
        if (slot === undefined)
            return;
        this.slots.delete(key);
        if (slot.timer !== undefined)
            clearTimeout(slot.timer);
        const merged = slot.events.length === 1 ? slot.events[0] : mergeInboundEvents(slot.events);
        const waiters = slot.waiters;
        slot.waiters = [];
        const task = this.enqueue(key, () => this.deliver(merged));
        void task.then(() => {
            for (const resolve of waiters)
                resolve();
        });
    }
    /** 关闭：清掉所有合并定时器并放行等待者，别在关闭途中再投递。 */
    stop() {
        for (const slot of this.slots.values()) {
            if (slot.timer !== undefined)
                clearTimeout(slot.timer);
            for (const resolve of slot.waiters)
                resolve();
        }
        this.slots.clear();
    }
}
