/**
 * Chat identity and access policy: chat-id encoding, session-id derivation,
 * and the DM/group/mention/role authorization model ported from the Hermes
 * OneBot adapter. Pure functions.
 * @module dsh-onebot/chat
 */
/** DM vs group chat discriminator. */
export type ChatKind = 'private' | 'group';
/** A parsed chat id. */
export interface ChatRef {
    kind: ChatKind;
    /** QQ number (private: the peer user id; group: the group id). */
    target: string;
}
/** Human-facing chat id used across the plugin surface, e.g. "private:123456789". */
export type ChatId = string;
/**
 * Encode a chat reference as "private:<qq>" / "group:<qq>".
 * @param kind - chat kind.
 * @param target - QQ number as string.
 * @returns the canonical chat id.
 */
export declare function buildChatId(kind: ChatKind, target: string): ChatId;
/**
 * Decode a chat id; a bare QQ number defaults to a private chat.
 * @param chatId - canonical chat id or bare number.
 * @returns the chat reference.
 */
export declare function splitChatId(chatId: string): ChatRef;
/**
 * Derive the durable session id for a chat: "onebot-<chatId>" with
 * non-alphanumerics flattened, so the session store key stays filesystem-safe
 * while remaining recognizable in logs.
 * @param chatId - canonical chat id.
 * @returns the session id string.
 */
export declare function sessionIdForChat(chatId: ChatId): string;
/** Role classification for a QQ user. */
export type UserRole = 'admin' | 'member';
/**
 * Classify a user as admin or member. Admins are the explicit admin set plus
 * the ONEBOT_ALLOWED_USERS env fallback; everyone else (group members) is a
 * member. Unknown users are members.
 * @param userId - QQ number.
 * @param adminUsers - admin allowlist (already env-merged).
 * @returns the role.
 */
export declare function classifyUserRole(userId: string, adminUsers: readonly string[]): UserRole;
/** DM policy: who may talk to the bot in private chats. */
export type DmPolicy = 'open' | 'allowlist' | 'disabled';
/** Group policy: which groups may talk to the bot. */
export type GroupPolicy = 'open' | 'allowlist' | 'disabled';
/** Access-policy inputs, mirroring the plugin Config surface. */
export interface AccessPolicyConfig {
    dmPolicy: DmPolicy;
    groupPolicy: GroupPolicy;
    allowFrom: readonly string[];
    groupAllowFrom: readonly string[];
    adminUsers: readonly string[];
    allowAllUsers: boolean;
    requireMention: boolean;
}
/**
 * Whether a private-chat message from the user is allowed. "open" admits
 * admins only (matching the Hermes adapter's trust posture); "allowlist"
 * admits the allowFrom set; "disabled" admits nobody.
 * @param userId - sender QQ number.
 * @param policy - resolved policy.
 * @returns allowed or not.
 */
export declare function dmAllowed(userId: string, policy: AccessPolicyConfig): boolean;
/**
 * Whether a group-chat message is allowed by group policy.
 * @param groupId - group QQ number.
 * @param policy - resolved policy.
 * @returns allowed or not.
 */
export declare function groupAllowed(groupId: string, policy: AccessPolicyConfig): boolean;
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
export declare function sanitizeNickname(nickname: string): string;
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
export declare function formatClock(seconds: number): string;
/**
 * T1 (PR port): 私聊消息的时间前缀 `[HH:MM] `。配合 normalizeOneBot11 保留
 * 的 event.time 使用：拉取旧消息时前缀反映消息真实时间而非处理时刻。
 */
export declare function buildDirectMessagePrefix(seconds: number): string;
/**
 * Build the single-line group prefix `[HH:MM 昵称(QQ)·档位][@我] `.
 * @param nickname - sanitized sender nickname.
 * @param userId - sender QQ number.
 * @param mentioned - whether the bot was mentioned.
 * @param role - the sender's tier (权限分档 A1): admin → ·管理员, member → ·成员.
 * @param seconds - event.time（Unix 秒，T1 PR port）；无效时退回当前时间。
 * @returns the prefix string (never empty: always at least the time stamp).
 */
export declare function buildGroupMessagePrefix(nickname: string, userId: string, mentioned: boolean, role: UserRole, seconds: number): string;
/** Soft-cap prefix for restricted (member-role) group users. */
export declare const RESTRICTED_PREFIX = "[\u53D7\u9650\u7528\u6237:\u4EC5\u95EE\u7B54] ";
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
export declare function wrapUserMessage(content: string, userId: string, nickname: string, messageId?: string): string;
