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
    mentioned: boolean;
}
/**
 * Reverse the CQ escaping NapCat applies inside attribute values
 * (&amp; → &, &#91; → [, &#93; → ], &#44; → ,). Skipping this broke
 * image-CDN downloads with a 403 (the & in signed URLs arrived escaped).
 * @param value - raw CQ attribute value or text.
 * @returns unescaped value.
 */
export declare function cqUnescape(value: string): string;
/** Escape the other way (used when embedding user text into CQ attributes). */
export declare function cqEscape(value: string): string;
/** Map a QQ face id to an emoji, with a fallback for unknown ids. */
export declare function faceToEmoji(id: string): string;
/**
 * Detect whether the message mentions the bot. Prefers the segment array;
 * falls back to CQ-string scanning. Fail-closed: with an unknown bot id and
 * no configured botQQ, group messages are never treated as mentioning us.
 * @param segments - segment array (may be undefined for CQ-only payloads).
 * @param raw - raw CQ string.
 * @param selfId - learned bot QQ id ('' when unknown).
 * @param botQQ - configured bot QQ id ('' when unset).
 * @param replyId - reply segment already extracted.
 */
export declare function detectMention(segments: OneBotSegment[] | undefined, raw: string, selfId: string, botQQ: string, replyId?: string): boolean;
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
