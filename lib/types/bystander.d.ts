/**
 * 群聊旁观（bystander，issue #58）：requireMention 开启时，未通过 @ 门控的
 * 群消息原本完全不进模型上下文——机器人只有「被点名」一种存在形态。旁观能力
 * 把这些消息写进每群独立的环形缓冲，命中规则触发条件时开一次「回顾回合」：
 * 把缓冲拼成一次性上下文交给模型，可插话也可输出 [[不回]] 保持沉默（沉默哨兵
 * 的守卫链复用 interim/bridge/deferred 现有实现，本模块不管输出侧）。
 *
 * 设计约束：
 * - 零后台定时器：冷却与每日上限全部是时间戳字段 + feed 时惰性判定
 *   （/silent 静音窗与 PendingSelection 的先例），不随插件停用遗留 tick。
 * - 触发是纯规则（提到唤醒词/问句/话题词/机会触发），不接模型、零额外调用；
 *   「每条消息都开回合」的成本结构被冷却 + 每日上限双重定界。
 * - 旁听文本属不可信数据：buildReviewText 把缓冲整块包进 <user_message>
 *   边界（chat.ts wrapUserMessage 纪律），昵称渲染前再消毒一次。
 * @module dsh-onebot/bystander
 */
import { type ChatId } from './chat.js';
/** 一条旁听消息（seq = OneBot message_id，time = Unix 秒）。 */
export interface BystanderEntry {
    seq: string;
    time: number;
    userId: string;
    nickname: string;
    text: string;
}
/** 旁观行为参数（面板/config 扁平键 bystander* 的聚合形态）。 */
export interface BystanderSettings {
    enabled: boolean;
    /** 每群环形缓冲条数上限。 */
    capacity: number;
    /** 话题词表：消息文本包含任一词即触发（子串匹配，大小写不敏感）。 */
    topics: readonly string[];
    /** 每群两次回顾回合的最小间隔（分钟）。 */
    cooldownMinutes: number;
    /** 每群每日主动回顾上限（本地日期键计数，惰性重置）。 */
    dailyLimit: number;
}
/** 缺省参数（index.ts schema 默认值的镜像；bridge 侧缺字段时逐项兜底）。 */
export declare const BYSTANDER_DEFAULTS: Omit<BystanderSettings, 'topics'> & {
    topics: string[];
};
/** 机会触发的缓冲就绪线（条数）。 */
export declare const OPPORTUNISTIC_MIN_ENTRIES = 10;
/** 机会触发的「群内对话活跃」窗口（秒）：最后一条旁听消息距此刻不超过该值。 */
export declare const OPPORTUNISTIC_ACTIVE_WINDOW_SECONDS = 300;
/** 回顾回合的触发来源（trace/日志用）。 */
export type BystanderTrigger = 'wakeName' | 'question' | 'topic' | 'opportunistic';
/**
 * 问句判定：以 ?/？ 结尾，或以「吗/呢/么」收尾（≥2 字避免单字噪声）。
 * issue #58 的「怎么/为什么」类问句几乎总是以 ?/？ 或疑问语气词收尾，
 * 不单独枚举疑问词（正文命中「怎么」就触发会把讨论性发言全变成回合）。
 */
export declare function looksLikeQuestion(text: string): boolean;
/**
 * 每群一份的旁听状态：环形缓冲 + 冷却时间戳 + 日期键控的每日计数。
 * 全部惰性判定，无定时器；chat 驱逐时随 Map 一并丢弃（不持久化——旁听
 * 缓冲是易失的「最近发生了什么」，重启后从空白重新积累是合理语义）。
 */
export declare class BystanderTracker {
    private readonly buffers;
    private readonly lastDispatchAt;
    private readonly dailyCounts;
    /**
     * 喂一条未通过 @ 门控的群消息并评估触发。先入缓冲（环式淘汰），再过
     * 冷却/每日上限两道闸，最后按优先级评估触发条件。
     * @param opts.wakeNames - 管理员∪成员唤醒词表（复用 detectWakeName 的
     *   startsWith 语义：句首点名但没 @ 也算「被提到」）。
     * @param opts.nowMs - 当前时刻（epoch 毫秒），测试注入假时钟用。
     * @returns 命中的触发类型；不触发/被闸拦下返回 null。
     */
    feed(chatId: ChatId, entry: BystanderEntry, settings: BystanderSettings, opts: {
        wakeNames: readonly string[];
        nowMs: number;
    }): BystanderTrigger | null;
    /**
     * 把缓冲拼成回顾回合的一次性上下文。缓冲为空（全部空文本被剔）返回 null。
     * 整块包 <user_message> 边界（旁听文本不可信），引导语在边界外。
     */
    buildReviewText(chatId: ChatId): string | null;
    /** 记一次回顾回合派发：写冷却时间戳 + 递增当日计数。 */
    markDispatched(chatId: ChatId, settings: BystanderSettings, nowMs: number): void;
    /** 测试与调试观测：缓冲条数。 */
    bufferLength(chatId: ChatId): number;
}
