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
 * Build the group-message metadata prefix the agent sees:
 * "[HH:MM 昵称(QQ)]" plus "[@我]" when the bot was mentioned.
 * @param nickname - sender display name.
 * @param userId - sender QQ number.
 * @param mentioned - whether the bot was mentioned.
 * @returns the prefix string (never empty: always at least the time stamp).
 */
export declare function buildGroupMessagePrefix(nickname: string, userId: string, mentioned: boolean): string;
/** Soft-cap prefix for restricted (member-role) group users. */
export declare const RESTRICTED_PREFIX = "[\u53D7\u9650\u7528\u6237:\u4EC5\u95EE\u7B54] ";
