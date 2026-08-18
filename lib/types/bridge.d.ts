/**
 * The chat↔agent bridge: one Agent per QQ chat, inbound message pipeline
 * (policy → parse → media → STT → quote/forward expansion → followup),
 * outbound delivery driven by session events (assistant/message, turn/end),
 * typing indicator, per-chat send ordering, and chat→session mapping
 * persistence for restart resume. Ported from the Hermes OneBotAdapter
 * gateway-interaction half onto the dsh headless-runner agent pattern.
 * @module dsh-onebot/bridge
 */
import type { AgentRegistry, ModelSelection } from '@deepseek-ai/dsh-agent';
import type { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { OneBotConnection, OneBotEvent } from './connection.js';
import { OneBotActionError, OneBotNotConnectedError } from './connection.js';
import type { MediaStore } from './media.js';
import type { Transcriber } from './stt.js';
import type { ChatId } from './chat.js';
import type { AccessPolicyConfig } from './chat.js';
/** One OneBot message segment for outbound sends. */
export interface OutboundSegment {
    type: string;
    data: Record<string, unknown>;
}
/** Options for an explicit outbound send (from tools). */
export interface SendOptions {
    replyTo?: string;
}
/** Resolved runtime configuration for the bridge. */
export interface BridgeConfig {
    botQQ: string;
    ignoreSelf: boolean;
    splitLength: number;
    requireMention: boolean;
    interimMessages: boolean;
    /** Per-interim auto-recall delay (ms) from each interim's send completion
     * while the turn is still running (QQ recall window ~2 min); absent → 90s.
     * At turn/end the remaining originals are recalled immediately regardless. */
    interimRecallMs?: number;
    sendErrorNotice: boolean;
    restrictedMemberPrefix: boolean;
    sensitivePatterns: readonly string[];
    mediaDir: string;
    maxImageBytes: number;
    maxVoiceBytes: number;
    maxFileBytes: number;
    textImageThreshold: number;
    cardFooter: string;
    fontFiles: readonly string[];
    fontFamilies: readonly string[];
    agentPreset: string;
    workspacePath: string;
    /** Max inbound file bytes fetched via QQ direct link / base64 (0 = no cap). */
    maxInboundFileBytes: number;
}
/** Agent-preset service (dsh-agent-presets): joins agents to a preset composition. */
export interface AgentPresetsLike {
    /** The preset id a new session gets when none is named (deployment default). */
    readonly defaultId: string;
    /** Resolve one preset by id (undefined = default); throws when no root supplies it. */
    resolve(id?: string): Promise<{
        id: string;
    }>;
    mount(agentCtx: unknown, id?: string): Promise<{
        id: string;
    }>;
}
/** Durable session persistence (dsh-session-persistence): cold-read what a session recorded. */
export interface SessionPersistenceLike {
    inspect(id: SessionId, signal?: AbortSignal): Promise<{
        meta: {
            agentPreset?: string;
        };
        events: readonly {
            type?: string;
            data?: {
                agentPreset?: string;
            };
        }[];
    }>;
}
/** The preset id a session's own record names: newest logged selection, else the creation header. */
export declare function resolveRecordedPreset(inspection: {
    meta: {
        agentPreset?: string;
    };
    events: readonly {
        type?: string;
        data?: {
            agentPreset?: string;
        };
    }[];
}): string | undefined;
/** Workspace registry (dsh-workspace): durable workspace membership. */
export interface WorkspaceLike {
    id: string;
    path: string;
    sessionIds: readonly string[];
    attachSession(sessionId: string): Promise<void>;
}
/** Workspace registry (dsh-workspace): durable workspace membership. */
export interface WorkspaceRegistryLike {
    resolveByPath(path: string): Promise<WorkspaceLike | undefined>;
    create(path: string, title?: string): Promise<WorkspaceLike>;
    list(): WorkspaceLike[];
}
/** Default model service (dsh-agent-default-model): read/save the default selection. */
export interface AgentDefaultModelLike {
    currentSelection(): ModelSelection | undefined;
    saveSelection(next: ModelSelection): Promise<void>;
}
/** Services the bridge needs (subset of the plugin Context). */
export interface BridgeDeps {
    ctx: Context;
    connection: OneBotConnection;
    /** The dsh data home (default <home>/.dsh); used to enumerate agent presets. */
    dshHome?: string | undefined;
    media: MediaStore;
    transcriber: Transcriber;
    agents: AgentRegistry;
    sessions: SessionStore;
    agentPresets: AgentPresetsLike;
    /** Host command runtime: forwards /plan so QQ reaches the native plan command. */
    commands?: {
        execute(agent: unknown, line: string, signal?: AbortSignal): Promise<{
            kind?: string;
            text?: string;
        }>;
    } | undefined;
    /** Durable persistence for cold-reading a session's recorded preset; absent = config/default fallback. */
    sessionPersistence: SessionPersistenceLike | undefined;
    workspaceRegistry: WorkspaceRegistryLike;
    agentDefaultModel: AgentDefaultModelLike | undefined;
    defaultModel: (() => ModelSelection | undefined) | undefined;
    config: BridgeConfig;
    policy: AccessPolicyConfig;
    /** Log line callback (level, message). */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
}
/**
 * Bridge between OneBot events and dsh agents. Create via the constructor and
 * call start() from the plugin's effect; call stop() on disposal.
 */
export declare class ChatBridge {
    private readonly deps;
    private readonly chats;
    private readonly bySession;
    /** Per-chat workspace override set by /workspace (survives /new resets,
     * so the next agent for the chat is created under the new directory). */
    private readonly chatWorkspacePaths;
    /** Per-chat agent-preset override set by /preset (survives /new resets). */
    private readonly chatPresetOverrides;
    /** Per-chat outbound-mode override set by /mode (true=interim, false=instant);
     * undefined defers to the global config. */
    private readonly chatInterimOverrides;
    /** Per-chat goal set by /goal (reminds the model of the objective each turn). */
    private readonly chatGoals;
    /** Per-chat most recent inbound image path (for /ocr), survives /new resets. */
    private readonly chatLastImagePaths;
    /** Plugin version + git commit, read once for /ver. */
    private pluginVersion;
    private pluginCommit;
    private stopping;
    private mappingSaveTimer;
    /** Resolves once the on-disk chat mapping has been loaded. */
    private mappingLoaded;
    /** Session ids whose persisted logs are unusable; creates must avoid them. */
    private readonly brokenSessions;
    /** Session ids retired across restarts (durable copy of brokenSessions). */
    private retiredSessionIds;
    constructor(deps: BridgeDeps);
    /** Start listening: wire connection handlers and the session event feed. */
    start(): void;
    /** Stop everything: dispose agents, save mapping, cancel timers. */
    stop(): Promise<void>;
    /** Map an agent session id back to its chat (for model tools). */
    chatForSession(sessionId: string): ChatId | undefined;
    /** Whether a caller backing an agent session may perform file edits. QQ chats
     * require the most recent inbound user to be an admin; non-QQ sessions (Web
     * and other channels) are trusted by default (A1 scoping). */
    canEditFiles(sessionId: string): boolean;
    /** Whether the connection is usable for sends. */
    get connected(): boolean;
    /**
     * Send plain text to a chat with the full outbound pipeline (forward
     * blocks, Markdown strip, sentence splitting).
     * @param chatId - target chat.
     * @param text - model-produced text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    sendToChat(chatId: ChatId, text: string, options?: SendOptions): Promise<string[]>;
    /**
     * Send raw OneBot segments (used by the media tools).
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId: ChatId, segments: OutboundSegment[]): Promise<string | undefined>;
    /**
     * Wait for the loader's complete application (model selection, settings,
     * persistence) before reading the default model — the same gate the
     * headless runner uses, so the pinned selection is never a half-loaded
     * default.
     */
    private ready;
    /**
     * Inbound OneBot message event → agent turn. All policy and media work is
     * contained: a failure here logs and drops the message, never the host.
     */
    handleInbound(event: OneBotEvent): Promise<void>;
    private processInbound;
    /** Feed one user message into a chat's agent (create on demand). Records
     * the base text for /retry and applies per-chat /goal + /plan prefixes. */
    private dispatchFollowup;
    /** Prepend per-chat context directives (/goal reminder) to a turn's user
     * text. Plan mode is host-owned now (/plan forwards to the host command),
     * so the agent's own plan-mode instruction section governs planning. */
    private prefixTurn;
    /** Per-chat outbound-mode override (/mode), falling back to the global config. */
    private effectiveInterim;
    /** Tool calls whose host-plane UI has no QQ equivalent; relay them to the chat. */
    private relayHostCards;
    /** Render an exit_plan_mode tool-call's plan for QQ, or undefined when unusable. */
    private renderPlanCard;
    /** Render an ask_user_question tool-call's questions for QQ, or undefined when unusable. */
    private renderQuestionCard;
    /**
     * Slash-command router. Commands are admin-only (the Hermes member
     * slash-command block) and are matched on the first word; a leading
     * @mention glued to the command (QQ group at + text) is stripped first.
     * A path like /tmp/x is never a command (command words are
     * /[A-Za-z][A-Za-z0-9_-]* only). Unknown commands return false so the
     * message reaches the model, matching the Hermes "fall through" behavior.
     * @param chatId - the chat the command arrived in.
     * @param text - parsed inbound text.
     * @param userId - sender QQ number.
     * @returns true when the message was consumed by a command.
     */
    private tryHandleCommand;
    /** /model: show the current model (+ discoverable providers), or switch. */
    private handleModelCommand;
    /** /workspace: show current cwd, list workspaces, or switch directory. */
    private handleWorkspaceCommand;
    /** /id: show the chat/session identity (admin debug aid). */
    private handleIdCommand;
    /** /ver: plugin version + git commit (each read once and cached). */
    private handleVerCommand;
    /** /status: one-shot snapshot of the chat session state. */
    private handleStatusCommand;
    /** /mode: per-chat outbound-mode override (interim vs instant). */
    private handleModeCommand;
    /** /retry: re-feed the last user message into the agent. */
    private handleRetryCommand;
    /** /ocr: OCR the most recent inbound image via NapCat's ocr_image. */
    private handleOcrCommand;
    /** /preset: show available agent presets and the current one, or switch. */
    private handlePresetCommand;
    /** /plan: per-chat plan mode — turns are prefixed with a plan-only directive. */
    /** /plan: forward to the HOST plan command so QQ enters/leaves host plan
     * mode (the host `/plan off` path exits directly, no Web review card). The
     * plugin no longer runs its own prefix plan mode — that duplicated the host
     * semantic and shadowed the host `/plan off` exit. */
    private handlePlanCommand;
    /** /goal: per-chat objective — recorded and reminded on each turn. */
    private handleGoalCommand;
    /** Enumerate the on-disk agent presets (<dsh-home>/.agent-presets/*). */
    private listPresets;
    /** Plugin version from package.json, read once. */
    private packageVersion;
    /** Git short commit of the plugin repo, read once (best-effort). */
    private gitCommit;
    /** Read the chat→session mapping file (for /id and /status when no live chat). */
    private sessionIdFromMapping;
    /** Current default model selection, best-effort (absent services return undefined). */
    private safeDefaultModel;
    /**
     * Build the message body text: placeholders become annotated local paths
     * (images/voices/videos) and voice files are transcribed when enabled.
     */
    private buildBody;
    /** Resolve one media ref to a text annotation with a local path. */
    private resolveMediaRef;
    /** Expand a quoted (reply) message into [引用] text via get_msg. */
    private expandQuote;
    /**
     * Fetch an inbound QQ file to a local path. NapCat's get_file may return
     * container-internal paths unreachable from this host, so:
     *   1. prefer the private-file direct link (get_private_file_url → HTTP
     *      CDN download, works for private chats);
     *   2. fall back to get_file base64 / http-url payloads.
     * Returns the [文件:path] annotation, or '' when disabled/failed.
     */
    private resolveNasFile;
    /** Download a URL into the local media dir; returns the path or ''. */
    private downloadToMedia;
    /** Write bytes into the local media dir; returns the path or ''. */
    private writeMediaFile;
    /** Expand a combined-forward id into "name: content" lines. */
    private expandForward;
    /** Serialize work on one chat's send chain. */
    private enqueue;
    /** Send one message to a chat and return its message id. */
    private sendMsg;
    /** Send [[qq_forward]] nodes as a merged-forward message. */
    sendForward(chatId: ChatId, nodes: Array<{
        name: string;
        content: string;
    }>): Promise<void>;
    /** Cancel a message's pending 90s auto-recall timer. */
    private clearInterimTimer;
    /** Clear every pending interim auto-recall timer for a chat (dispose path). */
    private clearInterimTimers;
    /**
     * Recall the still-on-screen interim originals (turn/end step 2). Ids the
     * 90s timer already revoked during the turn are skipped (already gone).
     * Recall failure is logged only — the summary card still carries the text.
     */
    private recallLoopMessages;
    /** Fire when an interim's own 90s timer elapses mid-turn: revoke it alone. */
    private revokeInterim;
    /** Render this turn's interims into one t2i image (summary card, before final). */
    private sendInterimSummary;
    /** Send one interim live and record it: text for the turn/end summary card,
     * plus a per-message auto-recall timer (config interimRecallMs) so long turns
     * clean up their early messages even before the summary arrives. */
    private sendInterim;
    /**
     * Settle a finished turn's interim trail (interimMessages on): drain the send
     * chain so every interim id is recorded, then render ONE t2i summary card of
     * all interims, immediately recall the still-on-screen originals, and finally
     * send the deferred final text. No merged-forward any more — QQ refuses to
     * recall messages older than ~2 min, and a forward of aged interims would
     * leave the originals plus a duplicate card, so interims are surfaced live
     * and auto-revoked per message (90s) during long turns.
     */
    private settleLoop;
    private onSessionEvent;
    private onSessionFlush;
    /** Get (or create) the agent for a chat. */
    private ensureChat;
    /** Resume persisted chats from the mapping file (best-effort). */
    private loadMapping;
    private mappingPath;
    private saveMapping;
    private saveMappingDebounced;
    /** Whether a session id must never be created again (this run or on disk). */
    private isSessionIdBlocked;
    /** A suffixed session id for a chat that avoids every blocked id. */
    private freshSessionId;
    /** Permanently retire a session id: in-memory plus durable on-disk record,
     * so a restart never reuses an id whose log collides with a fresh session. */
    private retireSession;
    /** Whether the persistence layer already owns a durable log for this id —
     * true means reusing the id would collide (stale on-disk log or live entry).
     * A read failure counts as no log so the caller falls back to the normal
     * path rather than blocking an id on a transient error. */
    private hasPersistedLog;
    private retiredPath;
    private loadRetired;
    private saveRetired;
    /**
     * Recover from a session-log collision: the live session cannot append to
     * the mismatched on-disk log, so dispose the agent and rebuild the chat on
     * a fresh session id. The user is asked to resend.
     */
    private healSessionCollision;
    /**
     * Effective workspace directory for a chat's sessions: the per-chat
     * /workspace override when set, else the configured workspacePath, falling
     * back to the host process cwd.
     */
    private effectiveCwd;
    /**
     * The preset id a NEW session records and joins: the configured id when set,
     * else the deployment default — the same resolution the Web surface applies,
     * so cross-channel sessions carry the same header fact. A roster that cannot
     * resolve the effective id leaves the header bare and the session uncomposed,
     * exactly like a failed mount.
     */
    private resolvePresetId;
    /**
     * The preset id a persisted session recorded for itself (newest logged
     * selection wins, else the creation header), or undefined when it recorded
     * none or the record cannot be read — a legacy session resumes under the
     * config/default, preserving its original behavior.
     */
    private recordedPresetFor;
    /**
     * Join the QQ agent to the configured agent preset (the deployment default
     * when unset) so its tools/prompt sections/skill catalog resolve against the
     * preset composition instead of the empty global layer. `preferred` — the
     * preset the session itself recorded — overrides the config (its history was
     * produced under that composition; replaying it differently would break the
     * recorded tool calls); a conflicting config only logs. Best-effort: a
     * broken preset falls back to the previous behavior rather than failing the
     * chat.
     */
    private joinPreset;
    /**
     * Attach a chat session to the workspace owning its header cwd, so QQ
     * sessions group under a workspace in the GUI instead of "Ungrouped".
     * Best-effort: failure only logs.
     *
     * A workspace is auto-created only when the session cwd matches the
     * configured workspacePath (new sessions). A resumed session carrying a
     * foreign cwd (e.g. created under an earlier host cwd) is attached only when
     * a workspace already owns that path — never auto-created, so legacy
     * sessions cannot spawn accidental workspaces.
     */
    private attachToWorkspace;
    /**
     * /new: dispose the current chat agent and retire its session id, so the
     * next inbound message creates a brand-new session (fresh history; the old
     * conversation stays on disk). The confirmation is sent directly through
     * the outbound pipeline since no agent is left to reply.
     */
    private resetChat;
    /** Start the NapCat typing indicator (private chats only). */
    private startTyping;
    /** Stop the typing indicator. */
    private stopTyping;
}
/** Convenience for tools: file → base64 segment with the plugin's caps. */
export declare function imageSegment(path: string, maxBytes: number): Promise<OutboundSegment>;
export { OneBotNotConnectedError, OneBotActionError };
