/**
 * The chat↔session registry (M2-D1-PR3): one live ChatAgent per QQ chat with
 * the chats/bySession dual index, session-id minting and retirement
 * (brokenSessions + the durable retired-sessions.json record), the
 * chat-sessions.json mapping persistence (save + debounced flush + restart
 * resume), the per-chat settings that survive /new, and the shared
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
}

/** D4b: the persisted per-chat settings carried in one chat-sessions.json
 * entry (additive format: a legacy file holds a bare session-id string). */
interface PersistedChatSettings {
  session: string
  interimOverride?: boolean
  goal?: string
}

/** D4b: build one mapping entry — a bare session id when the chat carries no
 * persisted settings (byte-identical to the legacy format), else an object
 * with the optional mode/goal fields. */
function persistEntry(sessionId: string, interimOverride: boolean | undefined, goal: string | undefined): string | PersistedChatSettings {
  if (interimOverride === undefined && goal === undefined) return sessionId
  const entry: PersistedChatSettings = { session: sessionId }
  if (interimOverride !== undefined) entry.interimOverride = interimOverride
  if (goal !== undefined) entry.goal = goal
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
  /** Session ids whose persisted logs are unusable; creates must avoid them. */
  private readonly brokenSessions = new Set<string>()
  /** Session ids retired across restarts (durable copy of brokenSessions). */
  retiredSessionIds = new Set<string>()
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
      try {
        const resumed = await this.resumeChat(chatId, evicted.session)
        // D4b: the evicted chat's persisted mode/goal come back with it.
        const settings = this.getSettings(chatId)
        if (evicted.interimOverride !== undefined) settings.interimOverride = evicted.interimOverride
        if (evicted.goal !== undefined) settings.goal = evicted.goal
        this.evictedChats.delete(chatId)
        return resumed
      } catch (error) {
        this.retireSession(evicted.session)
        this.evictedChats.delete(chatId)
        this.deps.log('warn', 'resume of evicted session failed for ' + chatId + '; falling back to a fresh session: ' + describeError(error))
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

  /** Resume persisted chats from the mapping file (best-effort). */
  async loadMapping(): Promise<void> {
    try {
      const content = await readFile(this.mappingPath(), 'utf8')
      // D4b: additive format — a legacy entry is a bare session-id string; a
      // new entry is { session, interimOverride?, goal? }.
      const mapping = JSON.parse(content) as Record<string, string | PersistedChatSettings>
      this.deps.log('debug', 'mapping file has ' + Object.keys(mapping).length + ' chat(s)')
      for (const [chatId, entry] of Object.entries(mapping)) {
        const sessionId = typeof entry === 'string' ? entry : entry?.session
        if (typeof sessionId !== 'string' || sessionId === '') continue
        // Restore the persisted mode/goal before the resume (old files carry
        // neither — the settings then fall back to their current defaults).
        if (typeof entry === 'object' && entry !== null) {
          const settings = this.getSettings(chatId)
          if (typeof entry.interimOverride === 'boolean') settings.interimOverride = entry.interimOverride
          if (typeof entry.goal === 'string' && entry.goal !== '') settings.goal = entry.goal
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

  async saveMapping(): Promise<void> {
    try {
      await mkdir(this.deps.config.mediaDir, { recursive: true })
      const mapping: Record<string, string | PersistedChatSettings> = {}
      for (const [chatId, evicted] of this.evictedChats) mapping[chatId] = persistEntry(evicted.session, evicted.interimOverride, evicted.goal)
      for (const chat of this.chats.values()) {
        const settings = this.chatSettings.get(chat.chatId)
        mapping[chat.chatId] = persistEntry(chat.sessionId, settings?.interimOverride, settings?.goal)
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
    // D4b: snapshot the persisted settings before the eviction clears them,
    // so saveMapping keeps writing the chat's mode/goal while it is idle.
    const evictedSettings = this.chatSettings.get(chatId)
    this.evictedChats.set(chatId, {
      session: chat.sessionId,
      interimOverride: evictedSettings?.interimOverride,
      goal: evictedSettings?.goal,
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
        for (const id of this.retiredSessionIds) this.brokenSessions.add(id)
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

  /**
   * Recover from a session-log collision: the live session cannot append to
   * the mismatched on-disk log, so dispose the agent and rebuild the chat on
   * a fresh session id. The user is asked to resend.
   */
  async healSessionCollision(chatId: ChatId): Promise<void> {
    const chat = this.chats.get(chatId)
    if (chat === undefined) return
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
      this.deps.onChatRemoved(chat)
      this.clearInterimTimers(chat)
      this.retireSession(chat.sessionId)
      // The bare derived id is forever unsafe for this chat once its history
      // has moved to a suffixed id: its on-disk log (if any) would collide
      // with any future bare-id session. Retire it up front so a /new after a
      // restart — when only the retired file protects us — stays safe.
      this.retireSession(sessionIdForChat(chatId))
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
