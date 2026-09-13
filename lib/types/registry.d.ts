/**
 * The chat↔session registry (M2-D1-PR3): one live ChatAgent per QQ chat with
 * the chats/bySession dual index, session-id minting and retirement
 * (brokenSessions + the durable retired-sessions.json record), the per-chat
 * switchable-session list (switchable-sessions.json, the /session switch-back
 * history), the chat-sessions.json mapping persistence (save + debounced flush
 * + restart resume), the per-chat settings that survive /new, and the shared
 * create/resume assembly (C2) behind ensureChat/loadMapping. Extracted from
 * bridge.ts — persistence formats, retirement semantics and assembly
 * behavior are unchanged; the bridge keeps same-name facades so the command
 * table, the outbound pipeline and the session-event links keep working.
 * @module dsh-onebot/registry
 */
import type { Agent, AgentRegistry, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import type { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { MediaRef } from './cq.js';
import type { ChatId, UserRole } from './chat.js';
import type { AgentPresetsLike, BridgeConfig, SessionPersistenceLike, WorkspaceRegistryLike } from './bridge.js';
/** One switchable (retired-but-intact) session of a chat: /new, /workspace and
 * /preset switches retire the live session with its history intact — /session
 * can switch the chat back to it. Newest first, deduped, capped per chat. */
export interface SwitchableSession {
    id: string;
    retiredAt: number;
}
/** The outcome of a /session switch attempt (the command layer phrases the
 * user-facing reply from `reason`; `message` carries the resume error text). */
export type SessionSwitchOutcome = {
    ok: true;
    sessionId: string;
} | {
    ok: false;
    reason: 'busy' | 'not-switchable' | 'broken' | 'resume-failed';
    message: string;
};
/** R2: one pending serial-number selection snapshot — the numbered list a
 * bare /workspace|/model|/preset|/session rendered, kept per chat so a
 * following `/cmd <序号>` picks an entry without re-listing. `payload` stores the exact
 * resolved value (workspace path / provider id / preset id / switchable session
 * id; the model level-2 list stores the model id under `provider`). Single
 * shared slot: a fresh bare call of any kind overwrites it, other commands
 * never touch it; expiry is judged lazily at the next numeric reply (commands.ts
 * PENDING_SELECTION_TTL_MS) — no timer, and the field is never persisted. */
export interface PendingSelection {
    kind: 'workspace' | 'model' | 'preset' | 'session';
    /** /model only: 'providers' (level 1) or 'models' (level 2). */
    phase?: 'providers' | 'models';
    /** /model level 2: the provider the listed models belong to. */
    provider?: string;
    /** The numbered entries as displayed; payload is what a hit applies. */
    items: Array<{
        label: string;
        payload: string;
    }>;
    createdAt: number;
}
/** Per-chat settings that survive /new and collision heals (M2-D1-PR3):
 * resetChat and healSessionCollision never clear the entry, so every field
 * below keeps its value across session resets — exactly the pre-PR3 map
 * semantics. The entry is removed only by idle eviction (B8c). */
export interface ChatSettings {
    /** /workspace override (survives /new, so the next agent for the chat is
     * created under the new directory). */
    workspacePath?: string;
    /** /preset override (survives /new resets). */
    presetOverride?: string;
    /** /mode override (true=interim, false=instant); undefined defers to the
     * global config. */
    interimOverride?: boolean;
    /** /goal (reminds the model of the objective each turn). */
    goal?: string;
    /** Most recent inbound image path (for /ocr), survives /new resets. */
    lastImagePath?: string;
    /** C6a: most recent inbound image ref, registered before command routing
     * so /ocr can resolve it lazily when the message carried a command. */
    pendingImageRef?: MediaRef;
    /** R2: pending serial-number selection snapshot (see PendingSelection);
     * ephemeral UI state — survives /new like every field here but never
     * persisted, and bounded by the lazy 5-minute TTL instead. */
    pendingSelection?: PendingSelection;
}
/** One live per-chat agent. */
export interface ChatAgent {
    chatId: ChatId;
    sessionId: SessionId;
    agent: Agent;
    dispose(): Promise<void>;
    /** B8c: last activity timestamp (creation, dispatchFollowup, turn events);
     * the idle sweep evicts chats idle longer than chatIdleEvictDays. */
    lastActivityAt: number;
    /** Text deferred one step in either outbound mode — proven interim by the
     * next assistant/message (flushed live), else the final at turn/end.
     * M3-D2a: the former instant-mode-only pendingFinal folded in. */
    loopPending: string | null;
    /** Sent interim messages awaiting turn/end summary (text kept for the recap
     * t2i card). `sentAt` drives the per-message auto-recall scheduled after
     * each interim's send completes. */
    loopBuffer: Array<{
        id: string;
        text: string;
        sentAt: number;
    }>;
    /** Per-interim 90s (config interimRecallMs) auto-recall timers, keyed by
     * message id; cleared when turn/end recalls the originals immediately. */
    recallTimers: Map<string, ReturnType<typeof setTimeout>>;
    /** Interim message ids already auto-revoked by their 90s timer during a long
     * turn — skipped by the turn/end immediate recall (already gone from QQ). */
    recalledInterimIds: Set<string>;
    /** Last assistant message id already handled — duplicate session events
     * (streaming/usage re-emits of the same message) must not re-send it. */
    lastHandledMessageId: string | undefined;
    /** Whether a turn is currently generating. */
    busy: boolean;
    /** B7: dispatch timestamps of normal (non-command) messages inside the
     * current 60s sliding window (rateLimitPerMinute). */
    dispatchTimes: number[];
    /** B7: when the last rate-limit notice was sent (at most one per window). */
    rateLimitNoticeAt: number | undefined;
    typingTimer: ReturnType<typeof setInterval> | undefined;
    lastNickname: string;
    /** Roles of dispatched turns not yet opened (FIFO, consumed at turn/start). */
    pendingTurnRoles: UserRole[];
    /** Role of the currently running turn; stays 'member' (fail-closed) until a
     * turn/start assigns the head of pendingTurnRoles. */
    activeTurnRole: UserRole;
    /** The last user message text actually fed to the agent (for /retry). */
    lastFollowup: string | undefined;
    /** Mutable per-agent model selection (installModelSelection-bound); the
     * /model command swaps `.current` for the next step. */
    selectionRef: ModelSelectionRef | undefined;
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
/** What the registry touches. Deliberately narrower than BridgeDeps: the
 * agent registry, the persistence/workspace/preset services, the config
 * subset the registry reads, and three bridge-owned hooks — the stop flag,
 * the typing-indicator teardown for a chat leaving the registry, and the
 * channel-scope installer (the qq_* tools call back into the bridge, so the
 * agent setup closure cannot be assembled without it). */
export interface RegistryDeps {
    agents: AgentRegistry;
    /** Durable session store: B8c flushes a session before its chat is evicted. */
    sessions: SessionStore;
    sessionPersistence: SessionPersistenceLike | undefined;
    workspaceRegistry: WorkspaceRegistryLike | undefined;
    agentPresets: AgentPresetsLike | undefined;
    defaultModel: (() => ModelSelection | undefined) | undefined;
    /** The only config fields the registry reads. */
    config: Pick<BridgeConfig, 'mediaDir' | 'workspacePath' | 'agentPreset' | 'restrictedMemberPrefix' | 'maxImageBytes' | 'maxVoiceBytes' | 'maxFileBytes' | 'chatIdleEvictDays'>;
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** Bridge stop flag (guards the resume loop). */
    isStopping(): boolean;
    /** Bridge-owned chat runtime teardown when a chat leaves the registry:
     * stop the typing indicator. Interim recall timers are cleared by the
     * registry itself (ChatAgent state), keeping the reset/heal semantics
     * byte-identical to the pre-split code. */
    onChatRemoved(chat: ChatAgent): void;
    /** Register the QQ platform prompt section + qq_* tools on a new agent's
     * own scope — bridge-owned because the tools call back into the bridge. */
    installChannelScope(agentCtx: Context): void;
}
/**
 * The chat↔session registry: dual index, persistence pair, per-chat settings
 * and the shared create/resume assembly. Created by the ChatBridge
 * constructor; the bridge delegates its same-name registry methods here.
 */
export declare class ChatRegistry {
    private readonly deps;
    /** Live chats by chat id. */
    readonly chats: Map<string, ChatAgent>;
    /** Reverse index: session id → chat id (routes session events to chats). */
    readonly bySession: Map<string, string>;
    /** Per-chat settings (workspace/preset/mode/goal/ocr), lazy-created. */
    private readonly chatSettings;
    /** Session ids whose persisted logs are unusable (collision heals, failed
     * resumes, create collisions); creates must avoid them. Deliberately kept
     * apart from retiredSessionIds: /session's soft-retired (switchable) ids
     * land in retiredSessionIds only, so they stay switch-back targets. */
    private readonly brokenSessions;
    /** Session ids retired across restarts (durable copy in retired-sessions.json):
     * both the broken ones and the soft-retired /session switchables. */
    retiredSessionIds: Set<string>;
    /** Per-chat switchable retired sessions (/session history), newest first. */
    private switchableByChat;
    private mappingSaveTimer;
    /** Resolves once the on-disk chat mapping has been loaded (wired by the bridge's start()). */
    mappingLoaded: Promise<void>;
    constructor(deps: RegistryDeps);
    /** The (lazy-created) settings entry for one chat. */
    getSettings(chatId: ChatId): ChatSettings;
    /** C2: default-model wiring shared by the create and resume assembly paths
     * — agent options for the registry call plus the mutable per-agent
     * selection ref (undefined when the deployment has no default model). */
    private modelWiring;
    /** C2: the AgentSetup closure shared by the create and resume assembly
     * paths. The only difference between the callers is the preset: a resumed
     * session rejoins the preset it recorded itself; a fresh create reuses the
     * config/default resolution already recorded in its header meta. */
    private buildSetup;
    /** C2: the ChatAgent literal shared by the create and resume assembly
     * paths — every field starts at its neutral initial value. `nickname` is
     * the one deliberate divergence between the callers (create seeds it from
     * the inbound message, resume keeps the pre-C2 hardcoded ''); pinned by
     * the M2-C2 characterization tests in bridge.spec.ts. */
    private createChatAgent;
    /** B8a: in-flight creates keyed by chat id — concurrent first messages for
     * one chat join a single create instead of racing (pre-B8a, two dispatches
     * could both pass the empty-map check and agents.create ran twice with the
     * same derived session id; the second chats.set won and the first agent
     * leaked). */
    private readonly pendingCreates;
    /** B8c: chats evicted for idleness, kept resumable (chat id → last session
     * id plus the D4b persisted-settings snapshot, since chatSettings is cleared
     * on eviction). NOT retired: saveMapping keeps writing them, so the mapping
     * file never drops an evicted chat and a later message resumes its session. */
    private readonly evictedChats;
    /** Get (or create) the agent for a chat. */
    ensureChat(chatId: ChatId, nickname: string): Promise<ChatAgent>;
    private createChat;
    /** T3: apply the persisted-settings snapshot (mode/goal/workspace override)
     * of an evicted or reset chat onto its settings entry — shared by the
     * evicted-resume path and its retired-session fast path. */
    private restoreEvictedSettings;
    /** Resume persisted chats from the mapping file (best-effort). */
    loadMapping(): Promise<void>;
    /** Resume one persisted chat from its recorded session id (shared by
     * loadMapping and the B8c evicted-chat resume). */
    private resumeChat;
    private mappingPath;
    /** T3 (hole C): make a just-set /workspace override durable even when the
     * chat is not live (before its first message, or after a failed resume).
     * saveMapping only writes chats/evictedChats, so a settings-only chat would
     * otherwise be dropped from the mapping on every save. Snapshots the chat
     * into evictedChats under its mapping session id — or the derived bare id
     * when the chat never went live (the resume then fails harmlessly and a
     * fresh session is created with the settings intact). No-op for a live
     * chat: the normal save path covers it. */
    noteWorkspaceOverride(chatId: ChatId): void;
    saveMapping(): Promise<void>;
    saveMappingDebounced(): void;
    /** B8c: dispose chats whose last activity is older than chatIdleEvictDays
     * (0 disables; default 7). Called before each inbound message: the session
     * is flushed, the agent disposed, and the chat removed from
     * chats/bySession/settings — NOT retired, the mapping keeps the pair so a
     * later message (or a restart) resumes the same session. */
    sweepIdleChats(): Promise<void>;
    private evictChat;
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
    loadRetired(): Promise<void>;
    private saveRetired;
    private switchablePath;
    /** Load the per-chat switchable lists from disk (same discipline as
     * loadRetired: only a missing file means "fresh start"; a read failure or
     * corrupt JSON keeps the current in-memory lists so a later save never
     * obliterates them). */
    loadSwitchable(): Promise<void>;
    /** Atomic write of the switchable lists (temp + rename, like saveRetired). */
    private saveSwitchable;
    /** The chat's switchable retired sessions (a copy; newest first). */
    switchableSessions(chatId: ChatId): SwitchableSession[];
    /** Record a just-soft-retired session as switchable for its chat: dedupe by
     * id (a later re-retire refreshes retiredAt and moves it to the front),
     * newest first, capped per chat. */
    private recordSwitchable;
    private removeSwitchable;
    /** /session switch success: the target session is live again — lift the
     * retired mark (in-memory plus the durable file) so the NORMAL resume paths
     * (restart loadMapping, idle-evict re-activation) keep finding it. The
     * create paths stay protected without the mark: hasPersistedLog catches the
     * target's own log and the create-collision fallback covers the rest. */
    private unRetireSession;
    /**
     * /session <序号>: switch a chat back to one of its switchable (soft-retired)
     * sessions. Validation is per-chat (chat A's history is invisible to chat
     * B) and refuses broken ids. With a live chat the current session is
     * soft-retired into the list first (the retire half of resetChat — the
     * settings carrier included — so a failed resume still rebuilds cleanly);
     * with no live chat the switch is carried through evictedChats like
     * noteWorkspaceOverride. On success the target is un-retired and leaves the
     * list (it is the current session); on resume failure the target is
     * hard-retired, dropped from the list, and the chat falls back to a fresh
     * session on its next message — it never gets stuck.
     */
    switchSession(chatId: ChatId, targetSessionId: string): Promise<SessionSwitchOutcome>;
    /** T3-R1 (review closure): carry the chat's persisted settings across a
     * reset or a collision heal — snapshot them into evictedChats under the
     * (about-to-be-retired) session id, so the trailing saveMapping keeps the
     * entry instead of dropping the chat's workspace/goal/mode on a restart.
     * Only persisted fields trigger the snapshot (a plain /new or heal keeps
     * the exact pre-T3 on-disk behavior: entry dropped); the recorded session
     * id is retired by the caller, so the carrier is never resumed. Shared by
     * resetChat and healSessionCollision — logic frozen to the original
     * resetChat inline snapshot. */
    private snapshotRetainedSettings;
    /**
     * Recover from a session-log collision: the live session cannot append to
     * the mismatched on-disk log, so dispose the agent and rebuild the chat on
     * a fresh session id. The user is asked to resend.
     */
    healSessionCollision(chatId: ChatId): Promise<void>;
    /**
     * Effective workspace directory for a chat's sessions: the per-chat
     * /workspace override when set, else the configured workspacePath, falling
     * back to the host process cwd.
     */
    effectiveCwd(chatId?: ChatId): string;
    /**
     * The preset id a NEW session records and joins: the configured id when set,
     * else the deployment default — the same resolution the Web surface applies,
     * so cross-channel sessions carry the same header fact. A roster that cannot
     * resolve the effective id leaves the header bare and the session uncomposed,
     * exactly like a failed mount.
     */
    resolvePresetId(chatId: ChatId): Promise<string | undefined>;
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
     * conversation stays on disk). The chat's settings (workspace/preset/mode/
     * goal/ocr) all survive — they key the NEXT session of this chat.
     */
    resetChat(chatId: ChatId): Promise<void>;
    /** Read the chat→session mapping file (for /id and /status when no live chat). */
    sessionIdFromMapping(chatId: ChatId): Promise<string | undefined>;
    /** Clear every pending interim auto-recall timer for a chat (dispose path). */
    private clearInterimTimers;
    /** Stop everything registry-owned: cancel the debounce timer, save the
     * mapping, dispose every agent, clear both indexes. */
    stop(): Promise<void>;
}
