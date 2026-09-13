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
import type { Agent, AgentRegistry, AgentSetup, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

import type { MediaRef } from './cq.js'
import type { ChatId, UserRole } from './chat.js'
import { sessionIdForChat } from './chat.js'
import type { AgentPresetsLike, BridgeConfig, SessionPersistenceLike, WorkspaceRegistryLike } from './bridge.js'
import { describeError } from './errors.js'

/** The mapping file name inside the media dir. */
const MAPPING_FILE = 'chat-sessions.json'
/** The retired-session-id file name inside the media dir (append-only). */
const RETIRED_FILE = 'retired-sessions.json'
/** The per-chat switchable-session file name inside the media dir. */
const SWITCHABLE_FILE = 'switchable-sessions.json'

/** One switchable (retired-but-intact) session of a chat: /new, /workspace and
 * /preset switches retire the live session with its history intact — /session
 * can switch the chat back to it. Newest first, deduped, capped per chat. */
export interface SwitchableSession {
  id: string
  retiredAt: number
}

/** Per-chat cap of the switchable list (hard-wired; no config surface). */
const SWITCHABLE_CAP = 20

/** The outcome of a /session switch attempt (the command layer phrases the
 * user-facing reply from `reason`; `message` carries the resume error text). */
export type SessionSwitchOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'busy' | 'not-switchable' | 'broken' | 'resume-failed'; message: string }

/** R2: one pending serial-number selection snapshot — the numbered list a
 * bare /workspace|/model|/preset|/session rendered, kept per chat so a
 * following `/cmd <序号>` picks an entry without re-listing. `payload` stores the exact
 * resolved value (workspace path / provider id / preset id / switchable session
 * id; the model level-2 list stores the model id under `provider`). Single
 * shared slot: a fresh bare call of any kind overwrites it, other commands
 * never touch it; expiry is judged lazily at the next numeric reply (commands.ts
 * PENDING_SELECTION_TTL_MS) — no timer, and the field is never persisted. */
export interface PendingSelection {
  kind: 'workspace' | 'model' | 'preset' | 'session'
  /** /model only: 'providers' (level 1) or 'models' (level 2). */
  phase?: 'providers' | 'models'
  /** /model level 2: the provider the listed models belong to. */
  provider?: string
  /** The numbered entries as displayed; payload is what a hit applies. */
  items: Array<{ label: string; payload: string }>
  createdAt: number
}

/** Per-chat settings that survive /new and collision heals (M2-D1-PR3):
 * resetChat and healSessionCollision never clear the entry, so every field
 * below keeps its value across session resets — exactly the pre-PR3 map
 * semantics. The entry is removed only by idle eviction (B8c). */
export interface ChatSettings {
  /** /workspace override (survives /new, so the next agent for the chat is
   * created under the new directory). */
  workspacePath?: string
  /** /preset override (survives /new resets). */
  presetOverride?: string
  /** /mode override (true=interim, false=instant); undefined defers to the
   * global config. */
  interimOverride?: boolean
  /** /goal (reminds the model of the objective each turn). */
  goal?: string
  /** Most recent inbound image path (for /ocr), survives /new resets. */
  lastImagePath?: string
  /** C6a: most recent inbound image ref, registered before command routing
   * so /ocr can resolve it lazily when the message carried a command. */
  pendingImageRef?: MediaRef
  /** R2: pending serial-number selection snapshot (see PendingSelection);
   * ephemeral UI state — survives /new like every field here but never
   * persisted, and bounded by the lazy 5-minute TTL instead. */
  pendingSelection?: PendingSelection
}

/** D4b: the persisted per-chat settings carried in one chat-sessions.json
 * entry (additive format: a legacy file holds a bare session-id string). T3:
 * `workspacePath` joins the additive set so a per-chat /workspace override
 * survives a restart even when the session resume fails — loadMapping
 * restores it BEFORE the resume attempt (hole B), and the /workspace switch
 * path flushes the mapping (hole C). */
interface PersistedChatSettings {
  session: string
  interimOverride?: boolean
  goal?: string
  workspacePath?: string
}

/** D4b: build one mapping entry — a bare session id when the chat carries no
 * persisted settings (byte-identical to the legacy format), else an object
 * with the optional mode/goal/workspace fields. An empty workspacePath counts
 * as unset (never persisted). */
function persistEntry(sessionId: string, interimOverride: boolean | undefined, goal: string | undefined, workspacePath: string | undefined): string | PersistedChatSettings {
  const ws = workspacePath !== undefined && workspacePath !== '' ? workspacePath : undefined
  if (interimOverride === undefined && goal === undefined && ws === undefined) return sessionId
  const entry: PersistedChatSettings = { session: sessionId }
  if (interimOverride !== undefined) entry.interimOverride = interimOverride
  if (goal !== undefined) entry.goal = goal
  if (ws !== undefined) entry.workspacePath = ws
  return entry
}

/** One live per-chat agent. */
export interface ChatAgent {
  chatId: ChatId
  sessionId: SessionId
  agent: Agent
  dispose(): Promise<void>
  /** B8c: last activity timestamp (creation, dispatchFollowup, turn events);
   * the idle sweep evicts chats idle longer than chatIdleEvictDays. */
  lastActivityAt: number
  /** Text deferred one step in either outbound mode — proven interim by the
   * next assistant/message (flushed live), else the final at turn/end.
   * M3-D2a: the former instant-mode-only pendingFinal folded in. */
  loopPending: string | null
  /** Sent interim messages awaiting turn/end summary (text kept for the recap
   * t2i card). `sentAt` drives the per-message auto-recall scheduled after
   * each interim's send completes. */
  loopBuffer: Array<{ id: string; text: string; sentAt: number }>
  /** Per-interim 90s (config interimRecallMs) auto-recall timers, keyed by
   * message id; cleared when turn/end recalls the originals immediately. */
  recallTimers: Map<string, ReturnType<typeof setTimeout>>
  /** Interim message ids already auto-revoked by their 90s timer during a long
   * turn — skipped by the turn/end immediate recall (already gone from QQ). */
  recalledInterimIds: Set<string>
  /** Last assistant message id already handled — duplicate session events
   * (streaming/usage re-emits of the same message) must not re-send it. */
  lastHandledMessageId: string | undefined
  /** Whether a turn is currently generating. */
  busy: boolean
  /** B7: dispatch timestamps of normal (non-command) messages inside the
   * current 60s sliding window (rateLimitPerMinute). */
  dispatchTimes: number[]
  /** B7: when the last rate-limit notice was sent (at most one per window). */
  rateLimitNoticeAt: number | undefined
  typingTimer: ReturnType<typeof setInterval> | undefined
  lastNickname: string
  /** Roles of dispatched turns not yet opened (FIFO, consumed at turn/start). */
  pendingTurnRoles: UserRole[]
  /** Role of the currently running turn; stays 'member' (fail-closed) until a
   * turn/start assigns the head of pendingTurnRoles. */
  activeTurnRole: UserRole
  /** The last user message text actually fed to the agent (for /retry). */
  lastFollowup: string | undefined
  /** Mutable per-agent model selection (installModelSelection-bound); the
   * /model command swaps `.current` for the next step. */
  selectionRef: ModelSelectionRef | undefined
}

/** The preset id a session's own record names: newest logged selection, else the creation header. */
export function resolveRecordedPreset(
  inspection: { meta: { agentPreset?: string }; events: readonly { type?: string; data?: { agentPreset?: string } }[] },
): string | undefined {
  const events = inspection.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
      return event.data.agentPreset
    }
  }
  return inspection.meta.agentPreset
}

/** What the registry touches. Deliberately narrower than BridgeDeps: the
 * agent registry, the persistence/workspace/preset services, the config
 * subset the registry reads, and three bridge-owned hooks — the stop flag,
 * the typing-indicator teardown for a chat leaving the registry, and the
 * channel-scope installer (the qq_* tools call back into the bridge, so the
 * agent setup closure cannot be assembled without it). */
export interface RegistryDeps {
  agents: AgentRegistry
  /** Durable session store: B8c flushes a session before its chat is evicted. */
  sessions: SessionStore
  sessionPersistence: SessionPersistenceLike | undefined
  workspaceRegistry: WorkspaceRegistryLike | undefined
  agentPresets: AgentPresetsLike | undefined
  defaultModel: (() => ModelSelection | undefined) | undefined
  /** The only config fields the registry reads. */
  config: Pick<BridgeConfig, 'mediaDir' | 'workspacePath' | 'agentPreset' | 'restrictedMemberPrefix' | 'maxImageBytes' | 'maxVoiceBytes' | 'maxFileBytes' | 'chatIdleEvictDays'>
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
  /** Bridge stop flag (guards the resume loop). */
  isStopping(): boolean
  /** Bridge-owned chat runtime teardown when a chat leaves the registry:
   * stop the typing indicator. Interim recall timers are cleared by the
   * registry itself (ChatAgent state), keeping the reset/heal semantics
   * byte-identical to the pre-split code. */
  onChatRemoved(chat: ChatAgent): void
  /** Register the QQ platform prompt section + qq_* tools on a new agent's
   * own scope — bridge-owned because the tools call back into the bridge. */
  installChannelScope(agentCtx: Context): void
}

/**
 * The chat↔session registry: dual index, persistence pair, per-chat settings
 * and the shared create/resume assembly. Created by the ChatBridge
 * constructor; the bridge delegates its same-name registry methods here.
 */
export class ChatRegistry {
  private readonly deps: RegistryDeps
  /** Live chats by chat id. */
  readonly chats = new Map<ChatId, ChatAgent>()
  /** Reverse index: session id → chat id (routes session events to chats). */
  readonly bySession = new Map<string, ChatId>()
  /** Per-chat settings (workspace/preset/mode/goal/ocr), lazy-created. */
  private readonly chatSettings = new Map<ChatId, ChatSettings>()
  /** Session ids whose persisted logs are unusable (collision heals, failed
   * resumes, create collisions); creates must avoid them. Deliberately kept
   * apart from retiredSessionIds: /session's soft-retired (switchable) ids
   * land in retiredSessionIds only, so they stay switch-back targets. */
  private readonly brokenSessions = new Set<string>()
  /** Session ids retired across restarts (durable copy in retired-sessions.json):
   * both the broken ones and the soft-retired /session switchables. */
  retiredSessionIds = new Set<string>()
  /** Per-chat switchable retired sessions (/session history), newest first. */
  private switchableByChat = new Map<ChatId, SwitchableSession[]>()
  private mappingSaveTimer: ReturnType<typeof setTimeout> | undefined
  /** Resolves once the on-disk chat mapping has been loaded (wired by the bridge's start()). */
  mappingLoaded: Promise<void> = Promise.resolve()

  constructor(deps: RegistryDeps) {
    this.deps = deps
  }

  /** The (lazy-created) settings entry for one chat. */
  getSettings(chatId: ChatId): ChatSettings {
    let settings = this.chatSettings.get(chatId)
    if (settings === undefined) {
      settings = {}
      this.chatSettings.set(chatId, settings)
    }
    return settings
  }

  // ------------------------------------------------------------ chat lifecycle

  /** C2: default-model wiring shared by the create and resume assembly paths
   * — agent options for the registry call plus the mutable per-agent
   * selection ref (undefined when the deployment has no default model). */
  private modelWiring(): { agentOptions: { provider?: string; model?: string }; selectionRef: ModelSelectionRef | undefined } {
    const selection = this.deps.defaultModel?.()
    const agentOptions: { provider?: string; model?: string } = {}
    if (selection !== undefined) {
      agentOptions.provider = selection.provider
      agentOptions.model = selection.model
    }
    const selectionRef = selection !== undefined
      ? { current: selection, assembled: undefined }
      : undefined
    return { agentOptions, selectionRef }
  }

  /** C2: the AgentSetup closure shared by the create and resume assembly
   * paths. The only difference between the callers is the preset: a resumed
   * session rejoins the preset it recorded itself; a fresh create reuses the
   * config/default resolution already recorded in its header meta. */
  private buildSetup(selectionRef: ModelSelectionRef | undefined, recordedPreset?: string): AgentSetup {
    return async agentCtx => {
      this.deps.installChannelScope(agentCtx)
      await this.joinPreset(agentCtx, recordedPreset)
      if (selectionRef !== undefined) {
        installModelSelection(agentCtx, selectionRef)
      }
    }
  }

  /** C2: the ChatAgent literal shared by the create and resume assembly
   * paths — every field starts at its neutral initial value. `nickname` is
   * the one deliberate divergence between the callers (create seeds it from
   * the inbound message, resume keeps the pre-C2 hardcoded ''); pinned by
   * the M2-C2 characterization tests in bridge.spec.ts. */
  private createChatAgent(
    chatId: ChatId,
    handle: { agent: Agent; dispose(): Promise<void> },
    selectionRef: ModelSelectionRef | undefined,
    nickname: string,
  ): ChatAgent {
    return {
      chatId,
      sessionId: handle.agent.session.id,
      agent: handle.agent,
      dispose: () => handle.dispose(),
      lastActivityAt: Date.now(),
      loopPending: null,
      loopBuffer: [],
      recallTimers: new Map(),
      recalledInterimIds: new Set(),
      lastHandledMessageId: undefined,
      busy: false,
      dispatchTimes: [],
      rateLimitNoticeAt: undefined,
      typingTimer: undefined,
      lastNickname: nickname,
      pendingTurnRoles: [],
      activeTurnRole: 'member',
      lastFollowup: undefined,
      selectionRef,
    }
  }

  /** B8a: in-flight creates keyed by chat id — concurrent first messages for
   * one chat join a single create instead of racing (pre-B8a, two dispatches
   * could both pass the empty-map check and agents.create ran twice with the
   * same derived session id; the second chats.set won and the first agent
   * leaked). */
  private readonly pendingCreates = new Map<ChatId, Promise<ChatAgent>>()

  /** B8c: chats evicted for idleness, kept resumable (chat id → last session
   * id plus the D4b persisted-settings snapshot, since chatSettings is cleared
   * on eviction). NOT retired: saveMapping keeps writing them, so the mapping
   * file never drops an evicted chat and a later message resumes its session. */
  private readonly evictedChats = new Map<ChatId, PersistedChatSettings>()

  /** Get (or create) the agent for a chat. */
  async ensureChat(chatId: ChatId, nickname: string): Promise<ChatAgent> {
    const existing = this.chats.get(chatId)
    if (existing !== undefined) return existing
    const pending = this.pendingCreates.get(chatId)
    if (pending !== undefined) return pending
    const creation = this.createChat(chatId, nickname)
    this.pendingCreates.set(chatId, creation)
    void creation.finally(() => {
      this.pendingCreates.delete(chatId)
    }).catch(() => undefined)
    return creation
  }

  private async createChat(chatId: ChatId, nickname: string): Promise<ChatAgent> {
    await this.mappingLoaded
    // B8c: a chat evicted for idleness resumes its recorded session instead
    // of forking a fresh one — the mapping entry was kept for exactly this.
    const evicted = this.evictedChats.get(chatId)
    if (evicted !== undefined) {
      if (this.isSessionIdBlocked(evicted.session)) {
        // T3: the snapshot records a retired session (resetChat keeps the
        // mapping entry as a settings carrier after /new or a /workspace
        // switch). Resuming it would resurrect retired history — skip the
        // resume, keep the settings, and fall through to a fresh create.
        this.restoreEvictedSettings(chatId, evicted)
        this.evictedChats.delete(chatId)
      } else {
        try {
          const resumed = await this.resumeChat(chatId, evicted.session)
          // D4b/T3: the evicted chat's persisted mode/goal/workspace come back with it.
          this.restoreEvictedSettings(chatId, evicted)
          this.evictedChats.delete(chatId)
          return resumed
        } catch (error) {
          this.retireSession(evicted.session)
          this.evictedChats.delete(chatId)
          this.deps.log('warn', 'resume of evicted session failed for ' + chatId + '; falling back to a fresh session: ' + describeError(error))
        }
      }
    }
    let sessionId = makeSessionId(sessionIdForChat(chatId))
    if (this.isSessionIdBlocked(sessionId)) {
      sessionId = this.freshSessionId(chatId)
    } else if (await this.hasPersistedLog(sessionId)) {
      // The bare id still owns a stale on-disk log (e.g. the retired record
      // was lost in an earlier crash): reusing it would collide, so retire it
      // NOW and move to a suffixed id instead of failing the chat later.
      this.retireSession(sessionId)
      sessionId = this.freshSessionId(chatId)
    }
    const { agentOptions, selectionRef } = this.modelWiring()
    const cwd = this.effectiveCwd(chatId)
    const presetId = await this.resolvePresetId(chatId)
    const meta: { cwd: string; agentPreset?: string } = { cwd }
    if (presetId !== undefined) meta.agentPreset = presetId
    const setup = this.buildSetup(selectionRef)
    let handle: { agent: Agent; dispose(): Promise<void> }
    try {
      handle = await this.deps.agents.create({
        sessionId,
        meta,
        agentOptions,
        setup,
      })
    } catch (error) {
      // A stale or foreign persisted log under the same id blocks creation
      // (id collision). Recover with a fresh suffixed session id instead of
      // failing the chat.
      this.retireSession(sessionId)
      const fallbackId = this.freshSessionId(chatId)
      this.deps.log('warn', 'agent create failed (' + describeError(error) + '); retrying with ' + fallbackId)
      handle = await this.deps.agents.create({
        sessionId: fallbackId,
        meta,
        agentOptions,
        setup,
      })
      this.deps.log('info', 'recovered with fresh session ' + fallbackId + ' for ' + chatId)
    }
    // The real session id is authoritative (the fallback path above creates a
    // different id than the one initially attempted); record it everywhere so
    // session events route to this chat and the mapping persists the truth.
    const actualSessionId = handle.agent.session.id
    await this.attachToWorkspace(actualSessionId, handle.agent.session.header?.cwd)
    const chat = this.createChatAgent(chatId, handle, selectionRef, nickname)
    try {
      await handle.agent.whenIdle()
    } catch (error) {
      // B8b: create succeeded but the first idle wait failed — dispose the
      // orphan agent instead of leaking it.
      try {
        await handle.dispose()
      } catch {
        // the whenIdle failure is the cause; a dispose failure must not mask it
      }
      throw error
    }
    this.chats.set(chatId, chat)
    this.bySession.set(actualSessionId, chatId)
    this.deps.log('info', 'agent created for ' + chatId + ' (session ' + actualSessionId + ')')
    void this.saveMapping()
    return chat
  }

  /** T3: apply the persisted-settings snapshot (mode/goal/workspace override)
   * of an evicted or reset chat onto its settings entry — shared by the
   * evicted-resume path and its retired-session fast path. */
  private restoreEvictedSettings(chatId: ChatId, evicted: PersistedChatSettings): void {
    const settings = this.getSettings(chatId)
    if (evicted.interimOverride !== undefined) settings.interimOverride = evicted.interimOverride
    if (evicted.goal !== undefined) settings.goal = evicted.goal
    if (evicted.workspacePath !== undefined && evicted.workspacePath !== '') settings.workspacePath = evicted.workspacePath
  }

  /** Resume persisted chats from the mapping file (best-effort). */
  async loadMapping(): Promise<void> {
    try {
      const content = await readFile(this.mappingPath(), 'utf8')
      // D4b/T3: additive format — a legacy entry is a bare session-id string; a
      // new entry is { session, interimOverride?, goal?, workspacePath? }.
      const mapping = JSON.parse(content) as Record<string, string | PersistedChatSettings>
      this.deps.log('debug', 'mapping file has ' + Object.keys(mapping).length + ' chat(s)')
      for (const [chatId, entry] of Object.entries(mapping)) {
        const sessionId = typeof entry === 'string' ? entry : entry?.session
        if (typeof sessionId !== 'string' || sessionId === '') continue
        // Restore the persisted mode/goal/workspace override BEFORE the resume
        // attempt (old files carry neither — the settings then fall back to
        // their current defaults). T3: restoring the override first closes the
        // hole where a failed resume (retire → fresh session) lost the
        // per-chat /workspace choice.
        if (typeof entry === 'object' && entry !== null) {
          const settings = this.getSettings(chatId)
          if (typeof entry.interimOverride === 'boolean') settings.interimOverride = entry.interimOverride
          if (typeof entry.goal === 'string' && entry.goal !== '') settings.goal = entry.goal
          if (typeof entry.workspacePath === 'string' && entry.workspacePath !== '') settings.workspacePath = entry.workspacePath
        }
        // T3: a durably retired session id (recorded by resetChat's settings
        // snapshot) must never be resumed — the entry only carries the
        // settings for the chat's NEXT session. T3-R1 (review closure): keep
        // the object entry in evictedChats so any mid-flight saveMapping
        // (stop(), another chat's createChat) still writes it — a
        // settings-only chat sits in neither chats nor evictedChats, and one
        // dropped save would erase workspacePath/goal/mode from the file
        // before the next restart.
        if (this.retiredSessionIds.has(sessionId)) {
          this.deps.log('debug', 'skipping resume of retired session ' + sessionId + ' for ' + chatId + ' (settings only)')
          if (typeof entry === 'object' && entry !== null) this.evictedChats.set(chatId, entry)
          continue
        }
        this.deps.log('debug', 'attempting resume of ' + chatId + ' @ ' + sessionId)
        if (this.deps.isStopping()) return
        try {
          await this.resumeChat(chatId, sessionId)
        } catch (error) {
          this.retireSession(sessionId)
          this.deps.log('warn', 'resume failed for ' + chatId + ': ' + describeError(error))
        }
      }
    } catch {
      // No mapping file yet — fresh start.
    }
  }

  /** Resume one persisted chat from its recorded session id (shared by
   * loadMapping and the B8c evicted-chat resume). */
  private async resumeChat(chatId: ChatId, sessionId: string): Promise<ChatAgent> {
    const { agentOptions, selectionRef } = this.modelWiring()
    const recordedPreset = await this.recordedPresetFor(makeSessionId(sessionId))
    const handle = await this.deps.agents.resume({
      resumeSessionId: makeSessionId(sessionId),
      agentOptions,
      setup: this.buildSetup(selectionRef, recordedPreset),
    })
    await this.attachToWorkspace(handle.agent.session.id, handle.agent.session.header?.cwd)
    // /workspace persistence across restarts: the per-chat override map is
    // in-memory only, but a session's cwd is frozen in its header. When the
    // resumed session's directory differs from what this chat would default
    // to now, restore it as the override so /workspace and future /new
    // sessions keep using it.
    const headerCwd = handle.agent.session.header?.cwd
    if (headerCwd !== undefined && headerCwd !== '' && headerCwd !== this.effectiveCwd()) {
      this.getSettings(chatId).workspacePath = headerCwd
      this.deps.log('debug', 'workspace override restored for ' + chatId + ': ' + headerCwd)
    }
    const chat = this.createChatAgent(chatId, handle, selectionRef, '')
    try {
      await handle.agent.whenIdle()
    } catch (error) {
      // B8b: same orphan rule as the create path — dispose before rethrowing.
      try {
        await handle.dispose()
      } catch {
        // the whenIdle failure is the cause
      }
      throw error
    }
    this.chats.set(chatId, chat)
    this.bySession.set(handle.agent.session.id, chatId)
    return chat
  }

  private mappingPath(): string {
    return this.deps.config.mediaDir.endsWith('/') || this.deps.config.mediaDir.endsWith('\\')
      ? this.deps.config.mediaDir + MAPPING_FILE
      : this.deps.config.mediaDir + '/' + MAPPING_FILE
  }

  /** T3 (hole C): make a just-set /workspace override durable even when the
   * chat is not live (before its first message, or after a failed resume).
   * saveMapping only writes chats/evictedChats, so a settings-only chat would
   * otherwise be dropped from the mapping on every save. Snapshots the chat
   * into evictedChats under its mapping session id — or the derived bare id
   * when the chat never went live (the resume then fails harmlessly and a
   * fresh session is created with the settings intact). No-op for a live
   * chat: the normal save path covers it. */
  noteWorkspaceOverride(chatId: ChatId): void {
    if (this.chats.has(chatId)) return
    const settings = this.chatSettings.get(chatId)
    if (settings === undefined) return
    const workspacePath = settings.workspacePath
    if (workspacePath === undefined || workspacePath === '') return
    const known = this.evictedChats.get(chatId)
    this.evictedChats.set(chatId, {
      session: known?.session ?? makeSessionId(sessionIdForChat(chatId)),
      interimOverride: settings.interimOverride ?? known?.interimOverride,
      goal: settings.goal ?? known?.goal,
      workspacePath,
    })
  }

  async saveMapping(): Promise<void> {
    try {
      await mkdir(this.deps.config.mediaDir, { recursive: true })
      const mapping: Record<string, string | PersistedChatSettings> = {}
      for (const [chatId, evicted] of this.evictedChats) {
        // T3: prefer the live settings entry over the snapshot — later
        // /mode, /goal or /workspace changes on a not-yet-resumed chat must
        // reach the file (union semantics: a field kept in only one of the
        // two places still survives).
        const live = this.chatSettings.get(chatId)
        mapping[chatId] = persistEntry(evicted.session, live?.interimOverride ?? evicted.interimOverride, live?.goal ?? evicted.goal, live?.workspacePath ?? evicted.workspacePath)
      }
      for (const chat of this.chats.values()) {
        const settings = this.chatSettings.get(chat.chatId)
        mapping[chat.chatId] = persistEntry(chat.sessionId, settings?.interimOverride, settings?.goal, settings?.workspacePath)
      }
      await writeFile(this.mappingPath(), JSON.stringify(mapping, null, 2), 'utf8')
    } catch (error) {
      this.deps.log('warn', 'mapping save failed: ' + describeError(error))
    }
  }

  saveMappingDebounced(): void {
    if (this.mappingSaveTimer !== undefined) clearTimeout(this.mappingSaveTimer)
    this.mappingSaveTimer = setTimeout(() => {
      this.mappingSaveTimer = undefined
      void this.saveMapping()
    }, 2_000).unref()
  }

  /** B8c: dispose chats whose last activity is older than chatIdleEvictDays
   * (0 disables; default 7). Called before each inbound message: the session
   * is flushed, the agent disposed, and the chat removed from
   * chats/bySession/settings — NOT retired, the mapping keeps the pair so a
   * later message (or a restart) resumes the same session. */
  async sweepIdleChats(): Promise<void> {
    const days = this.deps.config.chatIdleEvictDays ?? 7
    if (days <= 0 || this.deps.isStopping()) return
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    for (const [chatId, chat] of [...this.chats]) {
      if (chat.lastActivityAt > cutoff) continue
      await this.evictChat(chatId, chat)
    }
  }

  private async evictChat(chatId: ChatId, chat: ChatAgent): Promise<void> {
    // Only evict a session that is durably persisted; a failed flush keeps
    // the chat alive and the sweep retries on the next message.
    try {
      await this.deps.sessions.flush(chat.agent.session)
    } catch (error) {
      this.deps.log('warn', 'idle-evict flush failed for ' + chatId + ' (keeping the chat): ' + String(error))
      return
    }
    this.deps.onChatRemoved(chat)
    this.clearInterimTimers(chat)
    this.chats.delete(chatId)
    this.bySession.delete(chat.sessionId)
    // D4b/T3: snapshot the persisted settings before the eviction clears them,
    // so saveMapping keeps writing the chat's mode/goal/workspace override
    // while it is idle.
    const evictedSettings = this.chatSettings.get(chatId)
    this.evictedChats.set(chatId, {
      session: chat.sessionId,
      interimOverride: evictedSettings?.interimOverride,
      goal: evictedSettings?.goal,
      workspacePath: evictedSettings?.workspacePath,
    })
    this.chatSettings.delete(chatId)
    try {
      await chat.dispose()
    } catch (error) {
      this.deps.log('warn', 'idle-evict dispose failed: ' + String(error))
    }
    this.deps.log('info', 'evicted idle chat ' + chatId + ' (session ' + chat.sessionId + ' kept resumable)')
  }

  // ------------------------------------------------------------ retired ids

  /** Whether a session id must never be created again (this run or on disk). */
  private isSessionIdBlocked(id: string): boolean {
    return this.brokenSessions.has(id) || this.retiredSessionIds.has(id)
  }

  /** A suffixed session id for a chat that avoids every blocked id. */
  private freshSessionId(chatId: ChatId): SessionId {
    let id: SessionId
    do {
      id = makeSessionId(sessionIdForChat(chatId) + '-' + Date.now().toString(36))
    } while (this.isSessionIdBlocked(id))
    return id
  }

  /** Permanently retire a session id: in-memory plus durable on-disk record,
   * so a restart never reuses an id whose log collides with a fresh session. */
  private retireSession(id: string): void {
    this.brokenSessions.add(id)
    this.retiredSessionIds.add(id)
    void this.saveRetired()
  }

  /** Whether the persistence layer already owns a durable log for this id —
   * true means reusing the id would collide (stale on-disk log or live entry).
   * A read failure counts as no log so the caller falls back to the normal
   * path rather than blocking an id on a transient error. */
  private async hasPersistedLog(id: SessionId): Promise<boolean> {
    const persistence = this.deps.sessionPersistence
    if (persistence === undefined) return false
    try {
      await persistence.inspect(id)
      return true
    } catch {
      return false
    }
  }

  private retiredPath(): string {
    return this.deps.config.mediaDir.endsWith('/') || this.deps.config.mediaDir.endsWith('\\')
      ? this.deps.config.mediaDir + RETIRED_FILE
      : this.deps.config.mediaDir + '/' + RETIRED_FILE
  }

  async loadRetired(): Promise<void> {
    let content: string
    try {
      content = await readFile(this.retiredPath(), 'utf8')
    } catch (error) {
      // Only a missing file means "fresh start". ANY other read failure must
      // not be treated as an empty retired set — a later saveRetired() would
      // then OVERWRITE the on-disk record with nothing, silently dropping
      // every retired id (exactly the 2026-08-17 regression: the bare id
      // lost its retire record and /new collided on the stale log).
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.deps.log('warn', 'retired-sessions read failed; keeping the current set: ' + describeError(error))
      }
      return
    }
    try {
      const parsed = JSON.parse(content) as unknown
      if (Array.isArray(parsed)) {
        this.retiredSessionIds = new Set(parsed.filter((id): id is string => typeof id === 'string'))
        // Not backfilled into brokenSessions: the durable file cannot tell a
        // broken id from a soft-retired (/session switchable) one, and the
        // blocked union below already keeps every file id out of the create
        // paths. A genuinely broken id that is somehow targeted after a
        // restart fails inside switchSession's resume and falls back safely.
        this.deps.log('debug', 'retired-sessions file has ' + this.retiredSessionIds.size + ' id(s)')
      } else {
        this.deps.log('warn', 'retired-sessions file is not a JSON array; ignoring')
      }
    } catch (error) {
      // Corrupt JSON: keep the current in-memory set (never replace it with
      // an empty array) and warn so a future save does not obliterate history.
      this.deps.log('warn', 'retired-sessions file is unparsable; keeping the current set: ' + describeError(error))
    }
  }

  private async saveRetired(): Promise<void> {
    try {
      await mkdir(this.deps.config.mediaDir, { recursive: true })
      // Atomic write: a temp file + rename never leaves a half-written file
      // that a concurrent/future loadRetired could parse into a broken empty set.
      const tmpPath = this.retiredPath() + '.tmp'
      await writeFile(tmpPath, JSON.stringify(Array.from(this.retiredSessionIds), null, 2), 'utf8')
      await rename(tmpPath, this.retiredPath())
    } catch (error) {
      this.deps.log('warn', 'retired-sessions save failed: ' + describeError(error))
    }
  }

  // ---------------------------------------------------- switchable history

  private switchablePath(): string {
    return this.deps.config.mediaDir.endsWith('/') || this.deps.config.mediaDir.endsWith('\\')
      ? this.deps.config.mediaDir + SWITCHABLE_FILE
      : this.deps.config.mediaDir + '/' + SWITCHABLE_FILE
  }

  /** Load the per-chat switchable lists from disk (same discipline as
   * loadRetired: only a missing file means "fresh start"; a read failure or
   * corrupt JSON keeps the current in-memory lists so a later save never
   * obliterates them). */
  async loadSwitchable(): Promise<void> {
    let content: string
    try {
      content = await readFile(this.switchablePath(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.deps.log('warn', 'switchable-sessions read failed; keeping the current lists: ' + describeError(error))
      }
      return
    }
    try {
      const parsed = JSON.parse(content) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const loaded = new Map<ChatId, SwitchableSession[]>()
        for (const [chatId, list] of Object.entries(parsed as Record<string, unknown>)) {
          if (!Array.isArray(list)) continue
          const entries = list.filter((entry): entry is SwitchableSession =>
            entry !== null && typeof entry === 'object' &&
            typeof (entry as SwitchableSession).id === 'string' && typeof (entry as SwitchableSession).retiredAt === 'number')
          if (entries.length > 0) loaded.set(chatId, entries.slice(0, SWITCHABLE_CAP))
        }
        this.switchableByChat = loaded
        this.deps.log('debug', 'switchable-sessions file has ' + loaded.size + ' chat(s)')
      } else {
        this.deps.log('warn', 'switchable-sessions file is not a JSON object; ignoring')
      }
    } catch (error) {
      // Corrupt JSON: keep the current in-memory lists (never replace them
      // with an empty map) and warn so a future save does not drop history.
      this.deps.log('warn', 'switchable-sessions file is unparsable; keeping the current lists: ' + describeError(error))
    }
  }

  /** Atomic write of the switchable lists (temp + rename, like saveRetired). */
  private async saveSwitchable(): Promise<void> {
    try {
      await mkdir(this.deps.config.mediaDir, { recursive: true })
      const payload: Record<string, SwitchableSession[]> = {}
      for (const [chatId, list] of this.switchableByChat) payload[chatId] = list
      const tmpPath = this.switchablePath() + '.tmp'
      await writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8')
      await rename(tmpPath, this.switchablePath())
    } catch (error) {
      this.deps.log('warn', 'switchable-sessions save failed: ' + describeError(error))
    }
  }

  /** The chat's switchable retired sessions (a copy; newest first). */
  switchableSessions(chatId: ChatId): SwitchableSession[] {
    return [...(this.switchableByChat.get(chatId) ?? [])]
  }

  /** Record a just-soft-retired session as switchable for its chat: dedupe by
   * id (a later re-retire refreshes retiredAt and moves it to the front),
   * newest first, capped per chat. */
  private recordSwitchable(chatId: ChatId, sessionId: string): void {
    const rest = (this.switchableByChat.get(chatId) ?? []).filter(entry => entry.id !== sessionId)
    this.switchableByChat.set(chatId, [{ id: sessionId, retiredAt: Date.now() }, ...rest].slice(0, SWITCHABLE_CAP))
    void this.saveSwitchable()
  }

  private removeSwitchable(chatId: ChatId, sessionId: string): void {
    const list = this.switchableByChat.get(chatId)
    if (list === undefined) return
    const next = list.filter(entry => entry.id !== sessionId)
    if (next.length === 0) this.switchableByChat.delete(chatId)
    else this.switchableByChat.set(chatId, next)
    void this.saveSwitchable()
  }

  /** /session switch success: the target session is live again — lift the
   * retired mark (in-memory plus the durable file) so the NORMAL resume paths
   * (restart loadMapping, idle-evict re-activation) keep finding it. The
   * create paths stay protected without the mark: hasPersistedLog catches the
   * target's own log and the create-collision fallback covers the rest. */
  private unRetireSession(id: string): void {
    this.brokenSessions.delete(id)
    this.retiredSessionIds.delete(id)
    void this.saveRetired()
  }

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
  async switchSession(chatId: ChatId, targetSessionId: string): Promise<SessionSwitchOutcome> {
    const target = targetSessionId.trim()
    if (!(this.switchableByChat.get(chatId) ?? []).some(entry => entry.id === target)) {
      this.deps.log('warn', 'session switch rejected for ' + chatId + ': ' + target + ' is not in the chat switchable list')
      return { ok: false, reason: 'not-switchable', message: '目标会话不在该 chat 的可切回列表中' }
    }
    if (this.brokenSessions.has(target)) {
      this.deps.log('warn', 'session switch rejected for ' + chatId + ': ' + target + ' is broken')
      return { ok: false, reason: 'broken', message: '目标会话已损坏' }
    }
    const chat = this.chats.get(chatId)
    if (chat !== undefined && chat.busy) {
      return { ok: false, reason: 'busy', message: '当前会话正在生成' }
    }
    if (chat !== undefined) {
      // The retire half of resetChat: keep the settings carrier, then retire
      // the live session as SOFT-retired (switchable, not broken) and record
      // it so the user can switch back later.
      this.snapshotRetainedSettings(chatId, chat.sessionId)
      this.deps.onChatRemoved(chat)
      this.clearInterimTimers(chat)
      this.retiredSessionIds.add(chat.sessionId)
      void this.saveRetired()
      this.recordSwitchable(chatId, chat.sessionId)
      this.chats.delete(chatId)
      this.bySession.delete(chat.sessionId)
      try {
        await chat.dispose()
      } catch (error) {
        this.deps.log('warn', 'session switch dispose failed: ' + describeError(error))
      }
    } else {
      // Chat not live (before its first message / after a failed resume):
      // carry the switch through the evictedChats carrier exactly like
      // noteWorkspaceOverride — saveMapping only writes chats/evictedChats,
      // and the next message's createChat resumes the (un-retired) target
      // from the carrier. On resume failure below the carrier points at the
      // hard-retired target, which the evicted branch skips into a fresh
      // create with the settings intact.
      const settings = this.chatSettings.get(chatId)
      const known = this.evictedChats.get(chatId)
      this.evictedChats.set(chatId, {
        session: target,
        interimOverride: settings?.interimOverride ?? known?.interimOverride,
        goal: settings?.goal ?? known?.goal,
        workspacePath: settings?.workspacePath ?? known?.workspacePath,
      })
    }
    try {
      await this.resumeChat(chatId, target)
    } catch (error) {
      // The target's log is unusable: hard-retire it, drop it from the list
      // and let the chat rebuild on a fresh session (never stuck).
      this.retireSession(target)
      this.removeSwitchable(chatId, target)
      void this.saveMapping()
      this.deps.log('warn', 'session switch resume failed for ' + chatId + ' -> ' + target + '; falling back to a fresh session: ' + describeError(error))
      return { ok: false, reason: 'resume-failed', message: describeError(error) }
    }
    this.unRetireSession(target)
    this.removeSwitchable(chatId, target)
    // The live (or just-resumed) chat owns the mapping entry now; drop any
    // stale carrier so it cannot shadow the fresh entry.
    this.evictedChats.delete(chatId)
    void this.saveMapping()
    this.deps.log('info', 'session switch for ' + chatId + ' -> ' + target)
    return { ok: true, sessionId: target }
  }

  /** T3-R1 (review closure): carry the chat's persisted settings across a
   * reset or a collision heal — snapshot them into evictedChats under the
   * (about-to-be-retired) session id, so the trailing saveMapping keeps the
   * entry instead of dropping the chat's workspace/goal/mode on a restart.
   * Only persisted fields trigger the snapshot (a plain /new or heal keeps
   * the exact pre-T3 on-disk behavior: entry dropped); the recorded session
   * id is retired by the caller, so the carrier is never resumed. Shared by
   * resetChat and healSessionCollision — logic frozen to the original
   * resetChat inline snapshot. */
  private snapshotRetainedSettings(chatId: ChatId, sessionId: string): void {
    const settings = this.chatSettings.get(chatId)
    if (settings?.interimOverride !== undefined || settings?.goal !== undefined || (settings?.workspacePath !== undefined && settings?.workspacePath !== '')) {
      this.evictedChats.set(chatId, {
        session: sessionId,
        interimOverride: settings.interimOverride,
        goal: settings.goal,
        workspacePath: settings.workspacePath,
      })
    }
  }

  /**
   * Recover from a session-log collision: the live session cannot append to
   * the mismatched on-disk log, so dispose the agent and rebuild the chat on
   * a fresh session id. The user is asked to resend.
   */
  async healSessionCollision(chatId: ChatId): Promise<void> {
    const chat = this.chats.get(chatId)
    if (chat === undefined) return
    // T3-R1 (review closure): same settings carrier as resetChat — without
    // the snapshot the trailing saveMapping drops the chat entirely (it sits
    // in neither chats nor evictedChats), losing workspacePath/goal/mode on a
    // restart before the next message. Only persisted fields trigger it.
    this.snapshotRetainedSettings(chatId, chat.sessionId)
    this.retireSession(chat.sessionId)
    // The bare derived id shares the chat's stale log; retire it too so the
    // next ensureChat can never pick it again in this run OR after a restart.
    this.retireSession(sessionIdForChat(chatId))
    this.chats.delete(chatId)
    this.bySession.delete(chat.sessionId)
    this.deps.onChatRemoved(chat)
    try {
      await chat.dispose()
    } catch (error) {
      this.deps.log('warn', 'collision heal dispose failed: ' + String(error))
    }
    this.deps.log('warn', 'healed session collision for ' + chatId + '; a fresh session will be created on next message')
    void this.saveMapping()
  }

  // ------------------------------------------------------------ workspace & preset

  /**
   * Effective workspace directory for a chat's sessions: the per-chat
   * /workspace override when set, else the configured workspacePath, falling
   * back to the host process cwd.
   */
  effectiveCwd(chatId?: ChatId): string {
    if (chatId !== undefined) {
      const override = this.getSettings(chatId).workspacePath
      if (override !== undefined && override !== '') return override
    }
    const configured = this.deps.config.workspacePath
    return configured !== undefined && configured !== '' ? configured : process.cwd()
  }

  /**
   * The preset id a NEW session records and joins: the configured id when set,
   * else the deployment default — the same resolution the Web surface applies,
   * so cross-channel sessions carry the same header fact. A roster that cannot
   * resolve the effective id leaves the header bare and the session uncomposed,
   * exactly like a failed mount.
   */
  async resolvePresetId(chatId: ChatId): Promise<string | undefined> {
    // A /preset override wins for this chat (survives /new, so the re-created
    // session registers the chosen preset in its header).
    const override = chatId !== undefined ? this.getSettings(chatId).presetOverride : undefined
    if (override !== undefined && override !== '') return override
    const presets = this.deps.agentPresets
    if (presets === undefined) return undefined
    const configured = this.deps.config.agentPreset
    const wanted = configured !== undefined && configured !== '' ? configured : presets.defaultId
    try {
      const preset = await presets.resolve(wanted)
      return preset.id
    } catch (error) {
      this.deps.log('warn', 'agent preset resolve failed; session header records no preset: ' + describeError(error))
      return undefined
    }
  }

  /**
   * The preset id a persisted session recorded for itself (newest logged
   * selection wins, else the creation header), or undefined when it recorded
   * none or the record cannot be read — a legacy session resumes under the
   * config/default, preserving its original behavior.
   */
  private async recordedPresetFor(sessionId: SessionId): Promise<string | undefined> {
    const persistence = this.deps.sessionPersistence
    if (persistence === undefined) return undefined
    try {
      const inspection = await persistence.inspect(sessionId)
      return resolveRecordedPreset(inspection)
    } catch (error) {
      this.deps.log('warn', 'preset record read failed for ' + sessionId + ' (falling back to config/default): ' + describeError(error))
      return undefined
    }
  }

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
  private async joinPreset(agentCtx: unknown, preferred?: string): Promise<void> {
    if (this.deps.agentPresets === undefined) return
    const configured = this.deps.config.agentPreset
    if (preferred !== undefined && configured !== undefined && configured !== '' && configured !== preferred) {
      this.deps.log('warn', 'session records preset ' + preferred + ' but plugin config names ' + configured + '; resuming under the recorded preset')
    }
    const selected = preferred ?? (configured !== undefined && configured !== '' ? configured : undefined)
    try {
      const preset = await this.deps.agentPresets.mount(agentCtx, selected)
      this.deps.log('debug', 'agent joined preset ' + preset.id)
    } catch (error) {
      this.deps.log('warn', 'agent preset mount failed (tools fall back to the global layer): ' + describeError(error))
    }
  }

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
  private async attachToWorkspace(sessionId: string, headerCwd: string | undefined): Promise<void> {
    const registry = this.deps.workspaceRegistry
    if (registry === undefined) return
    try {
      if (headerCwd === undefined || headerCwd === '') {
        this.deps.log('warn', 'workspace attach skipped: session header carries no cwd')
        return
      }
      const workspace = await registry.resolveByPath(headerCwd)
      if (workspace === undefined) {
        if (headerCwd !== this.effectiveCwd()) {
          this.deps.log('debug', 'workspace attach skipped: no workspace owns ' + headerCwd + ' and it differs from the configured workspacePath')
          return
        }
        const created = await registry.create(headerCwd)
        this.deps.log('info', 'created workspace for ' + headerCwd)
        await created.attachSession(sessionId)
        this.deps.log('info', 'attached session ' + sessionId + ' to workspace ' + headerCwd)
        return
      }
      await workspace.attachSession(sessionId)
      this.deps.log('info', 'attached session ' + sessionId + ' to workspace ' + headerCwd)
    } catch (error) {
      this.deps.log('warn', 'workspace attach failed for ' + sessionId + ': ' + describeError(error))
    }
  }

  /**
   * /new: dispose the current chat agent and retire its session id, so the
   * next inbound message creates a brand-new session (fresh history; the old
   * conversation stays on disk). The chat's settings (workspace/preset/mode/
   * goal/ocr) all survive — they key the NEXT session of this chat.
   */
  async resetChat(chatId: ChatId): Promise<void> {
    const chat = this.chats.get(chatId)
    if (chat !== undefined) {
      // T3 (hole C): keep the mapping entry alive across the reset — without a
      // snapshot the trailing saveMapping drops the chat entirely (it sits in
      // neither chats nor evictedChats), losing the /workspace override (and
      // mode/goal) on any restart before the next message. The retired session
      // id is never resumed: createChat skips blocked snapshots and loadMapping
      // skips durably retired ids. Only persisted fields trigger the snapshot —
      // a plain /new keeps the exact pre-T3 on-disk behavior (entry dropped).
      // T3-R1 (review): the identical snapshot now also covers collision heals.
      this.snapshotRetainedSettings(chatId, chat.sessionId)
      this.deps.onChatRemoved(chat)
      this.clearInterimTimers(chat)
      // SOFT retire (not brokenSessions): the old session's history is
      // intact, and /session must keep it switchable — the durable retired
      // record still keeps the id out of every create path (blocked union).
      this.retiredSessionIds.add(chat.sessionId)
      void this.saveRetired()
      this.recordSwitchable(chatId, chat.sessionId)
      // The bare derived id is forever unsafe for this chat once its history
      // has moved to a suffixed id: its on-disk log (if any) would collide
      // with any future bare-id session. Retire it up front so a /new after a
      // restart — when only the retired file protects us — stays safe.
      // Skipped when it IS the current session (a first-generation /new): the
      // soft retire above already covers it, and a hard retire would mark the
      // chat's own first session broken and un-switchable for /session.
      const bareId = sessionIdForChat(chatId)
      if (bareId !== chat.sessionId) this.retireSession(bareId)
      this.chats.delete(chatId)
      this.bySession.delete(chat.sessionId)
      try {
        await chat.dispose()
      } catch (error) {
        this.deps.log('warn', 'reset dispose failed: ' + describeError(error))
      }
      this.deps.log('info', 'reset chat ' + chatId + ' (old session ' + chat.sessionId + ' retired)')
    }
    void this.saveMapping()
  }

  /** Read the chat→session mapping file (for /id and /status when no live chat). */
  async sessionIdFromMapping(chatId: ChatId): Promise<string | undefined> {
    const file = joinMappingPath(this.deps.config.mediaDir)
    try {
      const text = await readFile(file, 'utf8')
      const map = JSON.parse(text) as Record<string, string | PersistedChatSettings>
      const entry = map[chatId]
      const id = typeof entry === 'string' ? entry : entry?.session
      return typeof id === 'string' && id !== '' ? id : undefined
    } catch {
      return undefined
    }
  }

  /** Clear every pending interim auto-recall timer for a chat (dispose path). */
  private clearInterimTimers(chat: ChatAgent): void {
    for (const timer of chat.recallTimers.values()) clearTimeout(timer)
    chat.recallTimers.clear()
  }

  /** Stop everything registry-owned: cancel the debounce timer, save the
   * mapping, dispose every agent, clear both indexes. */
  async stop(): Promise<void> {
    if (this.mappingSaveTimer !== undefined) {
      clearTimeout(this.mappingSaveTimer)
      this.mappingSaveTimer = undefined
    }
    await this.saveMapping()
    for (const chat of this.chats.values()) {
      this.deps.onChatRemoved(chat)
      this.clearInterimTimers(chat)
      try {
        await chat.dispose()
      } catch (error) {
        this.deps.log('warn', 'agent dispose failed: ' + String(error))
      }
    }
    this.chats.clear()
    this.bySession.clear()
  }
}

/** Join the mapping file name onto the media dir (no trailing-separator loss). */
function joinMappingPath(mediaDir: string): string {
  return mediaDir.endsWith('/') || mediaDir.endsWith('\\')
    ? mediaDir + MAPPING_FILE
    : mediaDir + '/' + MAPPING_FILE
}
