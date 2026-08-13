/**
 * Chat identity and access policy: chat-id encoding, session-id derivation,
 * and the DM/group/mention/role authorization model ported from the Hermes
 * OneBot adapter. Pure functions.
 * @module dsh-onebot/chat
 */

/** DM vs group chat discriminator. */
export type ChatKind = 'private' | 'group'

/** A parsed chat id. */
export interface ChatRef {
  kind: ChatKind
  /** QQ number (private: the peer user id; group: the group id). */
  target: string
}

/** Human-facing chat id used across the plugin surface, e.g. "private:123456789". */
export type ChatId = string

/**
 * Encode a chat reference as "private:<qq>" / "group:<qq>".
 * @param kind - chat kind.
 * @param target - QQ number as string.
 * @returns the canonical chat id.
 */
export function buildChatId(kind: ChatKind, target: string): ChatId {
  return kind === 'private' ? 'private:' + target : 'group:' + target
}

/**
 * Decode a chat id; a bare QQ number defaults to a private chat.
 * @param chatId - canonical chat id or bare number.
 * @returns the chat reference.
 */
export function splitChatId(chatId: string): ChatRef {
  const idx = chatId.indexOf(':')
  if (idx > 0) {
    const kind = chatId.slice(0, idx)
    const target = chatId.slice(idx + 1)
    if (kind === 'private' || kind === 'group') return { kind, target }
  }
  return { kind: 'private', target: chatId }
}

/**
 * Derive the durable session id for a chat: "onebot-<chatId>" with
 * non-alphanumerics flattened, so the session store key stays filesystem-safe
 * while remaining recognizable in logs.
 * @param chatId - canonical chat id.
 * @returns the session id string.
 */
export function sessionIdForChat(chatId: ChatId): string {
  return 'onebot-' + chatId.replace(/[^A-Za-z0-9-]/g, '-')
}

/** Role classification for a QQ user. */
export type UserRole = 'admin' | 'member'

/**
 * Classify a user as admin or member. Admins are the explicit admin set plus
 * the ONEBOT_ALLOWED_USERS env fallback; everyone else (group members) is a
 * member. Unknown users are members.
 * @param userId - QQ number.
 * @param adminUsers - admin allowlist (already env-merged).
 * @returns the role.
 */
export function classifyUserRole(userId: string, adminUsers: readonly string[]): UserRole {
  return adminUsers.includes(userId) ? 'admin' : 'member'
}

/** DM policy: who may talk to the bot in private chats. */
export type DmPolicy = 'open' | 'allowlist' | 'disabled'
/** Group policy: which groups may talk to the bot. */
export type GroupPolicy = 'open' | 'allowlist' | 'disabled'

/** Access-policy inputs, mirroring the plugin Config surface. */
export interface AccessPolicyConfig {
  dmPolicy: DmPolicy
  groupPolicy: GroupPolicy
  allowFrom: readonly string[]
  groupAllowFrom: readonly string[]
  adminUsers: readonly string[]
  allowAllUsers: boolean
  requireMention: boolean
}

/**
 * Whether a private-chat message from the user is allowed. "open" admits
 * admins only (matching the Hermes adapter's trust posture); "allowlist"
 * admits the allowFrom set; "disabled" admits nobody.
 * @param userId - sender QQ number.
 * @param policy - resolved policy.
 * @returns allowed or not.
 */
export function dmAllowed(userId: string, policy: AccessPolicyConfig): boolean {
  if (policy.dmPolicy === 'disabled') return false
  if (policy.dmPolicy === 'allowlist') return policy.allowFrom.includes(userId)
  return policy.allowAllUsers || policy.adminUsers.includes(userId)
}

/**
 * Whether a group-chat message is allowed by group policy.
 * @param groupId - group QQ number.
 * @param policy - resolved policy.
 * @returns allowed or not.
 */
export function groupAllowed(groupId: string, policy: AccessPolicyConfig): boolean {
  if (policy.groupPolicy === 'disabled') return false
  if (policy.groupPolicy === 'allowlist') return policy.groupAllowFrom.includes(groupId)
  return true
}

/**
 * Build the group-message metadata prefix the agent sees:
 * "[HH:MM 昵称(QQ)]" plus "[@我]" when the bot was mentioned.
 * @param nickname - sender display name.
 * @param userId - sender QQ number.
 * @param mentioned - whether the bot was mentioned.
 * @returns the prefix string (never empty: always at least the time stamp).
 */
export function buildGroupMessagePrefix(nickname: string, userId: string, mentioned: boolean): string {
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const mention = mentioned ? '[@我]' : ''
  return '[' + hh + ':' + mm + ' ' + nickname + '(' + userId + ')]' + mention + ' '
}

/** Soft-cap prefix for restricted (member-role) group users. */
export const RESTRICTED_PREFIX = '[受限用户:仅问答] '
