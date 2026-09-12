import type { OneBotEvent } from './connection.js';
import type { MediaStore } from './media.js';
import type { Transcriber } from './stt.js';
import type { OneBotSegment, MediaRef } from './cq.js';
import type { AccessPolicyConfig, ChatId, UserRole } from './chat.js';
import type { BridgeConfig } from './bridge.js';
import type { ChatSettings } from './registry.js';
/**
 * The neutral shape normalizeOneBot11 extracts from one OneBot 11 message
 * event: exactly the fields the inbound pipeline consumes, with the event
 * shape quirks (message_type/user_id/group_id, segment-array-first parsing
 * with the CQ-string fallback, the raw sender-controlled nickname) resolved
 * at the boundary. `null` = not a processable chat message event.
 */
export interface NormalizedInbound {
    /** 'private' | 'group' — the OneBot message_type gate. */
    kind: 'private' | 'group';
    /** Sender QQ id, stringified ('' is gated out). */
    userId: string;
    /** Group id for group messages; '' for private chats. */
    groupId: string;
    /** The bridge chat id (private:<userId> | group:<groupId>). */
    chatId: ChatId;
    /** Segment array when the event carried one (segment arrays win over CQ). */
    segments: OneBotSegment[] | undefined;
    /** raw_message, falling back to the stringified message field. */
    raw: string;
    /** Parsed plain text with media placeholders. */
    text: string;
    /** Media refs parsed out of the message. */
    media: MediaRef[];
    /** OneBot message_id of the quoted (reply) message, if any. */
    replyId?: string;
    /** OneBot forward id embedded in the message, if any. */
    forwardId?: string;
    /** Raw sender-controlled nickname (card ?? nickname ?? userId) — NOT yet
     * sanitized; the M1-A7 sanitize choke point stays in the pipeline. */
    nickname: string;
}
/**
 * Reduce one raw OneBot 11 event to the neutral inbound shape, or null when
 * the event is not a processable chat message (notice/recall, meta, unknown
 * message_type, or a missing sender id). Pure: no I/O, no state — the
 * connection's self_id learning stays in the transport layer and the
 * ignoreSelf comparison stays in the pipeline (both are runtime state).
 */
export declare function normalizeOneBot11(event: OneBotEvent): NormalizedInbound | null;
/** Narrow view of a live chat the inbound pipeline may touch — the
 * structural subset of the bridge's ChatAgent the pipeline reads/writes:
 * the unmerged-loop residue reset on each new user message, and the B7
 * sliding-window rate-limit fields. */
export interface InboundChat {
    loopBuffer: Array<{
        id: string;
        text: string;
        sentAt: number;
    }>;
    loopPending: string | null;
    dispatchTimes: number[];
    rateLimitNoticeAt: number | undefined;
}
/** The bridge capabilities the inbound pipeline touches. Deliberately
 * narrower than BridgeDeps: the policy, the live registry views it needs
 * (chat lookup, per-chat settings, the idle sweep), media/transcriber, the
 * OneBot action gate, the outbound facade for the rate-limit notice, the
 * log, and the bridge-owned seams (command router, body building, quote
 * expansion, turn dispatch) kept as callbacks so the M2-T0 pipeline-order
 * test's bridge-instance overrides stay observable. dispatchFollowup is one
 * of those seams but its body stays bridge-resident (it orchestrates
 * ensureChat and the per-turn prefixes). */
export interface InboundContext {
    /** Raw OneBot action invocation (get_msg / get_image / get_record /
     * get_private_file_url / get_file / get_forward_msg). */
    call(action: string, params: Record<string, unknown>): Promise<unknown>;
    /** The connection's own QQ id as currently learned (ignoreSelf + mention detection). */
    selfId(): string;
    /** Access policy: DM/group allow lists and the admin set. */
    policy: AccessPolicyConfig;
    /** Live chat lookup (loop-residue reset + the B7 rate-limit window). */
    getChat(chatId: ChatId): InboundChat | undefined;
    /** Per-chat settings (recent-image registration for /ocr). */
    getSettings(chatId: ChatId): ChatSettings;
    /** B8c: lazy idle-chat sweep before each inbound message. */
    sweepIdleChats(): Promise<void>;
    /** Media store: ref resolution, URL downloads, fresh-path writes, temp cleanup. */
    media: MediaStore;
    /** Voice transcriber. */
    transcriber: Transcriber;
    /** Slash-command router (bridge facade: the command table's ctx lives there). */
    tryHandleCommand(chatId: ChatId, text: string, userId: string): Promise<boolean>;
    /** Message body assembly (bridge facade: overridable, see the pipeline-order test). */
    buildBody(text: string, media: MediaRef[], chatId: ChatId): Promise<string>;
    /** Quote (reply) expansion (bridge facade: overridable, see the pipeline-order test). */
    expandQuote(messageId: string): Promise<string>;
    /** Turn dispatch — bridge-owned orchestration (ensureChat + per-turn prefixes). */
    dispatchFollowup(chatId: ChatId, text: string, role: UserRole, nickname?: string): Promise<void>;
    /** Outbound facade (the B7 rate-limit notice). */
    sendToChat(chatId: ChatId, text: string): Promise<string[]>;
    /** Bridge log line callback. */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** The only config fields the inbound pipeline reads. */
    config: Pick<BridgeConfig, 'botQQ' | 'ignoreSelf' | 'requireMention' | 'rateLimitPerMinute' | 'restrictedMemberPrefix' | 'maxInboundFileBytes'>;
}
/**
 * The inbound pipeline: one normalized OneBot event → one agent turn.
 * Owns media resolution, quote/forward expansion and the B7 rate limit;
 * turn dispatch stays behind the context callback.
 */
export declare class InboundPipeline {
    private readonly ctx;
    constructor(ctx: InboundContext);
    processInbound(inbound: NormalizedInbound): Promise<void>;
    /** B7: sliding-window inbound rate limit for normal (non-command) messages.
     * Commands consumed by tryHandleCommand never reach this. Returns true when
     * the message must be dropped; at most one notice is sent per window. */
    private rateLimited;
    /**
     * Build the message body text: placeholders become annotated local paths
     * (images/voices/videos) and voice files are transcribed when enabled.
     */
    buildBody(text: string, media: MediaRef[], chatId: ChatId): Promise<string>;
    /** Resolve one media ref to a text annotation with a local path. */
    resolveMediaRef(ref: MediaRef, chatId: ChatId): Promise<string>;
    /** Expand a quoted (reply) message into [引用] text via get_msg. */
    expandQuote(messageId: string): Promise<string>;
    /**
     * Fetch an inbound QQ file to a local path. NapCat's get_file may return
     * container-internal paths unreachable from this host, so:
     *   1. prefer the private-file direct link (get_private_file_url → HTTP
     *      CDN download, works for private chats);
     *   2. fall back to get_file base64 / http-url payloads.
     * Returns the [文件:path] annotation, or '' when disabled/failed.
     */
    private resolveNasFile;
    /** Write bytes into the media dir under a fresh unpredictable name; returns the path or ''. */
    private writeMediaFile;
    /** Expand a combined-forward id into "name: content" lines. */
    expandForward(forwardId: string): Promise<string>;
}
