import type { BridgeConfig } from './bridge.js';
import type { ChatId } from './chat.js';
import type { TraceStage } from './trace.js';
/** One OneBot message segment for outbound sends. */
export interface OutboundSegment {
    type: string;
    data: Record<string, unknown>;
}
/**
 * SnowLuma's send_msg validates text segments: `text === ''` is treated as a
 * compatibility placeholder and a whitespace-only text still goes through
 * normal validation — both get rejected. Strip empty/whitespace-only text
 * segments before the wire; non-text segments pass untouched.
 */
export declare function filterBlankTextSegments(segments: OutboundSegment[]): OutboundSegment[];
/**
 * T1 (PR port): 清洗出站文本里夹带的 ACP 元数据残渣——宿主 ACP 代理的
 * `<acp tokens="…" type="…" time="…">mNNNNN` 标记头与成对 `</acp>` 标签
 * 偶尔漏进模型正文；上游 stripBoundaryLeakage 覆盖宿主自有元信息行，
 * 这两条 ACP 形态是它未覆盖的面。
 */
export declare function stripAcpNoise(text: string): string;
/** T1 (PR port): 逐 text 段清洗 ACP 残渣；无变化的段原样返回（保持引用
 * 相等），清空后的空白文本段由 sendMsg 里的 filterBlankTextSegments 兜底。 */
export declare function sanitizeAcpSegments(segments: OutboundSegment[]): OutboundSegment[];
/**
 * T2 (PR port): 生成侧陷进复读时的闸。
 * 症状：正文里同一句垫话连着几千遍，一条消息几万字、上万输出 token 全砸在
 * 这上头；重复会自己喂自己——写一次它就进了上下文，下一句更可能还写它。
 * 判据只砍「连着」重复的：行内同一小段（1–6 字）连着 8 次以上砍成 1 次，
 * 或整行完全一样（允许夹空行）连着 5 行以上只留第一次；正常语气词
 * （哈哈哈、好好好）到不了这个数。短文（<300 字）不动，收尾折叠空行。
 */
export declare function collapseRepeats(raw: string): string;
/**
 * T2 (PR port): 模型把入站消息原文（<user_message> 信封）复读进正文的闸。
 * 形态多是尾巴上挂一段「正文\n\n[HH:MM]<user_message …>原话</user_message>」。
 * 只砍复读段、正文留着：成对的标签块整块删（连同行首 [HH:MM] 前缀）；
 * 残缺的（只有开头没闭合）从它所在行的行首截到结尾；整条只剩复读时才
 * 返回空串。不含 user_message 时原样返回（不引入多余的 trim 副作用）。
 */
export declare function cutLeakedEnvelope(raw: string): string;
/**
 * T2 (PR port): 出站清洗的单一入口——sendToChat 主路径（outboundDefenseEnabled
 * 开启时）与 qq_send_text 工具共用这一个函数，避免贡献者实现里主路径与工具
 * 两侧各抄一份、规则漂移的问题。次序固定：replacement 字符剥除 → 复读闸 →
 * 信封闸 → 「系统提示」整段截断 → 半截 DSML/收尾标记与独立 URL 行剥除。
 * 不做 [[…]] 标记清理（reply 标记要在 sendToChat 里先抽取，次序不能被打断）。
 */
export declare function cleanOutboundText(raw: string): string;
/**
 * T2 (PR port): 引用/转发标记写歪时的兜底——只删标记本身，不动正文。
 * 在 sendToChat 里排在 [[reply:…]] 抽取与 [[qq_forward]] 块抽取之后。
 */
export declare function scrubLeftoverMarkers(raw: string): string;
/**
 * T2 (PR port): 整条只剩括号旁白（如「（嗯……）」）就不要发。
 * 判据：把（…）/(…)/【…】括号块与空白全剥掉后什么都不剩、且原文非空。
 * 是否真正拦截由 asideOnlySilentEnabled 开关决定（默认关闭不拦）。
 */
export declare function isAsideOnly(text: string): boolean;
/**
 * T2 (PR port): 正文里的 [[at:QQ号]] 拆成真正的 @ 段——文本里写 @ 只是字符，
 * 成不了 at 段。无命中时返回单个 text 段（调用方在开关关闭时直接走原路径，
 * 不经过本函数）。
 */
export declare function splitAtSegments(text: string): OutboundSegment[];
/** Options for an explicit outbound send (from tools). */
export interface SendOptions {
    replyTo?: string;
    /** Queue the send for resend on reconnect instead of failing while the
     * connection is down. Only for model final replies; interim sends carry
     * recall timers + bookkeeping and must never be replayed. */
    queuable?: boolean;
}
/**
 * T9 (#2): strip a leaked <user_message> boundary. wrapUserMessage (chat.ts)
 * wraps every inbound payload in `<user_message qq="…" nickname="…">…</user_message>`,
 * and a model may echo those markers back inside its reply. Only the literal
 * `user_message` tag name is recognized, in attribute-constrained shapes, so
 * ordinary angle-bracket text (`<tag>`, XML, `a < b`) passes untouched: a
 * full wrapper loses just its tags (the enclosed content stays), stray
 * opening/closing/self-closing tags are dropped verbatim. Clean text is
 * returned unchanged (no re-trim side effects).
 *
 * #26: a trailing full wrapper after other reply prose is the echo signature
 * of a message that reached the model mid-turn (steer policy) or of the
 * question being answered — the model repeats the wrapped user text at the
 * very end of its reply, and keeping the enclosed content then appends the
 * user's message verbatim. That trailing block is dropped whole (tags AND
 * content), however many lines the prose before it has, and consecutive
 * trailing blocks all go. A wrapper still carrying the entire reply keeps its
 * content (T9), and a mid-reply wrapper keeps its content (an intentional
 * quote).
 *
 * #46: host-internal metadata echoed into the reply is stripped too. Whole
 * lines starting with a fixed host time-sampling/context prefix ("Time
 * sampled while preparing turn", "Browser time zone for this request:",
 * "Elapsed since the preceding model-visible message:") are dropped with
 * the line, and the host role boundary tags <user> / </user> are removed in
 * line-edge shapes only (alone on a line, or glued at a line start/end) —
 * mid-line occurrences (ordinary `<`, XML, comparisons, prose mentions of
 * the prefixes) stay untouched.
 *
 * #46（最新评论）: 宿主元信息的另一组盲区同样要剥——skill_content 成对块、
 * system-reminder / system_reminder 成对块（两种拼写都会出现，可嵌套、可
 * 混用）整块丢弃：先用 \1 反向引用的成对正则循环 replace 至不动点（开闭
 * 拼写一致才成对，懒惰匹配止于最近的同名闭标签——嵌套块的外层连同内层
 * 一起吃掉），再剥残留散标签兜底混合拼写的孤儿标签；</input> 只剥收尾
 * 形态——开标签 <input type="…"> 与正文讨论 HTML 的场景一律不碰。标签名
 * 受限，普通尖括号（a < b、<tag>、<br>）不受影响。这一段在 user_message
 * 早退判断之前跑：真实泄漏样本里往往没有 user_message 包裹。
 */
export declare function stripBoundaryLeakage(text: string): string;
/** Narrow view of a live chat the outbound pipeline may touch — the
 * structural subset of the bridge's ChatAgent the pipeline reads: the
 * nickname used as the t2i card title. Re-evaluated for B8d: the per-chat
 * send chain now lives in the pipeline itself (sendChains), so the chat view
 * no longer carries the queue field. */
export interface OutboundChat {
    lastNickname: string;
}
/** The bridge capabilities the outbound pipeline touches. Deliberately
 * narrower than BridgeDeps: the connection call gate, the live chat lookup
 * for the per-chat send chain, the stop flag guarding the B6 drain, and the
 * config subset the pipeline reads — never the agent registry, media store,
 * or policy. */
export interface OutboundContext {
    /** Live chat lookup (card-title nickname). */
    getChat(chatId: ChatId): OutboundChat | undefined;
    /** Whether the OneBot connection currently accepts sends. */
    connected(): boolean;
    /** The connection's own QQ id (forward-node uin). */
    selfId(): string;
    /** Raw OneBot action invocation (send_msg / send_*_forward_msg). W1/T5:
     * the target chatId rides along when known so the bridge's inject dry-run
     * guard can attribute the call to a chat's injected round. */
    call(action: string, params: Record<string, unknown>, chatId?: ChatId): Promise<unknown>;
    /** Bridge stop flag: the B6 drain must never run while stopping. */
    isStopping(): boolean;
    /** Bridge log line callback. */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** W1: emit one outbound/queue decision event for a chat. The bridge owns
     * the traceId resolution (chat-level association table; unmapped proactive
     * writes mint a fresh id) — absent = tracing off, zero cost. */
    trace?: (chatId: ChatId, event: {
        stage: TraceStage;
        ok?: boolean;
        reason?: string;
        data?: Record<string, unknown>;
    }) => void;
    /** The only config fields the outbound pipeline reads. The W2-③ write-gate
     * fields ride as optional intersection members so the bridge's BridgeConfig
     * type stays untouched (absent → the defaults below). */
    config: Pick<BridgeConfig, 'botQQ' | 'sensitivePatterns' | 'textImageThreshold' | 'maxImageBytes' | 'cardFooter' | 'fontFiles' | 'fontFamilies' | 'monoFamilies'> & Partial<{
        /** Audit file directory (W2-③: mediaDir/qq-actions.log); absent → no audit. */
        mediaDir: string;
        /** W2-③ bridge-wide proactive-write cap per sliding minute; 0 disables. */
        actionRatePerMinute: number;
        /** W2-③ bridge-wide proactive-write cap per calendar day; 0 disables. */
        actionRatePerDay: number;
        /** W2-③ proactive-write audit switch (default on). */
        actionAuditEnabled: boolean;
        /** T2 (PR port): 出站防御总开关——cleanOutboundText 复读/信封清洗、
         * 残留标记兜底与 [[at:QQ]] 拆段都挂在这一个开关下；absent/false =
         * 上游 0.9.19 原始行为（逐字节等价）。 */
        outboundDefenseEnabled: boolean;
        /** T2 (PR port): 纯括号旁白（如「（嗯……）」）静默丢弃的独立开关；
         * absent/false = 照常发送。 */
        asideOnlySilentEnabled: boolean;
    }>;
}
/** W2-③: default bridge-wide proactive-write caps, aligned with the MIT
 * competitor's actionRatePerMinute(20) / actionRatePerDay(500). */
export declare const DEFAULT_ACTION_RATE_PER_MINUTE = 20;
export declare const DEFAULT_ACTION_RATE_PER_DAY = 500;
/** W2-③: proactive-write audit file name, appended under mediaDir (jsonl). */
export declare const ACTION_AUDIT_FILE = "qq-actions.log";
/**
 * The outbound pipeline. Owns the B6 pendingSends state; the bridge keeps
 * same-name delegating facades and wires the reconnect drain trigger.
 */
export declare class OutboundPipeline {
    private readonly ctx;
    /** Clock override (tests); behavior-affecting timestamps (send chains,
     * offline queue, write gate) all read it — never the wall clock directly. */
    private readonly now;
    /** Per-chat FIFO of model final replies parked while disconnected; drained
     * oldest-first on reconnect (M1-B6). */
    private readonly pendingSends;
    constructor(ctx: OutboundContext, options?: {
        now?: () => number;
    });
    /**
     * Send plain text to a chat with the full outbound pipeline (forward
     * blocks, Markdown strip, sentence splitting).
     * @param chatId - target chat.
     * @param text - model-produced text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    sendToChat(chatId: ChatId, text: string, options?: SendOptions): Promise<string[]>;
    /** Park one queuable send for a chat while disconnected (M1-B6):
     * per-chat FIFO, capped — the oldest entry is dropped beyond the cap. */
    private queuePendingSend;
    /** Sliding-60s timestamps of allowed proactive writes (bridge-wide). */
    private writeActionTimes;
    /** Calendar-day (local) counter of allowed proactive writes. */
    private writeDayKey;
    private writeDayCount;
    /** Serialized audit-append chain (order discipline, see auditWrite). */
    private auditChain;
    /** W1/T5 health snapshot: the write gate's current usage against its
     * limits (minute sliding window pruned at read time; day counter). */
    writeGateStats(): {
        minuteUsed: number;
        minuteLimit: number;
        dayUsed: number;
        dayLimit: number;
    };
    /** W2-③: check + consume one proactive-write slot. Returns a non-empty
     * Chinese rejection reason when the write must be dropped (a warn with the
     * chatId and the limit name is logged and the rejection is audited);
     * returns null when allowed (slot consumed). Rejected attempts do not
     * consume quota. */
    private writeGateRejectReason;
    /** W2-③: append one proactive-write (or rejection / send failure) audit
     * line to mediaDir/qq-actions.log (jsonl: ts/chatId/action/ok/reason).
     * Fire-and-forget: a write failure only warns and never affects the send
     * path. Writes are chained so lines land in call order even when the fs
     * thread pool completes them out of schedule. No-op when auditing is
     * disabled or no mediaDir is configured. */
    private auditWrite;
    /** Resend parked final replies oldest-first after a reconnect (M1-B6).
     * Per-chat send chains keep the order; a send that hits a fresh
     * disconnection re-queues itself via the queuable gate. Expired entries
     * (TTL) are dropped. Never runs while stopping. Wired from the bridge's
     * onStatus(true) handler (bridge.start). */
    drainPendingSends(): void;
    /**
     * Send raw OneBot segments (used by the media tools). W2-③: counts as a
     * proactive write — subject to the minute/day caps and audited.
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId: ChatId, segments: OutboundSegment[]): Promise<string | undefined>;
    /** B8d: per-chat send chains owned by the pipeline (decoupled from the
     * registry's chat lifecycle — unregistered chats serialize too, the
     * original C6b ask). Entries clean themselves up once settled so evicted
     * chats do not accumulate. */
    private readonly sendChains;
    /** Serialize work on one chat's send chain. */
    private enqueue;
    /** The chat's send-chain tail; resolves once every queued send has settled
     * (settleLoop snapshots the interim trail after it, preserving order). */
    chainTail(chatId: ChatId): Promise<unknown>;
    /** Send one message to a chat and return its message id. */
    sendMsg(chatId: ChatId, segments: OutboundSegment[], options: SendOptions): Promise<string | undefined>;
    /** Send [[qq_forward]] nodes as a merged-forward message (proactive write
     * from the qq_send_forward tool). W2-③: subject to the minute/day caps
     * and audited; the passive [[qq_forward]] blocks inside sendToChat bypass
     * this gate via sendForwardNodes. */
    sendForward(chatId: ChatId, nodes: Array<{
        name: string;
        content: string;
    }>): Promise<void>;
    /** Ungated merged-forward send (shared by the gated tool path and the
     * passive [[qq_forward]] blocks inside sendToChat). */
    private sendForwardNodes;
}
