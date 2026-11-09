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
import type { OneBotEvent } from './connection.js'
import type { OneBotSegment } from './cq.js'

/** 同一发起者的节流窗口（毫秒）。 */
export const POKE_THROTTLE_MS = 3_000
/** 节流表条目数超过该值时触发一次旧项清理。 */
export const POKE_THROTTLE_MAX = 200
/** 旧项清理的保留窗口（毫秒）。 */
export const POKE_THROTTLE_KEEP_MS = 60_000

/** poke 处理器依赖的最小接口（index.ts 接线，测试可直接构造）。 */
export interface PokeHandlerDeps {
  /** 设置页开关；!== true 时全部忽略。 */
  pokeEnabled: boolean
  /** 机器人自身 QQ（延迟取值：selfId 在 meta 事件后才学习到）。 */
  selfId: () => string
  /** 伪消息投递口（bridge.handleInbound）。 */
  dispatch: (event: OneBotEvent) => void
  /** 节流丢弃等决策的 debug 日志口。 */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
  /** 测试注入口：默认 Date.now。 */
  now?: () => number
}

/**
 * Create the poke notice handler. One handler instance per plugin mount —
 * the throttle map lives for the plugin's lifetime.
 */
export function createPokeHandler(deps: PokeHandlerDeps): (event: OneBotEvent) => void {
  const throttle = new Map<string, number>()
  const now = deps.now ?? Date.now
  return (event: OneBotEvent): void => {
    if (deps.pokeEnabled !== true) return
    const userId = String(event.user_id ?? '')
    const selfId = deps.selfId()
    if (userId === '' || userId === selfId) return
    const targetId = String(event.target_id ?? '')
    if (targetId !== '' && targetId !== selfId) return
    const groupId = String(event.group_id ?? '')
    const kind = groupId !== '' ? 'group' : 'private'
    const at = now()
    const throttleKey = kind + ':' + (groupId !== '' ? groupId : userId) + ':' + userId
    const last = throttle.get(throttleKey)
    if (last !== undefined && at - last < POKE_THROTTLE_MS) {
      deps.log?.('debug', '戳一戳节流中，已忽略: ' + throttleKey)
      return
    }
    if (throttle.size > POKE_THROTTLE_MAX) {
      for (const [key, seenAt] of throttle) {
        if (at - seenAt >= POKE_THROTTLE_KEEP_MS) throttle.delete(key)
      }
    }
    throttle.set(throttleKey, at)
    const segments: OneBotSegment[] = [{ type: 'text', data: { text: '[戳一戳]' } }]
    // 群聊伪消息补一个指向本体的 at 段，否则过不了群聊 @ 门。
    if (kind === 'group' && selfId !== '') {
      segments.push({ type: 'at', data: { qq: selfId } })
    }
    const pseudo: OneBotEvent = {
      post_type: 'message',
      message_type: kind,
      time: Math.floor(at / 1000),
      message_id: 'poke-' + at,
      user_id: userId,
      raw_message: '[戳一戳]',
      message: segments,
      sender: { user_id: userId, nickname: '' },
    }
    if (kind === 'group') pseudo.group_id = groupId
    deps.dispatch(pseudo)
  }
}
