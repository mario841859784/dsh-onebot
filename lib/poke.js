/** 同一发起者的节流窗口（毫秒）。 */
export const POKE_THROTTLE_MS = 3_000;
/** 节流表条目数超过该值时触发一次旧项清理。 */
export const POKE_THROTTLE_MAX = 200;
/** 旧项清理的保留窗口（毫秒）。 */
export const POKE_THROTTLE_KEEP_MS = 60_000;
/**
 * Create the poke notice handler. One handler instance per plugin mount —
 * the throttle map lives for the plugin's lifetime.
 */
export function createPokeHandler(deps) {
    const throttle = new Map();
    const now = deps.now ?? Date.now;
    return (event) => {
        if (deps.pokeEnabled !== true)
            return;
        const userId = String(event.user_id ?? '');
        const selfId = deps.selfId();
        if (userId === '' || userId === selfId)
            return;
        const targetId = String(event.target_id ?? '');
        if (targetId !== '' && targetId !== selfId)
            return;
        const groupId = String(event.group_id ?? '');
        const kind = groupId !== '' ? 'group' : 'private';
        const at = now();
        const throttleKey = kind + ':' + (groupId !== '' ? groupId : userId) + ':' + userId;
        const last = throttle.get(throttleKey);
        if (last !== undefined && at - last < POKE_THROTTLE_MS) {
            deps.log?.('debug', '戳一戳节流中，已忽略: ' + throttleKey);
            return;
        }
        if (throttle.size > POKE_THROTTLE_MAX) {
            for (const [key, seenAt] of throttle) {
                if (at - seenAt >= POKE_THROTTLE_KEEP_MS)
                    throttle.delete(key);
            }
        }
        throttle.set(throttleKey, at);
        const segments = [{ type: 'text', data: { text: '[戳一戳]' } }];
        // 群聊伪消息补一个指向本体的 at 段，否则过不了群聊 @ 门。
        if (kind === 'group' && selfId !== '') {
            segments.push({ type: 'at', data: { qq: selfId } });
        }
        const pseudo = {
            post_type: 'message',
            message_type: kind,
            time: Math.floor(at / 1000),
            message_id: 'poke-' + at,
            user_id: userId,
            raw_message: '[戳一戳]',
            message: segments,
            sender: { user_id: userId, nickname: '' },
        };
        if (kind === 'group')
            pseudo.group_id = groupId;
        deps.dispatch(pseudo);
    };
}
