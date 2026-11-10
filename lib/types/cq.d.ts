/**
 * OneBot 11 message parsing: CQ-code unescaping, segment-array → text/media
 * extraction, mention detection, and face-id → emoji mapping. Ported from the
 * Hermes onebot_utils.py (CQ parsing half). Pure functions, no I/O.
 * @module dsh-onebot/cq
 */
/** One OneBot 11 message segment. */
export interface OneBotSegment {
    type: string;
    data: Record<string, string>;
}
/** A media reference extracted from an inbound message, resolved by media.ts. */
export interface MediaRef {
    kind: 'image' | 'voice' | 'video' | 'file';
    /** Remote URL to download (image/voice/video). */
    url?: string;
    /** raw file field: base64://..., file://..., or a hash. */
    file?: string;
    /** OneBot file_id (NapCat file segments carry the real id here). */
    fileId?: string;
    name?: string;
    subType?: string;
    /** Stickers only: the exact `[表情包...]` text parseMessage wrote for this ref,
     * so buildBody swaps this ref's own slot and not the next photo's `[图片]`. */
    stickerLabel?: string;
}
/** A fully parsed inbound message. */
export interface ParsedMessage {
    /** Plain text with media placeholders, ready for the agent. */
    text: string;
    media: MediaRef[];
    /** OneBot message_id of the quoted (reply) message, if any. */
    replyId?: string;
    /** OneBot forward id embedded in the message, if any. */
    forwardId?: string;
}
/**
 * Reverse the CQ escaping NapCat applies inside attribute values
 * (&amp; → &, &#91; → [, &#93; → ], &#44; → ,). Skipping this broke
 * image-CDN downloads with a 403 (the & in signed URLs arrived escaped).
 * @param value - raw CQ attribute value or text.
 * @returns unescaped value.
 */
export declare function cqUnescape(value: string): string;
/** Set the face presentation style (T6 PR port faceStyle 配置；非法值回落 'name'). */
export declare function setFaceStyle(style: string | undefined | null): void;
/** The built-in official QQ face name table (T6 PR port；测试/工具面). */
export declare function faceNames(): Readonly<Record<string, string>>;
/** Map a QQ face id to its presentation text, with a fallback for unknown ids.
 * faceStyle='name'（默认）：官方名「[微笑]」，表外 id 降级「[表情id]」；
 * faceStyle='emoji'：旧 emoji 对照表，表外 id 降级 😀。 */
export declare function faceToEmoji(id: string): string;
/**
 * Detect explicit @bot / @all only; a reply segment never implies an @.
 * @param segments - segment array (may be undefined for CQ-only payloads).
 * @param raw - raw CQ string.
 * @param selfId - learned bot QQ id ('' when unknown).
 * @param botQQ - configured bot QQ id ('' when unset).
 * @returns whether this message explicitly mentions the known bot.
 */
export declare function detectExplicitMention(segments: OneBotSegment[] | undefined, raw: string, selfId: string, botQQ: string, atAllCounts?: boolean): boolean;
/**
 * T1 (PR port): 唤醒词命中判定——只认消息开头命中。用 startsWith 而非
 * includes：消息正文里偶然提到唤醒词（如有人在句中写到唤醒词）不再误触；
 * 大小写不敏感、两侧空白忽略；空词表恒 false。
 * @param text - 消息纯文本（segmentText 结果）。
 * @param names - 唤醒词表（管理员档或成员档）。
 * @returns 是否以任一唤醒词开头。
 */
export declare function detectWakeName(text: string, names: readonly string[]): boolean;
/**
 * Detect explicit mentions or a reply with a known bot author, fail-closed.
 * A standard OneBot reply contains only an id; the inbound group gate must
 * resolve its author through get_msg before allowing a reply-only trigger.
 * @param segments - preferred OneBot segment array.
 * @param raw - CQ string fallback.
 * @param selfId - learned bot QQ id ('' when unknown).
 * @param botQQ - configured fallback bot QQ id.
 * @param options - T1 (PR port) 引用即叫/@全体即叫 开关（缺省=上游语义）。
 * @returns false for replies whose author cannot be determined synchronously.
 */
export declare function detectMention(segments: OneBotSegment[] | undefined, raw: string, selfId: string, botQQ: string, options?: {
    reply?: boolean;
    atAll?: boolean;
}): boolean;
/**
 * Drop the bot's own @ from the start of parsed text. Goes by the first segment,
 * not a text prefix: with bot 10002, "@100021" is either @10002 followed by "1"
 * or an @ of member 100021, and the text alone cannot tell them apart.
 * @param text - parsed text from parseMessage for this same message.
 * @param segments - segment array (may be undefined for CQ-only payloads).
 * @param raw - raw CQ string.
 * @param selfId - learned bot QQ id ('' when unknown).
 * @param botQQ - configured bot QQ id ('' when unset).
 * @returns the text after the mention, or the text unchanged when the message
 *   does not start with an @ of the bot.
 */
export declare function stripLeadingBotMention(text: string, segments: OneBotSegment[] | undefined, raw: string, selfId: string, botQQ: string): string;
/** Split a raw CQ string into segments; used only when no segment array exists. */
export declare function parseCqString(raw: string): OneBotSegment[];
/**
 * Parse a OneBot message (segment array preferred, CQ string fallback) into
 * text + media references. Media appear as placeholders in the text; media.ts
 * resolves each ref to a local path afterwards.
 * @param segments - message segment array (preferred).
 * @param raw - raw CQ string (fallback / complement).
 * @returns parsed text, media refs, and the quoted message id.
 */
export declare function parseMessage(segments: OneBotSegment[] | undefined, raw: string): ParsedMessage;
/** Extract the plain text of a quoted (get_msg) message for [引用] expansion. */
export declare function segmentText(segments: OneBotSegment[] | undefined, raw: string): string;
/** Marker regex shared with split.ts (outbound [[qq_forward]]). */
export declare const FORWARD_BLOCK_RE: RegExp;
