/**
 * Slash-command surface (M2-D1-PR1): the routed command table, the narrow
 * CommandContext through which handlers touch the bridge, and the router.
 * Extracted verbatim from bridge.ts — reply texts, argument parsing and
 * error behavior are byte-identical to the pre-split if-chain; /help is now
 * generated from the table (snapshot-gated in tests/commands.spec.ts).
 * @module dsh-onebot/commands
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { OneBotConnection } from './connection.js';
import type { MediaRef } from './cq.js';
import { type ChatId, type UserRole } from './chat.js';
import type { PendingSelection, SessionSwitchOutcome, SwitchableSession } from './registry.js';
import type { AgentDefaultModelLike, AgentPresetsLike, BridgeConfig, BridgeDeps, LlmCatalogPort, SessionPersistenceLike, SessionPreviewEvent, WorkspaceRegistryLike } from './bridge.js';
import type { TraceStage } from './trace.js';
/** Narrow view of a live chat the command handlers may read or mutate —
 * the structural subset of the bridge's internal ChatAgent that the
 * pre-split handlers actually touched. */
export interface CommandChatView {
    agent: Agent;
    sessionId: SessionId;
    busy: boolean;
    lastFollowup: string | undefined;
    lastNickname: string;
    loopPending: string | null;
    loopBuffer: Array<{
        id: string;
        text: string;
        sentAt: number;
    }>;
}
/** The bridge capabilities the command surface may touch. Deliberately
 * narrower than BridgeDeps: handlers get the outbound send path, the
 * per-chat state they already owned pre-split, and the few services they
 * call — never the agent registry, media store, or the policy allowlists
 * (the admin gate is answered by `isAdmin`, not by exposing `policy`). */
export interface CommandContext {
    /** Full outbound pipeline send (the commands' only reply path). */
    sendToChat(chatId: ChatId, text: string): Promise<string[]>;
    /** Bridge log line callback. */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** Router entry gate: the admin check against the policy allowlist. */
    isAdmin(userId: string): boolean;
    /** Live chat lookup / existence probe. */
    getChat(chatId: ChatId): CommandChatView | undefined;
    hasChat(chatId: ChatId): boolean;
    /** Registry capabilities the commands legitimately trigger. */
    resetChat(chatId: ChatId): Promise<void>;
    dispatchFollowup(chatId: ChatId, text: string, role: UserRole, nickname?: string): Promise<void>;
    /** T3 (P2): /stop — 显式终止该聊天的超时补发跟踪（pending 条目转
     * cancelled，其他聊天不受影响）。无补发条目时为 no-op。 */
    stopDeferredTracking(chatId: ChatId): void;
    /** T2 (P1): /steer — the bridge-owned steer core (agent.steer with the
     * producer-owned source kind; the createUserMessage write point stays in
     * bridge.ts). Returns false when the chat has no live agent. */
    steerRunningTurn(chatId: ChatId, text: string): boolean;
    /** Per-chat state readers/writers (the pre-split private maps). */
    effectiveCwd(chatId: ChatId): string;
    sessionIdFromMapping(chatId: ChatId): Promise<string | undefined>;
    resolvePresetId(chatId: ChatId): Promise<string | undefined>;
    setChatWorkspacePath(chatId: ChatId, path: string): void;
    presetOverride(chatId: ChatId): string | undefined;
    setPresetOverride(chatId: ChatId, id: string): void;
    hasPresetOverride(chatId: ChatId): boolean;
    interimOverride(chatId: ChatId): boolean | undefined;
    setInterimOverride(chatId: ChatId, value: boolean): void;
    goal(chatId: ChatId): string | undefined;
    setGoal(chatId: ChatId, value: string): void;
    deleteGoal(chatId: ChatId): void;
    lastImagePath(chatId: ChatId): string | undefined;
    lastImagePath(chatId: ChatId): string | undefined;
    /** R2: per-chat pending serial-number selection snapshot (the numbered list
     * a bare /workspace|/model|/preset|/session rendered; lazy 5-min TTL, see below). */
    /** /session: this chat's switchable retired sessions (newest first). */
    switchableSessions(chatId: ChatId): SwitchableSession[];
    /** /session <序号>: switch the chat back to a listed session. */
    switchSession(chatId: ChatId, targetSessionId: string): Promise<SessionSwitchOutcome>;
    /** /session list previews: the persistence port each retired session's
     * first user input is cold-read through (read handle + small event prefix).
     * Absent = preview-less items. */
    sessionPersistence: SessionPersistenceLike | undefined;
    pendingSelection(chatId: ChatId): PendingSelection | undefined;
    setPendingSelection(chatId: ChatId, value: PendingSelection | undefined): void;
    /** Lazy media resolution for the /ocr pending image ref (C6a). */
    resolveMediaRef(ref: MediaRef, chatId: ChatId): Promise<string>;
    /** Consume the pending pre-routing image ref (get + delete, /ocr only). */
    takePendingImageRef(chatId: ChatId): MediaRef | undefined;
    /** Services (narrow slices of the bridge deps). */
    /** Live model catalog for /model (M2-C5b port; index.ts wires it over the
     * live llm service — commands never touch Context). */
    llmCatalog: LlmCatalogPort | undefined;
    workspaceRegistry: WorkspaceRegistryLike | undefined;
    agentDefaultModel: AgentDefaultModelLike | undefined;
    agentPresets: AgentPresetsLike | undefined;
    commands: BridgeDeps['commands'];
    connection: OneBotConnection;
    dshHome: string | undefined;
    /** W1/T5 /healthcheck: render the health summary (absent = the bridge has
     * no health wiring — the command replies with a hint instead). */
    healthReport?: (() => Promise<string>) | undefined;
    /** W1/T5 /healthcheck export: pack the redacted diagnostics archive,
     * returning its path. T4 (P3): the optional trigger reference is stamped
     * into the archive file name (absent = the bridge's latest fault reference,
     * or a reference-free name when none was recorded). */
    exportDiagnostics?: ((triggerRef?: string) => Promise<string>) | undefined;
    /** T4 (P3): command-plane failure reference entry (/retry dispatch throw).
     * Mints an MF- reference through the bridge (registry + trace + structured
     * log) and returns it for the ⚠️ notice tail. */
    reportFailure?: ((chatId: ChatId, stage: TraceStage, detail: string) => string) | undefined;
    /** The only config fields the commands read. */
    config: Pick<BridgeConfig, 'interimMessages' | 'maxImageBytes' | 'unknownCommand'>;
}
/** T9-A: the sender identity the inbound pipeline already resolved for the
 * command message — threaded through tryHandleCommand so /steer can wrap its
 * argument in the same <user_message> boundary as every inbound payload
 * (M3-D5 invariant: all user content enters the prompt behind the boundary).
 * The nickname is the pre-sanitized value from inbound.ts; wrapUserMessage
 * re-sanitizes defensively. */
export interface CommandSender {
    userId: string;
    nickname: string;
}
/** One routed slash command: the table row IS the registration (D1-PR1) —
 * adding a command is exactly one row here and /help picks it up for free. */
export interface CommandDefinition {
    /** Command word after the leading slash (matched case-insensitively). */
    name: string;
    /** Alternative first-words routed to the same handler; rendered nowhere
     * (/help lists only `name`, suggestions map an alias back to it). */
    aliases?: string[];
    /** Admin-only flag; every current command is gated at the router entry. */
    adminOnly: boolean;
    /** /help line shown after "/name ": the usage-argument form (when the
     * command takes arguments) followed by the description, e.g.
     * "[路径|序号|list] 查看或切换工作区" or plain "本帮助". */
    help: string;
    /** /help group header the row renders under (no ▍ prefix). Rows without
     * one fall into 「其他」; a group outside the fixed card order still renders
     * (appended), so a new row always shows up in the card. */
    group?: string;
    handler(ctx: CommandContext, chatId: ChatId, arg: string, sender: CommandSender): Promise<void>;
}
/** The routed command table. Row order = the /help line order inside each
 * group (the router matches by name, so ordering is routing-neutral). */
export declare const COMMANDS: CommandDefinition[];
/** /help body: grouped multi-line card generated from the table — adding a
 * command stays a one-row change and its group header comes from the row
 * (unlisted groups append). The R1 tail line documents the unknown-command
 * behavior. Exported for the full-text snapshot gate in tests/commands.spec.ts. */
export declare function helpText(): string;
/**
 * Slash-command router. Commands are admin-only (the Hermes member
 * slash-command block) and are matched on the first word; a leading
 * @mention glued to the command (QQ group at + text) is stripped first.
 * A path like /tmp/x is never a command (command words are
 * /[A-Za-z][A-Za-z0-9_-]* only). Unknown commands get closest-match
 * suggestions (prefix first, edit distance ≤2 for length ≥4 inputs only)
 * and are consumed; with no suggestion, config.unknownCommand decides —
 * 'intercept' (default) consumes with a hint, 'passthrough' returns false
 * so the message reaches the model (the old Hermes fall-through).
 * @param ctx - bridge capabilities (built by ChatBridge).
 * @param chatId - the chat the command arrived in.
 * @param text - parsed inbound text.
 * @param userId - sender QQ number.
 * @param nickname - sender display name (pre-sanitized by inbound.ts); used
 *   by /steer for the <user_message> boundary attribute (T9-A).
 * @returns true when the message was consumed by a command.
 */
export declare function tryHandleCommand(ctx: CommandContext, chatId: ChatId, text: string, userId: string, nickname?: string): Promise<boolean>;
/** T2 (P1): the /steer submit notice — one line per accepted instruction.
 * Shared with the bridge's auto-steer path ('steer' policy) so both surfaces
 * word the confirmation identically; exported for the deterministic text
 * wait in tests. */
export declare const STEER_ACCEPTED_NOTICE = "\u2705 \u5DF2\u4F5C\u4E3A\u8865\u5145\u6307\u4EE4\u63D0\u4EA4\u7ED9\u5F53\u524D\u4EFB\u52A1\uFF0C\u6A21\u578B\u5C06\u5728\u4E0B\u4E00\u6B65\u8BFB\u53D6\u3002";
/** T2 (P1): the /steer usage hint — replied whenever the command cannot
 * steer (empty argument, no live chat, or no running task). Never crashes,
 * never silently no-ops. */
export declare const STEER_USAGE_HINT = "\u7528\u6CD5\uFF1A/steer <\u8865\u5145\u5185\u5BB9> \u2014\u2014 \u5728\u4EFB\u52A1\u8FD0\u884C\u671F\u95F4\u5411\u5F53\u524D\u4EFB\u52A1\u8FFD\u52A0\u4E00\u6761\u8865\u5145\u6307\u4EE4\uFF0C\u6A21\u578B\u4F1A\u5728\u4E0B\u4E00\u6B65\u8BFB\u53D6\uFF1B\u5F53\u524D\u6CA1\u6709\u8FD0\u884C\u4E2D\u7684\u4EFB\u52A1\uFF0C\u76F4\u63A5\u53D1\u9001\u6D88\u606F\u5373\u53EF\u5F00\u59CB\u65B0\u4EFB\u52A1\u3002";
/** /session list-item preview bound, in code points (emoji-safe — see
 * truncatePreview). */
export declare const SESSION_PREVIEW_MAX_CHARS = 40;
/** Whether a logged user-message source names a real queued user prompt (the
 * message a turn claimed) rather than a synthetic agent.inject() context or a
 * goal continuation round. Direct prompts carry kind 'user'; QQ chats
 * attribute their own inbound messages to this plugin (platform-source
 * logging), so the plugin-owned kind 'plugin:dsh-onebot' — also what the v3→v4
 * converter maps this plugin's historical rows to — is the chat's real user
 * input too. */
export declare function isRealUserMessageSource(source: {
    kind?: string;
} | undefined): boolean;
/** Code-point-safe truncation (never splits a surrogate pair — the §3.1
 * emoji lesson): at most `maxLength` code points, the last one '…' when cut. */
export declare function truncatePreview(text: string, maxLength: number): string;
/** The one-line preview of a session's event log (events in log order):
 * the first REAL user input (queued user prompt — kind 'user', or this
 * plugin's attributed QQ message) with non-empty text; when the log has
 * none, the first user/message of ANY source with text (synthetic
 * agent.inject context / goal continuation fallback); '' when the log
 * carries no user input at all. */
export declare function sessionPreviewFromEvents(events: readonly SessionPreviewEvent[], maxLength?: number): string;
/** Shorten a session id for the one-line list while keeping BOTH ends: every
 * onebot id shares the `onebot-…` head, so head-only truncation (e.g. the
 * first 12 characters) would render every entry of a chat identically — the
 * unique tail must survive for the id to stay recognizable. */
export declare function shortSessionId(id: string): string;
export declare function packageVersion(): string | undefined;
