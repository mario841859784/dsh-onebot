/**
 * T1 (PR port): 戳一戳（poke）notice → 伪消息处理器。
 *
 * 上游 v1 的连接层把 notice 事件整体丢弃；本模块把 poke notice 翻译成一条
 * `[戳一戳]` 伪消息重新走入站管线。三个坑（贡献者实证）：
 * 1. poke notice 里 user_id 是发起者、target_id 是被戳者——只有 target 缺失
 *    或 target===selfId 时才响应（target 指向别人时不叫，宁缺勿滥）；
 * 2. 群聊伪消息必须补一个指向机器人的 at 段，否则过不了群聊 @ 门；
 * 3. 同一发起者 3 秒节流，防止连戳刷屏；节流表超限时清理 60 秒前的旧项。
 */
import type { OneBotEvent } from './connection.js';
/** 同一发起者的节流窗口（毫秒）。 */
export declare const POKE_THROTTLE_MS = 3000;
/** 节流表条目数超过该值时触发一次旧项清理。 */
export declare const POKE_THROTTLE_MAX = 200;
/** 旧项清理的保留窗口（毫秒）。 */
export declare const POKE_THROTTLE_KEEP_MS = 60000;
/** poke 处理器依赖的最小接口（index.ts 接线，测试可直接构造）。 */
export interface PokeHandlerDeps {
    /** 设置页开关；!== true 时全部忽略。 */
    pokeEnabled: boolean;
    /** 机器人自身 QQ（延迟取值：selfId 在 meta 事件后才学习到）。 */
    selfId: () => string;
    /** 伪消息投递口（bridge.handleInbound）。 */
    dispatch: (event: OneBotEvent) => void;
    /** 节流丢弃等决策的 debug 日志口。 */
    log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
    /** 测试注入口：默认 Date.now。 */
    now?: () => number;
}
/**
 * Create the poke notice handler. One handler instance per plugin mount —
 * the throttle map lives for the plugin's lifetime.
 */
export declare function createPokeHandler(deps: PokeHandlerDeps): (event: OneBotEvent) => void;
