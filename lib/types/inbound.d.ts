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
    /** W2-②: the event's own message_id, stringified. Absent when the
     * implementation didn't send one — the pipeline's message_id dedup window
     * is skipped for those (nothing to key on). */
    messageId?: string;
    /** Raw sender-controlled nickname (card ?? nickname ?? userId) — NOT yet
     * sanitized; the pipeline's M3-D5 identity whitelist sanitizes it before it
     * reaches the prefix, the boundary attribute or lastNickname. */
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
    /** M3-D4c: deliver a completed voice transcript into the chat's agent
     * (bridge-owned: steers the running turn, or opens one when idle). */
    steerTranscript(chatId: ChatId, text: string): void;
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
    /** The only config fields the inbound pipeline reads. The W2-② dedup
     * window rides as an optional intersection member so the bridge's
     * BridgeConfig type stays untouched (absent → the default window). */
    config: Pick<BridgeConfig, 'botQQ' | 'ignoreSelf' | 'requireMention' | 'rateLimitPerMinute' | 'restrictedMemberPrefix' | 'maxInboundFileBytes'> & Partial<{
        /** W2-② (chatId, message_id) dedup window in seconds; 0 disables. */
        dedupWindowSeconds: number;
    }>;
}
/** W2-②: default (chatId, message_id) dedup window, aligned with the MIT
 * competitor's dedupWindowSeconds (300s). */
export declare const DEFAULT_DEDUP_WINDOW_SECONDS = 300;
/** W2-②: max entries kept in the dedup window map (LRU-evicted beyond this)
 * so a flood of distinct message_ids cannot grow memory unbounded. */
export declare const DEDUP_MAX_ENTRIES = 4096;
/** Constructor tuning knobs for the inbound pipeline (tests inject a fake
 * clock / a small LRU cap; production uses the defaults). */
export interface InboundPipelineOptions {
    /** Dedup window map capacity override (tests); default DEDUP_MAX_ENTRIES. */
    dedupMaxEntries?: number;
    /** Clock override for the dedup window (tests); default Date.now. */
    now?: () => number;
}
/**
 * The inbound pipeline: one normalized OneBot event → one agent turn.
 * Owns media resolution, quote/forward expansion and the B7 rate limit;
 * turn dispatch stays behind the context callback.
 */
export declare class InboundPipeline {
    private readonly ctx;
    /** W2-② dedup knobs (see InboundPipelineOptions). */
    private readonly dedupMaxEntries;
    private readonly now;
    /** W2-② dedup window state: "chatId#messageId" → first-seen epoch ms, in
     * insertion order (Map) so the oldest entry is the LRU victim. */
    private readonly seenMessages;
    constructor(ctx: InboundContext, options?: InboundPipelineOptions);
    /** W1/T5 health snapshot: how many message_ids are currently held in the
     * dedup window (LRU-capped; see DEDUP_MAX_ENTRIES). */
    get dedupWindowEntries(): number;
    processInbound(inbound: NormalizedInbound): Promise<void>;
    /** W2-②: (chatId, message_id) sliding-window dedup against OneBot
     * re-delivery (reconnect replay / ws retry). Runs before every other gate
     * so a redelivered message can neither re-trigger a command nor reset the
     * loop residue; only events that normalize to processable chat messages
     * reach this — notice/meta/request events never enter the pipeline (see
     * docs/m1-characterization/pipeline-hooks.md #1/#3). Events without a
     * message_id are not deduped (nothing to key on). Window entries live in
     * an LRU-capped map: hits refresh recency (keeping the first-seen time, so
     * the window opens at first delivery), the oldest entry is evicted beyond
     * the cap. Returns true when the delivery must be silently skipped. */
    private duplicated;
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
    /** M3-D4c: transcribe in the background and deliver the labeled transcript
     * into the chat's turn (steer at the running turn's nearest step boundary,
     * or a new turn when the agent is idle). Failure keeps [语音] as final. */
    private transcribeLater;
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
    /**
     * Expand a combined-forward id into "name: content" lines, collecting
     * embedded image segments into the media list (they flow through the same
     * buildBody pipeline as inbound media). Failure or an empty expansion no
     * longer returns a silent placeholder: the resId plus a short reason
     * (api-error / empty-response / no-text-nodes) stays in the model context
     * so it can self-serve via the whitelisted get_forward_msg tool.
     */
    expandForward(forwardId: string): Promise<{
        text: string;
        media: MediaRef[];
    }>;
}
