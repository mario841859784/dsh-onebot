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
import type { OneBotEvent } from './connection.js';
/** 全局待处理上限：超过就丢一条并记 warn。 */
export declare const INBOUND_MAX_PENDING = 50;
/** 连发合并窗口——最后一条进来后等这么久。 */
export declare const INBOUND_MERGE_WINDOW_MS = 600;
/** 从第一条算起最多等这么久，超了不再等。 */
export declare const INBOUND_MERGE_MAX_WAIT_MS = 3000;
/** 把同一会话里紧挨着的几条并成一条：段的顺序保持原样，id/时间取最后一条
 *  （T7 口径：合并后的合成消息 mid = 最后一条的 message_id，与 review-t2.md
 *  的 <user_message mid=…> 语义衔接——模型 [[reply:]] 引用的是最后一句）。 */
export declare function mergeInboundEvents(events: readonly OneBotEvent[]): OneBotEvent;
/** 排队用的会话键。拿不到会话就归到 other，至少保证同一批 unknown 也是串行的。 */
export declare function inboundChatKey(event: OneBotEvent | undefined): string;
/** 斜杠命令不合并：命令要一条一条按原样执行。 */
export declare function isCommandText(event: OneBotEvent | undefined): boolean;
export interface InboundSchedulerOptions {
    /** (level, message) 日志出口（bridge 侧接 deps.log）。 */
    log: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
    /** 普通消息投递（合并后的合成消息也走这里）。 */
    deliver: (event: OneBotEvent) => Promise<void>;
    /** 注入轮投递（absent = 注入也走 deliver）。 */
    injectDeliver?: ((event: OneBotEvent) => Promise<void>) | undefined;
    /** 全局待处理上限（缺省 INBOUND_MAX_PENDING；测试可调小）。 */
    maxPending?: number;
    /** 合并窗口毫秒数（缺省 INBOUND_MERGE_WINDOW_MS；接线 inboxQueueDelayMs）。 */
    mergeWindowMs?: number;
    /** 首条起最长等待毫秒数（缺省 INBOUND_MERGE_MAX_WAIT_MS）。 */
    mergeMaxWaitMs?: number;
}
export declare class InboundScheduler {
    private readonly log;
    private readonly deliver;
    private readonly injectDeliver;
    private readonly maxPending;
    private readonly mergeWindowMs;
    private readonly mergeMaxWaitMs;
    /** 每会话串行链：key → 链尾 promise。 */
    private readonly chains;
    /** 全局待处理计数（含合并槽里未投递的）。 */
    private pending;
    /** 每会话合并槽。 */
    private readonly slots;
    constructor(options: InboundSchedulerOptions);
    /**
     * 投一条消息进来。注入轮不排队也不合并，直接串进本会话的链里跑；
     * 其余走连发合并（斜杠命令除外，命令一条一条按原样执行）。
     */
    push(event: OneBotEvent, opts?: {
        injected?: boolean;
    }): Promise<void>;
    /** 把一条投进它所属会话的串行链；全局积压超过上限就丢并记 warn。 */
    private enqueue;
    /** 把攒着的几条并成一条投出去，然后放行所有等着的调用方。 */
    private flush;
    /** 关闭：清掉所有合并定时器并放行等待者，别在关闭途中再投递。 */
    stop(): void;
}
