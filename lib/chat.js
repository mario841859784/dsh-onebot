/**
 * Chat identity and access policy: chat-id encoding, session-id derivation,
 * and the DM/group/mention/role authorization model ported from the Hermes
 * OneBot adapter. Pure functions.
 * @module dsh-onebot/chat
 */
/**
 * Encode a chat reference as "private:<qq>" / "group:<qq>".
 * @param kind - chat kind.
 * @param target - QQ number as string.
 * @returns the canonical chat id.
 */
export function buildChatId(kind, target) {
    return kind === 'private' ? 'private:' + target : 'group:' + target;
}
/**
 * Decode a chat id; a bare QQ number defaults to a private chat.
 * @param chatId - canonical chat id or bare number.
 * @returns the chat reference.
 */
export function splitChatId(chatId) {
    const idx = chatId.indexOf(':');
    if (idx > 0) {
        const kind = chatId.slice(0, idx);
        const target = chatId.slice(idx + 1);
        if (kind === 'private' || kind === 'group')
            return { kind, target };
    }
    return { kind: 'private', target: chatId };
}
/**
 * Derive the durable session id for a chat: "onebot-<chatId>" with
 * non-alphanumerics flattened, so the session store key stays filesystem-safe
 * while remaining recognizable in logs.
 * @param chatId - canonical chat id.
 * @returns the session id string.
 */
export function sessionIdForChat(chatId) {
    return 'onebot-' + chatId.replace(/[^A-Za-z0-9-]/g, '-');
}
/**
 * Classify a user as admin or member. Admins are the explicit admin set plus
 * the ONEBOT_ALLOWED_USERS env fallback; everyone else (group members) is a
 * member. Unknown users are members.
 * @param userId - QQ number.
 * @param adminUsers - admin allowlist (already env-merged).
 * @returns the role.
 */
export function classifyUserRole(userId, adminUsers) {
    return adminUsers.includes(userId) ? 'admin' : 'member';
}
/**
 * Whether a private-chat message from the user is allowed. "open" admits
 * admins only (matching the Hermes adapter's trust posture); "allowlist"
 * admits the allowFrom set; "disabled" admits nobody.
 * @param userId - sender QQ number.
 * @param policy - resolved policy.
 * @returns allowed or not.
 */
export function dmAllowed(userId, policy) {
    if (policy.dmPolicy === 'disabled')
        return false;
    if (policy.dmPolicy === 'allowlist')
        return policy.allowFrom.includes(userId);
    return policy.allowAllUsers || policy.adminUsers.includes(userId);
}
/**
 * Whether a group-chat message is allowed by group policy.
 * @param groupId - group QQ number.
 * @param policy - resolved policy.
 * @returns allowed or not.
 */
export function groupAllowed(groupId, policy) {
    if (policy.groupPolicy === 'disabled')
        return false;
    if (policy.groupPolicy === 'allowlist')
        return policy.groupAllowFrom.includes(groupId);
    return true;
}
/**
 * M3-D5 nickname whitelist: sanitize an attacker-controlled display name for
 * every identity surface it reaches — the single-line message prefix and the
 * <user_message> boundary attribute (see wrapUserMessage). The whitelist
 * guarantees neither surface can be forged:
 *   1. C0/C1 control characters and DEL (incl. CR/LF/NEL) are stripped — no
 *      forged prefix lines or tag boundaries via line breaks;
 *   2. the five XML markup characters < > & " ' are stripped — the boundary
 *      attribute cannot be closed, split or escaped out of;
 *   3. whitespace runs collapse to one space and the ends are trimmed;
 *   4. the result is capped at 32 code points (astral-safe).
 * Returns '' for blank input; callers keep their own fallback logic.
 * @param nickname - raw sender display name.
 * @returns the sanitized single-line nickname (possibly empty).
 */
export function sanitizeNickname(nickname) {
    const printable = nickname.replace(/[\u0000-\u001f\u007f-\u009f<>&"']/g, '');
    const collapsed = printable.replace(/\s+/g, ' ').trim();
    const chars = [...collapsed];
    return chars.length <= 32 ? collapsed : chars.slice(0, 32).join('');
}
/**
 * Build the group-message metadata prefix the agent sees:
 * "[HH:MM 昵称(QQ)]" plus "[@我]" when the bot was mentioned.
 * @param nickname - sender display name.
/**
 * T1 (PR port): 把 OneBot event.time（Unix 秒）格式化为 HH:MM。无效/缺失
 * （0、NaN、负数）时退回当前时间——与旧行为一致，不再让拉取的旧消息时间戳
 * 全部错位。
 * @param seconds - event.time（Unix 秒）。
 * @returns 'HH:MM'（本地时区，两位补零）。
 */
export function formatClock(seconds) {
    const sec = Number(seconds);
    const date = Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000) : new Date();
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
}
/**
 * T1 (PR port): 私聊消息的时间前缀 `[HH:MM] `。配合 normalizeOneBot11 保留
 * 的 event.time 使用：拉取旧消息时前缀反映消息真实时间而非处理时刻。
 */
export function buildDirectMessagePrefix(seconds) {
    return '[' + formatClock(seconds) + '] ';
}
/**
 * Build the single-line group prefix `[HH:MM 昵称(QQ)·档位][@我] `.
 * @param nickname - sanitized sender nickname.
 * @param userId - sender QQ number.
 * @param mentioned - whether the bot was mentioned.
 * @param role - the sender's tier (权限分档 A1): admin → ·管理员, member → ·成员.
 * @param seconds - event.time（Unix 秒，T1 PR port）；无效时退回当前时间。
 * @returns the prefix string (never empty: always at least the time stamp).
 */
export function buildGroupMessagePrefix(nickname, userId, mentioned, role, seconds) {
    const mention = mentioned ? '[@我]' : '';
    const tier = role === 'admin' ? '管理员' : '成员';
    return '[' + formatClock(seconds) + ' ' + nickname + '(' + userId + ')·' + tier + ']' + mention + ' ';
}
/** Soft-cap prefix for restricted (member-role) group users. */
export const RESTRICTED_PREFIX = '[受限用户:仅问答] ';
/**
 * M3-D5: wrap untrusted user content (message body + quote/merged-forward
 * expansions) in the explicit prompt-injection boundary. Everything between
 * the tags is data by platform declaration (src/prompt.ts): forged prefix
 * lines, restricted-member tags or system-prompt-like text inside it can
 * never leave the boundary. The opening tag is the trusted provenance marker;
 * the nickname attribute is re-sanitized here so the boundary stays unclosable
 * even for a caller that forgot the whitelist (sanitizeNickname is
 * idempotent). The qq attribute carries the protocol-typed numeric sender id —
 * the same trust level as the prefix line — not sender-controlled text.
 * @param content - the assembled untrusted message content.
 * @param userId - sender QQ number (OneBot user_id, digits).
 * @param nickname - the sender display name (sanitized again defensively).
 * @param messageId - T2 (PR port): the OneBot message_id of this inbound
 * message, emitted as the `mid` boundary attribute so the model can reply
 * with an exact [[reply:<mid>]] reference (see outbound.ts sendToChat).
 * Absent or empty → no attribute (upstream 0.9.19 shape).
 * @returns the boundary-wrapped content.
 */
export function wrapUserMessage(content, userId, nickname, messageId) {
    const mid = messageId === undefined || messageId === '' ? '' : ' mid="' + sanitizeNickname(messageId) + '"';
    return '<user_message qq="' + userId + '" nickname="' + sanitizeNickname(nickname) + '"' + mid + '>\n' + content + '\n</user_message>';
}
/** plain 格式原话每一行前面的缩进：两个全角空格（U+3000）。 */
export const PLAIN_INDENT = String.fromCharCode(0x3000, 0x3000);
/**
 * plain 格式的抬头行（框架写的那一行）的严格形状。读取侧（会话预览、
 * 上下文尾巴、出站复读切除）只认这一种，昵称不含「（」（plainNickname 已
 * 剥掉），QQ 号只认数字，结尾必须是全角冒号。
 */
export const PLAIN_HEADER_RE = /^\d{2}:\d{2} [^（\n]{1,40}（QQ \d{1,20}(?:，(?:成员|管理员)(?:，只回答问题)?)?）(?:私聊你|在群里说|在群里@了你)(?:，这条编号 [^\s：，]{1,40})?：$/;
/** plain 抬头里的昵称：照旧 sanitizeNickname，另外剥掉全角括号——抬头用
 * 「（QQ …）」标身份，昵称里带全角括号会让一行里出现两组像身份的括号。
 * 空昵称写「无昵称」。 */
function plainNickname(nickname) {
    const name = sanitizeNickname(nickname.replace(/[（）]/g, ''));
    return name === '' ? '无昵称' : name;
}
/** plain 抬头里的「，这条编号 …」；没有 message_id 时整段不写。 */
function plainMessageId(messageId) {
    if (messageId === undefined || messageId === '')
        return '';
    const id = sanitizeNickname(messageId).replace(/[\s：，]/g, '');
    return id === '' ? '' : '，这条编号 ' + id;
}
/**
 * plain 格式私聊抬头：`19:36 昵称（QQ 10001）私聊你，这条编号 123456：`。
 * @param nickname - 发送者昵称（这里再消毒一次）。
 * @param userId - 发送者 QQ 号（协议给的数字）。
 * @param seconds - event.time（Unix 秒）；无效时退回当前时间。
 * @param messageId - 这条消息的 message_id；缺省/空 = 不写编号。
 */
export function buildPlainDirectHeader(nickname, userId, seconds, messageId) {
    return formatClock(seconds) + ' ' + plainNickname(nickname) + '（QQ ' + userId + '）私聊你' + plainMessageId(messageId) + '：';
}
/**
 * plain 格式群聊抬头：`19:36 昵称（QQ 10001，成员）在群里@了你，这条编号 123456：`。
 * 没 @ 写「在群里说」；管理员档写「管理员」；受限用户在括号里加「，只回答问题」
 * （代替 tag 格式的 RESTRICTED_PREFIX）。
 */
export function buildPlainGroupHeader(nickname, userId, mentioned, role, restricted, seconds, messageId) {
    const tier = role === 'admin' ? '管理员' : '成员';
    return formatClock(seconds) + ' ' + plainNickname(nickname) + '（QQ ' + userId + '，' + tier + (restricted ? '，只回答问题' : '') + '）'
        + (mentioned ? '在群里@了你' : '在群里说') + plainMessageId(messageId) + '：';
}
/**
 * plain 格式的原话块：每一行（空行也算）前面加两个全角空格。换行先统一成
 * \n（\r\n、单独的 \r、U+0085/U+2028/U+2029 都算换行），所以原话里任何一种
 * 换行后面伪造的「抬头」到了模型眼里也是缩进的。
 */
export function indentPlainBody(content) {
    return content.split(/\r\n?|\n|[\u0085\u2028\u2029]/).map(line => PLAIN_INDENT + line).join('\n');
}
/** 抬头 + 缩进的原话块。 */
export function wrapPlainMessage(header, content) {
    return header + '\n' + indentPlainBody(content);
}
/**
 * 认一条 plain 格式的入站消息：第一行是严格的抬头，后面每一行都缩进（或为
 * 空行——宿主派发前会 trim 末尾）。认得出返回抬头和去掉缩进的原话；认不出
 * （包括 tag 格式、带 /goal 前缀的）返回 null，调用方走原来的路径。
 */
export function parsePlainEnvelope(text) {
    const lines = String(text ?? '').split('\n');
    if (lines.length < 2 || !PLAIN_HEADER_RE.test(lines[0]))
        return null;
    const rest = lines.slice(1);
    if (!rest.every(line => line === '' || line.startsWith(PLAIN_INDENT)))
        return null;
    return { header: lines[0], body: rest.map(line => line.startsWith(PLAIN_INDENT) ? line.slice(PLAIN_INDENT.length) : line).join('\n') };
}
