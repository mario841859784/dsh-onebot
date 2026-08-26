/**
 * The chat↔agent bridge: one Agent per QQ chat, inbound message pipeline
 * (policy → parse → media → STT → quote/forward expansion → followup),
 * outbound delivery driven by session events (assistant/message, turn/end),
 * typing indicator, per-chat send ordering, and chat→session mapping
 * persistence for restart resume. Ported from the Hermes OneBotAdapter
 * gateway-interaction half onto the dsh headless-runner agent pattern.
 * @module dsh-onebot/bridge
 */

import type { Agent, AgentRegistry, AgentSetup, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { OneBotConnection, OneBotEvent } from './connection.js'
import { OneBotActionError, OneBotNotConnectedError } from './connection.js'
import type { MediaStore } from './media.js'
import { fileToBase64 } from './media.js'
import type { Transcriber } from './stt.js'
import { transcriptLabel } from './stt.js'
import type { OneBotSegment, MediaRef } from './cq.js'
import { cqUnescape, detectMention, parseMessage, segmentText } from './cq.js'
import type { ChatId } from './chat.js'
import {
  buildChatId, buildGroupMessagePrefix, classifyUserRole, dmAllowed, groupAllowed,
  RESTRICTED_PREFIX, sessionIdForChat, splitChatId,
} from './chat.js'
import type { AccessPolicyConfig } from './chat.js'
import { extractForwardBlocks, scanSensitive, splitLongText, stripMarkdown } from './split.js'
import { renderTextImage } from './t2i/index.js'
import { buildPlatformPrompt } from './prompt.js'
import { registerTools } from './tools.js'

/** One OneBot message segment for outbound sends. */
export interface OutboundSegment {
  type: string
  data: Record<string, unknown>
}

/** Options for an explicit outbound send (from tools). */
export interface SendOptions {
  replyTo?: string
}

/** Resolved runtime configuration for the bridge. */
export interface BridgeConfig {
  botQQ: string
  ignoreSelf: boolean
  splitLength: number
  requireMention: boolean
  interimMessages: boolean
  /** Per-interim auto-recall delay (ms) from each interim's send completion
   * while the turn is still running (QQ recall window ~2 min); absent → 90s.
   * At turn/end the remaining originals are recalled immediately regardless. */
  interimRecallMs?: number
  sendErrorNotice: boolean
  restrictedMemberPrefix: boolean
  sensitivePatterns: readonly string[]
  mediaDir: string
  maxImageBytes: number
  maxVoiceBytes: number
  maxFileBytes: number
  textImageThreshold: number
  cardFooter: string
  fontFiles: readonly string[]
  fontFamilies: readonly string[]
  agentPreset: string
  workspacePath: string
  /** Max inbound file bytes fetched via QQ direct link / base64 (0 = no cap). */
  maxInboundFileBytes: number
}

/** Agent-preset service (dsh-agent-presets): joins agents to a preset composition. */
export interface AgentPresetsLike {
  /** The preset id a new session gets when none is named (deployment default). */
  readonly defaultId: string
  /** Resolve one preset by id (undefined = default); throws when no root supplies it. */
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: unknown, id?: string): Promise<{ id: string }>
}

/** Durable session persistence (dsh-session-persistence): cold-read what a session recorded. */
export interface SessionPersistenceLike {
  inspect(id: SessionId, signal?: AbortSignal): Promise<{
    meta: { agentPreset?: string }
    events: readonly { type?: string; data?: { agentPreset?: string } }[]
  }>
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

/** Workspace registry (dsh-workspace): durable workspace membership. */
export interface WorkspaceLike {
  id: string
  path: string
  sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<void>
}

/** Workspace registry (dsh-workspace): durable workspace membership. */
export interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  create(path: string, title?: string): Promise<WorkspaceLike>
  list(): WorkspaceLike[]
}

/** Default model service (dsh-agent-default-model): read/save the default selection. */
export interface AgentDefaultModelLike {
  currentSelection(): ModelSelection | undefined
  saveSelection(next: ModelSelection): Promise<void>
}

/** Services the bridge needs (subset of the plugin Context). */
export interface BridgeDeps {
  ctx: Context
  connection: OneBotConnection
  /** The dsh data home (default <home>/.dsh); used to enumerate agent presets. */
  dshHome?: string | undefined
  media: MediaStore
  transcriber: Transcriber
  agents: AgentRegistry
  sessions: SessionStore
  agentPresets: AgentPresetsLike
  /** Host command runtime: forwards /plan so QQ reaches the native plan command.
   * `signal` is REQUIRED by the host implementation (it reads `signal.aborted`
   * unconditionally) — pass a fresh never-aborted one. */
  commands?: { execute(agent: unknown, line: string, signal: AbortSignal): Promise<{ kind?: string; text?: string; result?: { kind?: string; text?: string } }> } | undefined
  /** Durable persistence for cold-reading a session's recorded preset; absent = config/default fallback. */
  sessionPersistence: SessionPersistenceLike | undefined
  workspaceRegistry: WorkspaceRegistryLike
  agentDefaultModel: AgentDefaultModelLike | undefined
  defaultModel: (() => ModelSelection | undefined) | undefined
  config: BridgeConfig
  policy: AccessPolicyConfig
  /** Log line callback (level, message). */
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
}

/** One live per-chat agent. */
interface ChatAgent {
  chatId: ChatId
  sessionId: SessionId
  agent: Agent
  dispose(): Promise<void>
  /** Per-chat send chain (preserves outbound order). */
  queue: Promise<unknown>
  /** Buffered last-step text when interimMessages is off. */
  pendingFinal: string
  /** Loop merge (interimMessages on): text deferred one step, awaiting the
   * next assistant/message to prove it interim — the last one is the final. */
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
  typingTimer: ReturnType<typeof setInterval> | undefined
  lastNickname: string
  /** The most recent inbound QQ user id for this chat (edit-tool gating). */
  lastUserId: string
  /** The last user message text actually fed to the agent (for /retry). */
  lastFollowup: string | undefined
  /** Mutable per-agent model selection (installModelSelection-bound); the
   * /model command swaps `.current` for the next step. */
  selectionRef: ModelSelectionRef | undefined
}

/** The mapping file name inside the media dir. */
const MAPPING_FILE = 'chat-sessions.json'
/** The retired-session-id file name inside the media dir (append-only). */
const RETIRED_FILE = 'retired-sessions.json'
/** Spacing between recall delete_msg calls (NapCat recallMsg is slow; bursting
 * them pushes borderline-late recalls over the server timeout). */
const RECALL_SPACING_MS = 60

/**
 * Bridge between OneBot events and dsh agents. Create via the constructor and
 * call start() from the plugin's effect; call stop() on disposal.
 */
export class ChatBridge {
  private readonly deps: BridgeDeps
  private readonly chats = new Map<ChatId, ChatAgent>()
  private readonly bySession = new Map<string, ChatId>()
  /** Session-feed listener disposers (freed on stop, so plugin reload/HMR cannot accumulate duplicates). */
  private sessionEventOff: (() => void) | undefined
  private sessionFlushOff: (() => void) | undefined
  /** Per-chat workspace override set by /workspace (survives /new resets,
   * so the next agent for the chat is created under the new directory). */
  private readonly chatWorkspacePaths = new Map<ChatId, string>()
  /** Per-chat agent-preset override set by /preset (survives /new resets). */
  private readonly chatPresetOverrides = new Map<ChatId, string>()
  /** Per-chat outbound-mode override set by /mode (true=interim, false=instant);
   * undefined defers to the global config. */
  private readonly chatInterimOverrides = new Map<ChatId, boolean>()
  /** Per-chat goal set by /goal (reminds the model of the objective each turn). */
  private readonly chatGoals = new Map<ChatId, string>()
  /** Per-chat most recent inbound image path (for /ocr), survives /new resets. */
  private readonly chatLastImagePaths = new Map<ChatId, string>()
  /** Plugin version + git commit, read once for /ver. */
  private pluginVersion: string | undefined
  private pluginCommit: string | undefined
  private stopping = false
  private mappingSaveTimer: ReturnType<typeof setTimeout> | undefined
  /** Resolves once the on-disk chat mapping has been loaded. */
  private mappingLoaded: Promise<void> = Promise.resolve()
  /** Session ids whose persisted logs are unusable; creates must avoid them. */
  private readonly brokenSessions = new Set<string>()
  /** Session ids retired across restarts (durable copy of brokenSessions). */
  private retiredSessionIds: string[] = []

  constructor(deps: BridgeDeps) {
    this.deps = deps
  }

  /** Start listening: wire connection handlers and the session event feed. */
  start(): void {
    const { connection, ctx } = this.deps
    connection.selfId = this.deps.config.botQQ
    this.sessionEventOff = ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.onSessionEvent(session, event)
    })
    this.sessionFlushOff = ctx.on('session/flush', (session: Session) => {
      void this.onSessionFlush(session)
    })
    connection.onStatus = (connected: boolean) => {
      this.deps.log(connected ? 'info' : 'warn', 'OneBot ' + (connected ? 'connected' : 'disconnected'))
    }
    this.mappingLoaded = this.ready().then(async () => {
      await this.loadRetired()
      await this.loadMapping()
    }).then(() => {
      if (this.stopping) return
      this.deps.log('info', 'bridge ready (' + this.chats.size + ' resumed chat(s))')
    })
  }

  /** Stop everything: dispose agents, save mapping, cancel timers. */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.sessionEventOff !== undefined) {
      this.sessionEventOff()
      this.sessionEventOff = undefined
    }
    if (this.sessionFlushOff !== undefined) {
      this.sessionFlushOff()
      this.sessionFlushOff = undefined
    }
    if (this.mappingSaveTimer !== undefined) {
      clearTimeout(this.mappingSaveTimer)
      this.mappingSaveTimer = undefined
    }
    await this.saveMapping()
    for (const chat of this.chats.values()) {
      this.stopTyping(chat)
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

  /** Map an agent session id back to its chat (for model tools). */
  chatForSession(sessionId: string): ChatId | undefined {
    return this.bySession.get(sessionId)
  }

  /** Whether a caller backing an agent session may perform file edits. QQ chats
   * require the most recent inbound user to be an admin; non-QQ sessions (Web
   * and other channels) are trusted by default (A1 scoping). */
  canEditFiles(sessionId: string): boolean {
    const chatId = this.bySession.get(sessionId)
    if (chatId === undefined) return true
    const chat = this.chats.get(chatId)
    const lastUserId = chat?.lastUserId ?? ''
    if (lastUserId === '') return false
    return classifyUserRole(lastUserId, this.deps.policy.adminUsers) === 'admin'
  }

  /** Whether the connection is usable for sends. */
  get connected(): boolean {
    return this.deps.connection.connected
  }

  /**
   * Send plain text to a chat with the full outbound pipeline (forward
   * blocks, Markdown strip, sentence splitting).
   * @param chatId - target chat.
   * @param text - model-produced text.
   * @param options - optional reply target.
   * @returns the sent message ids.
   */
  sendToChat(chatId: ChatId, text: string, options: SendOptions = {}): Promise<string[]> {
    return this.enqueue(chatId, async () => {
      if (!this.deps.connection.connected) {
        throw new OneBotNotConnectedError()
      }
      const hits = scanSensitive(text, this.deps.config.sensitivePatterns)
      if (hits.length > 0) {
        this.deps.log('warn', 'sensitive outbound audit for ' + chatId + ': ' + hits.join(', '))
      }
      const ids: string[] = []
      const { body, nodes } = extractForwardBlocks(text, '助手')
      if (nodes.length > 0) {
        await this.sendForward(chatId, nodes)
        ids.push('forward')
      }
      let sentCard = false
      const threshold = this.deps.config.textImageThreshold
      if (threshold > 0 && body.length > threshold) {
        try {
          const chat = this.chats.get(chatId)
          const title = chat !== undefined && chat.lastNickname !== ''
            ? 'To ' + chat.lastNickname
            : undefined
          const png = renderTextImage(body, {
            title,
            footerBrand: this.deps.config.cardFooter,
            fontFiles: this.deps.config.fontFiles,
            fontFamilies: this.deps.config.fontFamilies,
          })
          const b64 = 'base64://' + png.toString('base64')
          if (b64.length <= this.deps.config.maxImageBytes) {
            const id = await this.sendMsg(chatId, [{ type: 'image', data: { file: b64 } }], options)
            if (id !== undefined) ids.push(id)
            sentCard = true
          } else {
            this.deps.log('warn', 't2i card PNG exceeds maxImageBytes; falling back to text')
          }
        } catch (error) {
          this.deps.log('warn', 't2i render failed, falling back to text: ' + (error instanceof Error ? error.message : String(error)))
        }
      }
      if (!sentCard) {
        const plain = stripMarkdown(body)
        if (plain !== '') {
          const chunks = splitLongText(plain, this.deps.config.splitLength)
          for (const chunk of chunks) {
            const id = await this.sendMsg(chatId, [{ type: 'text', data: { text: chunk } }], options)
            if (id !== undefined) ids.push(id)
          }
        }
      }
      return ids
    })
  }

  /**
   * Send raw OneBot segments (used by the media tools).
   * @param chatId - target chat.
   * @param segments - outbound segments.
   * @returns the sent message id.
   */
  sendSegments(chatId: ChatId, segments: OutboundSegment[]): Promise<string | undefined> {
    return this.enqueue(chatId, () => this.sendMsg(chatId, segments, {}))
  }

  /**
   * Wait for the loader's complete application (model selection, settings,
   * persistence) before reading the default model — the same gate the
   * headless runner uses, so the pinned selection is never a half-loaded
   * default.
   */
  private async ready(): Promise<void> {
    try {
      const loader = this.deps.ctx.get('loader') as { await(): Promise<void> } | undefined
      await loader?.await()
    } catch (error) {
      this.deps.log('debug', 'loader.await failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  // ------------------------------------------------------------ inbound

  /**
   * Inbound OneBot message event → agent turn. All policy and media work is
   * contained: a failure here logs and drops the message, never the host.
   */
  async handleInbound(event: OneBotEvent): Promise<void> {
    if (this.stopping) return
    try {
      await this.processInbound(event)
    } catch (error) {
      this.deps.log('error', 'inbound handling failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  private async processInbound(event: OneBotEvent): Promise<void> {
    const messageType = event.message_type
    if (messageType !== 'private' && messageType !== 'group') return
    const userId = String(event.user_id ?? '')
    if (userId === '') return
    if (this.deps.config.ignoreSelf && this.deps.connection.selfId !== '' && userId === this.deps.connection.selfId) {
      return
    }
    const groupId = messageType === 'group' ? String(event.group_id ?? '') : ''
    const policy = this.deps.policy
    if (messageType === 'private') {
      if (!dmAllowed(userId, policy)) {
        this.deps.log('debug', 'ignoring DM from non-allowed user ' + userId)
        return
      }
    } else {
      if (!groupAllowed(groupId, policy)) {
        this.deps.log('debug', 'ignoring group message from non-allowed group ' + groupId)
        return
      }
    }

    const segments = Array.isArray(event.message) ? event.message as OneBotSegment[] : undefined
    const raw = typeof event.raw_message === 'string' ? event.raw_message : String(event.message ?? '')
    const parsed = parseMessage(segments, raw)
    const mentioned = detectMention(segments, raw, this.deps.connection.selfId, this.deps.config.botQQ, parsed.replyId)
    if (messageType === 'group' && this.deps.config.requireMention && !mentioned) {
      this.deps.log('debug', 'ignoring unmentioned group message in ' + groupId)
      return
    }

    const sender = event.sender ?? {}
    const nickname = typeof sender.card === 'string' && sender.card !== ''
      ? sender.card
      : typeof sender.nickname === 'string' && sender.nickname !== ''
        ? sender.nickname
        : userId
    const chatId = buildChatId(messageType === 'private' ? 'private' : 'group', messageType === 'private' ? userId : groupId)

    // A new user message starts a fresh reply cycle: drop any unmerged loop
    // residue from the previous cycle so interims never merge across turns.
    const priorChat = this.chats.get(chatId)
    if (priorChat !== undefined) {
      priorChat.loopBuffer = []
      priorChat.loopPending = null
    }

    // Fire-and-forget temp cleanup on each inbound.
    void this.deps.media.cleanupExpired()

    const body = await this.buildBody(parsed.text, parsed.media, chatId, userId, messageType)

    let quote = ''
    if (parsed.replyId !== undefined) {
      quote = await this.expandQuote(parsed.replyId)
    }
    let forward = ''
    if (parsed.forwardId !== undefined) {
      forward = await this.expandForward(parsed.forwardId)
    }

    const isAdmin = classifyUserRole(userId, policy.adminUsers) === 'admin'

    // Slash commands (admin only): /new, /stop, /model, /workspace, /help.
    // Unknown /-words fall through to the model (Hermes-style).
    if (await this.tryHandleCommand(chatId, parsed.text, userId)) {
      return
    }

    let final = body
    if (quote !== '') final = quote + '\n' + final
    if (forward !== '') final = forward + '\n' + final
    if (messageType === 'group') {
      final = buildGroupMessagePrefix(nickname, userId, mentioned) + final
      if (!isAdmin && this.deps.config.restrictedMemberPrefix) {
        final = RESTRICTED_PREFIX + final
      }
    }
    final = final.trim()
    if (final === '') return

    await this.dispatchFollowup(chatId, final, nickname)
    const chat = this.chats.get(chatId)
    if (chat !== undefined) chat.lastUserId = userId
  }

  /** Feed one user message into a chat's agent (create on demand). Records
   * the base text for /retry and applies per-chat /goal + /plan prefixes. */
  private async dispatchFollowup(chatId: ChatId, text: string, nickname?: string): Promise<void> {
    const final = this.prefixTurn(chatId, text)
    const fallback = this.chats.get(chatId)?.lastNickname ?? ''
    const chat = await this.ensureChat(chatId, nickname ?? fallback)
    if (nickname !== undefined && nickname !== '') chat.lastNickname = nickname
    chat.lastFollowup = text
    this.deps.log('info', 'followup from ' + chatId + ': ' + final.slice(0, 120))
    // Plugin-originated user message: the session log attributes QQ inbound
    // messages to this plugin (the built-in plugin source with form omitted),
    // keeping them distinguishable from host/web UI inputs.
    chat.agent.followup(createUserMessage({
      content: [{ type: 'text', text: final }],
      source: { kind: 'plugin', plugin: 'dsh-onebot' },
    }))
    this.startTyping(chat)
  }

  /** Prepend per-chat context directives (/goal reminder) to a turn's user
   * text. Plan mode is host-owned now (/plan forwards to the host command),
   * so the agent's own plan-mode instruction section governs planning. */
  private prefixTurn(chatId: ChatId, text: string): string {
    let out = text
    const goal = this.chatGoals.get(chatId)
    if (goal !== undefined && goal.trim() !== '') {
      out = '【当前目标】' + goal + '\n' + out
    }
    return out.trim()
  }

  /** Per-chat outbound-mode override (/mode), falling back to the global config. */
  private effectiveInterim(chatId: ChatId): boolean {
    return this.chatInterimOverrides.get(chatId) ?? this.deps.config.interimMessages
  }

  /** Tool calls whose host-plane UI has no QQ equivalent; relay them to the chat. */
  private relayHostCards(chatId: ChatId, content: readonly unknown[]): void {
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const call = block as { type?: string; name?: string; arguments?: string }
      if (call.type !== 'tool-call') continue
      if (call.name === 'exit_plan_mode') {
        const text = this.renderPlanCard(call.arguments)
        if (text !== undefined) {
          this.sendToChat(chatId, text).catch((error: unknown) => {
            this.deps.log('warn', 'plan card relay failed: ' + String(error))
          })
        }
      } else if (call.name === 'ask_user_question') {
        const text = this.renderQuestionCard(call.arguments)
        if (text !== undefined) {
          this.sendToChat(chatId, text).catch((error: unknown) => {
            this.deps.log('warn', 'question card relay failed: ' + String(error))
          })
        }
      }
    }
  }

  /** Render an exit_plan_mode tool-call's plan for QQ, or undefined when unusable. */
  private renderPlanCard(rawArguments: string | undefined): string | undefined {
    if (typeof rawArguments !== 'string' || rawArguments === '') return undefined
    try {
      const parsed = JSON.parse(rawArguments) as { plan?: unknown }
      if (typeof parsed.plan !== 'string' || parsed.plan.trim() === '') return undefined
      return '【📋 计划书】请确认以下计划——可在 Web 卡片确认，或直接回复「确认/继续」供参考：\n' + parsed.plan.trim()
    } catch {
      this.deps.log('debug', 'plan card parse failed')
      return undefined
    }
  }

  /** Render an ask_user_question tool-call's questions for QQ, or undefined when unusable. */
  private renderQuestionCard(rawArguments: string | undefined): string | undefined {
    if (typeof rawArguments !== 'string' || rawArguments === '') return undefined
    try {
      const parsed = JSON.parse(rawArguments) as { questions?: unknown }
      if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return undefined
      const lines: string[] = ['【❓ 提问】请回答以下问题（可回复选项/文字）：']
      parsed.questions.forEach((q, index) => {
        const question = q as { header?: unknown; question?: unknown; options?: unknown; multi_select?: boolean }
        const header = typeof question.header === 'string' && question.header !== '' ? question.header : ''
        const body = typeof question.question === 'string' ? question.question : ''
        lines.push((index + 1) + '. ' + (header !== '' ? '[' + header + '] ' : '') + body)
        if (Array.isArray(question.options)) {
          question.options.forEach((opt, i) => {
            const label = (opt as { label?: unknown })?.label
            const labelText = typeof label === 'string' ? label : ''
            lines.push('   ' + 'abcd'.charAt(i) + ') ' + labelText)
          })
        }
        if (question.multi_select === true) lines.push('   （可多选）')
      })
      return lines.join('\n')
    } catch {
      this.deps.log('debug', 'question card parse failed')
      return undefined
    }
  }

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
  private async tryHandleCommand(chatId: ChatId, text: string, userId: string): Promise<boolean> {
    const normalized = text.replace(/^@\d+\s*/, '')
    const first = (normalized.split(/\s+/, 1)[0] ?? '').trim()
    if (!/^\/[A-Za-z][A-Za-z0-9_-]*$/.test(first)) return false

    const isAdmin = classifyUserRole(userId, this.deps.policy.adminUsers) === 'admin'
    if (!isAdmin) {
      await this.sendToChat(chatId, '该命令仅管理员可用。')
      return true
    }

    const name = first.slice(1).toLowerCase()
    this.deps.log('debug', 'slash /' + name + ' for ' + chatId)
    if (name === 'new') {
      this.deps.log('info', 'slash /new for ' + chatId)
      await this.resetChat(chatId)
      return true
    }
    if (name === 'stop') {
      const chat = this.chats.get(chatId)
      if (chat !== undefined && chat.agent.status === 'running') {
        chat.agent.cancel({ kind: 'user' })
        // Drop the deferred loop state so the cancelled turn settles silently
        // instead of flushing its partial text as a final.
        chat.loopPending = null
        chat.loopBuffer = []
        await this.sendToChat(chatId, '⏹ 已停止生成。')
      } else {
        await this.sendToChat(chatId, '当前没有正在进行的生成。')
      }
      return true
    }
    if (name === 'model') {
      await this.handleModelCommand(chatId, normalized.slice(first.length).trim())
      return true
    }
    if (name === 'workspace') {
      await this.handleWorkspaceCommand(chatId, normalized.slice(first.length).trim())
      return true
    }
    if (name === 'id') {
      await this.handleIdCommand(chatId)
      return true
    }
    if (name === 'ver') {
      await this.handleVerCommand(chatId)
      return true
    }
    if (name === 'status') {
      await this.handleStatusCommand(chatId)
      return true
    }
    if (name === 'mode') {
      await this.handleModeCommand(chatId, normalized.slice(first.length).trim())
      return true
    }
    if (name === 'retry') {
      await this.handleRetryCommand(chatId)
      return true
    }
    if (name === 'ocr') {
      await this.handleOcrCommand(chatId)
      return true
    }
    if (name === 'preset') {
      await this.handlePresetCommand(chatId, normalized.slice(first.length).trim())
      return true
    }
    if (name === 'plan') {
      await this.handlePlanCommand(chatId, normalized.slice(first.length).trim())
      return true
    }
    if (name === 'goal') {
      await this.handleGoalCommand(chatId, normalized.slice(first.length).trim())
      return true
    }
    if (name === 'help') {
      await this.sendToChat(chatId, '可用命令：\n/new 开启新会话（清空上下文）\n/stop 停止当前生成\n/model [provider/model] 查看或切换模型\n/workspace [路径|list] 查看或切换工作区\n/preset [id] 查看或切换 agent 预设\n/status 会话全景状态\n/retry 重跑上一条\n/id 查看 session/chat id\n/ver 插件版本\n/ocr 识别最近一张图片\n/mode [interim|instant] 切换出站模式\n/plan [off|内容] 宿主计划模式（/plan off 退出）\n/goal [目标|clear] 查看/设置目标\n/help 本帮助\n\n其他 / 开头的文本会直接交给模型。')
      return true
    }
    return false
  }

  /** /model: show the current model (+ discoverable providers), or switch. */
  private async handleModelCommand(chatId: ChatId, arg: string): Promise<void> {
    const chat = this.chats.get(chatId)
    const current = chat?.selectionRef?.current
      ?? this.safeDefaultModel()
    if (arg === '') {
      const cur = current !== undefined ? current.provider + '/' + current.model : '（未设置）'
      let out = '当前模型：' + cur
      try {
        const providers = this.deps.ctx.llm.listProviders()
        for (const p of providers.slice(0, 6)) {
          try {
            const models = await this.deps.ctx.llm.listModels(p.id)
            out += '\n' + p.id + ': ' + models.slice(0, 10).map(m => m.id).join(', ')
          } catch (error) {
            out += '\n' + p.id + ': （列表不可用）'
            this.deps.log('warn', 'listModels failed for ' + p.id + ': ' + String(error))
          }
        }
      } catch (error) {
        out += '\n（模型列表不可用）'
        this.deps.log('warn', 'listProviders failed: ' + String(error))
      }
      await this.sendToChat(chatId, out)
      return
    }
    const m = /^(\S+)[\s/]+(\S+)$/.exec(arg)
    if (m === null) {
      await this.sendToChat(chatId, '用法：/model <provider> <model> 或 /model <provider>/<model>')
      return
    }
    const provider = m[1]
    const model = m[2]
    try {
      const models = await this.deps.ctx.llm.listModels(provider)
      if (models.length > 0 && !models.some(x => x.id === model)) {
        await this.sendToChat(chatId, `❌ ${provider} 下没有模型 ${model}。可用：` + models.slice(0, 10).map(x => x.id).join(', '))
        return
      }
    } catch (error) {
      this.deps.log('debug', 'model switch precheck failed for ' + provider + ': ' + String(error))
    }
    const next = { provider, model }
    if (chat?.selectionRef !== undefined) {
      chat.selectionRef.current = next
    }
    if (this.deps.agentDefaultModel !== undefined) {
      try {
        await this.deps.agentDefaultModel.saveSelection(next)
      } catch (error) {
        this.deps.log('warn', 'saveSelection failed: ' + String(error))
      }
    }
    await this.sendToChat(chatId, `✅ 已切换模型：${provider}/${model}（下一步生效）`)
  }

  /** /workspace: show current cwd, list workspaces, or switch directory. */
  private async handleWorkspaceCommand(chatId: ChatId, arg: string): Promise<void> {
    if (arg === '') {
      const cwd = this.effectiveCwd(chatId)
      let suffix = ''
      try {
        const ws = await this.deps.workspaceRegistry.resolveByPath(cwd)
        suffix = ws !== undefined ? `（工作区 ${ws.id}，${ws.sessionIds.length} 个会话）` : '（无 workspace 记录）'
      } catch (error) {
        this.deps.log('debug', 'resolveByPath failed: ' + String(error))
      }
      await this.sendToChat(chatId, `当前工作目录：${cwd} ${suffix}\n用法：/workspace <目录路径> 切换；/workspace list 列出全部`)
      return
    }
    if (arg === 'list') {
      try {
        const list = this.deps.workspaceRegistry.list()
        if (list.length === 0) {
          await this.sendToChat(chatId, '（没有任何 workspace 记录）')
          return
        }
        await this.sendToChat(chatId, list.map(w => `${w.id}  ${w.path}（${w.sessionIds.length} 会话）`).join('\n'))
      } catch (error) {
        this.deps.log('debug', 'workspace list failed: ' + String(error))
        await this.sendToChat(chatId, '❌ 无法列出工作区。')
      }
      return
    }
    try {
      const path = await realpath(arg)
      const s = await stat(path)
      if (!s.isDirectory()) {
        await this.sendToChat(chatId, `❌ 不是目录：${arg}`)
        return
      }
      const hadChat = this.chats.has(chatId)
      this.chatWorkspacePaths.set(chatId, path)
      if (hadChat) {
        // Retire the current agent: its session cwd is frozen at creation, so
        // the next message re-creates the session under the new directory.
        await this.resetChat(chatId)
      }
      await this.sendToChat(chatId, `✅ 工作区已切换：${path}\n下一条消息将使用新工作区（新会话）。`)
      this.deps.log('info', 'workspace switch for ' + chatId + ' -> ' + path)
    } catch (error) {
      this.deps.log('debug', 'workspace switch failed: ' + String(error))
      await this.sendToChat(chatId, `❌ 目录无效或不可访问：${arg}`)
    }
  }

  /** /id: show the chat/session identity (admin debug aid). */
  private async handleIdCommand(chatId: ChatId): Promise<void> {
    const sessionId = this.chats.get(chatId)?.sessionId ?? await this.sessionIdFromMapping(chatId)
    await this.sendToChat(chatId,
      'chat    : ' + chatId + '\n' +
      'session : ' + (sessionId ?? '（未建立会话，下一条消息创建）') + '\n' +
      'cwd     : ' + this.effectiveCwd(chatId))
  }

  /** /ver: plugin version + git commit (each read once and cached). */
  private async handleVerCommand(chatId: ChatId): Promise<void> {
    const commit = this.gitCommit()
    await this.sendToChat(chatId, 'dsh-onebot v' + (this.packageVersion() ?? '?') + (commit !== undefined ? ' (' + commit + ')' : ''))
  }

  /** /status: one-shot snapshot of the chat session state. */
  private async handleStatusCommand(chatId: ChatId): Promise<void> {
    const chat = this.chats.get(chatId)
    const sessionId = chat?.sessionId ?? await this.sessionIdFromMapping(chatId)
    const override = this.chatPresetOverrides.get(chatId)
    let preset: string
    if (override !== undefined) {
      preset = override + '（/preset 覆盖）'
    } else {
      const resolved = await this.resolvePresetId(chatId)
      preset = (resolved ?? undefined) !== undefined ? (resolved ?? '') + '（默认/配置）' : '（未记录）'
    }
    const current = chat?.selectionRef?.current ?? this.safeDefaultModel()
    const model = current !== undefined ? current.provider + '/' + current.model : '（未设置）'
    const cwd = this.effectiveCwd(chatId)
    let wsSuffix = ''
    try {
      const ws = await this.deps.workspaceRegistry?.resolveByPath(cwd)
      wsSuffix = ws !== undefined ? `（工作区 ${ws.id}，${ws.sessionIds.length} 个会话）` : '（无 workspace 记录）'
    } catch (error) {
      this.deps.log('debug', 'resolveByPath failed: ' + String(error))
    }
    const interim = this.chatInterimOverrides.get(chatId)
    const modeLabel = interim !== undefined
      ? (interim ? 'interim（合并卡片）' : 'instant（逐条即时）') + '（/mode 覆盖）'
      : (this.deps.config.interimMessages ? 'interim（合并卡片）' : 'instant（逐条即时）') + '（全局配置）'
    const agentState = chat !== undefined
      ? 'busy=' + chat.busy + ' loopBuffer=' + chat.loopBuffer.length
      : '（未建立会话）'
    await this.sendToChat(chatId,
      'chat    : ' + chatId + '\n' +
      'session : ' + (sessionId ?? '（未建立会话）') + '\n' +
      'preset  : ' + preset + '\n' +
      'model   : ' + model + '\n' +
      'cwd     : ' + cwd + ' ' + wsSuffix + '\n' +
      '出站     : ' + modeLabel + '\n' +
      'agent   : ' + agentState)
  }

  /** /mode: per-chat outbound-mode override (interim vs instant). */
  private async handleModeCommand(chatId: ChatId, arg: string): Promise<void> {
    const v = arg.trim().toLowerCase()
    if (v === '' || v === 'status' || v === 'view') {
      const interim = this.chatInterimOverrides.get(chatId)
      const eff = interim ?? this.deps.config.interimMessages
      const suffix = interim !== undefined ? '（/mode 覆盖）' : '（全局配置）'
      await this.sendToChat(chatId, `当前出站模式：${eff ? 'interim（合并卡片）' : 'instant（逐条即时）'}${suffix}\n用法：/mode interim|instant 切换；/mode 查看`)
      return
    }
    if (v === 'interim' || v === 'on' || v === 'merge') {
      this.chatInterimOverrides.set(chatId, true)
      await this.sendToChat(chatId, '✅ 出站模式已切换为 interim（合并卡片）。下一条回复生效。')
      return
    }
    if (v === 'instant' || v === 'off' || v === 'direct') {
      this.chatInterimOverrides.set(chatId, false)
      await this.sendToChat(chatId, '✅ 出站模式已切换为 instant（逐条即时）。下一条回复生效。')
      return
    }
    await this.sendToChat(chatId, '用法：/mode interim|instant 切换；/mode 查看当前')
  }

  /** /retry: re-feed the last user message into the agent. */
  private async handleRetryCommand(chatId: ChatId): Promise<void> {
    const chat = this.chats.get(chatId)
    if (chat === undefined) {
      await this.sendToChat(chatId, '没有可重试的上一条消息。')
      return
    }
    if (chat.busy) {
      await this.sendToChat(chatId, '当前正在生成，请稍后再重试。')
      return
    }
    const text = chat.lastFollowup
    if (text === undefined || text === '') {
      await this.sendToChat(chatId, '没有可重试的上一条消息。')
      return
    }
    // Start a fresh reply cycle exactly like a new inbound turn.
    chat.loopBuffer = []
    chat.loopPending = null
    this.deps.log('info', 'retry for ' + chatId)
    await this.dispatchFollowup(chatId, text, chat.lastNickname)
  }

  /** /ocr: OCR the most recent inbound image via NapCat's ocr_image. */
  private async handleOcrCommand(chatId: ChatId): Promise<void> {
    const path = this.chatLastImagePaths.get(chatId)
    if (path === undefined || path === '') {
      await this.sendToChat(chatId, '请先在对话里发一张图片，再 /ocr。')
      return
    }
    let b64: string
    try {
      b64 = await fileToBase64(path, this.deps.config.maxImageBytes)
    } catch (error) {
      this.deps.log('warn', 'ocr image read failed: ' + String(error))
      await this.sendToChat(chatId, `❌ 读取图片失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    let lines: string
    try {
      const data = await this.deps.connection.call('ocr_image', { image: 'base64://' + b64 }) as { texts?: Array<{ text?: string }> }
      const texts = Array.isArray(data.texts) ? data.texts.map(t => t.text ?? '').filter(t => t !== '') : []
      lines = texts.join('\n')
    } catch (error) {
      this.deps.log('warn', 'ocr_image failed: ' + String(error))
      await this.sendToChat(chatId, `❌ OCR 失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (lines.trim() === '') {
      await this.sendToChat(chatId, 'OCR 未识别到文本。')
      return
    }
    await this.sendToChat(chatId, 'OCR 结果：\n' + lines)
  }

  /** /preset: show available agent presets and the current one, or switch. */
  private async handlePresetCommand(chatId: ChatId, arg: string): Promise<void> {
    const listed = await this.listPresets()
    if (arg.trim() === '') {
      const current = this.chatPresetOverrides.get(chatId)
        ?? await this.resolvePresetId(chatId)
        ?? this.deps.agentPresets?.defaultId
      let out = '当前预设：' + (current ?? '（未记录）') + (this.chatPresetOverrides.has(chatId) ? '（/preset 覆盖）' : '')
      if (listed.length > 0) out += '\n可用预设：\n' + listed.join('\n')
      out += '\n用法：/preset <id> 切换（重建会话）；/preset 查看'
      await this.sendToChat(chatId, out)
      return
    }
    const id = arg.trim()
    if (this.deps.agentPresets === undefined) {
      await this.sendToChat(chatId, '❌ 当前宿主未提供 agentPresets 服务。')
      return
    }
    let resolvedId: string
    try {
      const preset = await this.deps.agentPresets.resolve(id)
      resolvedId = preset.id
    } catch (error) {
      this.deps.log('debug', 'preset resolve failed: ' + String(error))
      await this.sendToChat(chatId, '❌ 预设不存在：' + id + (listed.length > 0 ? '\n可用：' + listed.join(', ') : ''))
      return
    }
    this.chatPresetOverrides.set(chatId, resolvedId)
    if (this.chats.has(chatId)) {
      await this.resetChat(chatId)
    }
    this.deps.log('info', 'preset switch for ' + chatId + ' -> ' + resolvedId)
    await this.sendToChat(chatId, `✅ 预设已切换：${resolvedId}\n下一条消息将重建会话并按新预设运行。`)
  }

  /** /plan: per-chat plan mode — turns are prefixed with a plan-only directive. */
  /** /plan: forward to the HOST plan command so QQ enters/leaves host plan
   * mode (the host `/plan off` path exits directly, no Web review card). The
   * plugin no longer runs its own prefix plan mode — that duplicated the host
   * semantic and shadowed the host `/plan off` exit. */
  private async handlePlanCommand(chatId: ChatId, arg: string): Promise<void> {
    const chat = this.chats.get(chatId)
    if (chat === undefined) {
      await this.sendToChat(chatId, '请先发一条消息建立会话，再 /plan。')
      return
    }
    const commands = this.deps.commands
    if (commands === undefined) {
      await this.sendToChat(chatId, '❌ 宿主未提供 commands 服务，无法切换计划模式。')
      return
    }
    const line = arg.trim() === '' ? '/plan' : '/plan ' + arg.trim()
    try {
      // The host command runtime requires a signal (it reads `signal.aborted`
      // unconditionally) — pass a fresh never-aborted one; QQ user-initiated
      // /plan must not be interruptible by our own cancellation.
      const result = await commands.execute(chat.agent as never, line, new AbortController().signal)
      const text = result?.text !== undefined && result.text !== '' ? result.text : (arg.trim().toLowerCase() === 'off' ? '已退出计划模式。' : '已进入计划模式。')
      const hint = arg.trim().toLowerCase() === 'off' ? '' : '\n（QQ 退出计划模式：发 /plan off）'
      await this.sendToChat(chatId, text + hint)
      this.deps.log('info', 'host plan command for ' + chatId + ': ' + line)
    } catch (error) {
      this.deps.log('warn', 'host plan command failed: ' + String(error))
      await this.sendToChat(chatId, '❌ 计划模式切换失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /** /goal: per-chat objective — recorded and reminded on each turn. */
  private async handleGoalCommand(chatId: ChatId, arg: string): Promise<void> {
    const v = arg.trim()
    if (v === '') {
      const goal = this.chatGoals.get(chatId)
      await this.sendToChat(chatId, '当前目标：' + (goal !== undefined && goal !== '' ? '\n' + goal : '（未设置）') + '\n用法：/goal <目标> 设置/更新；/goal clear 清除')
      return
    }
    if (v.toLowerCase() === 'clear' || v === '删除' || v === '移除') {
      this.chatGoals.delete(chatId)
      await this.sendToChat(chatId, '✅ 目标已清除。')
      return
    }
    this.chatGoals.set(chatId, v)
    await this.sendToChat(chatId, '✅ 目标已记录（每轮自动附带提醒）：\n' + v)
  }

  /** Enumerate the on-disk agent presets (<dsh-home>/.agent-presets/*). */
  private async listPresets(): Promise<string[]> {
    const home = this.deps.dshHome
    if (home === undefined || home === '') return []
    const root = join(home, '.agent-presets')
    try {
      const entries = await readdir(root, { withFileTypes: true })
      const out: string[] = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        let label = entry.name
        try {
          const text = await readFile(join(root, entry.name, 'preset.yml'), 'utf8')
          const m = /^name\s*:\s*(.+?)\s*$/m.exec(text)
          if (m !== null && m[1].trim() !== '') label = m[1].trim()
        } catch {
          // no preset.yml — fall back to the directory id
        }
        out.push(entry.name + (label !== entry.name ? '（' + label + '）' : ''))
      }
      return out.sort()
    } catch (error) {
      this.deps.log('debug', 'preset enumeration failed: ' + String(error))
      return []
    }
  }

  /** Plugin version from package.json, read once. */
  private packageVersion(): string | undefined {
    if (this.pluginVersion === undefined) {
      try {
        const pkg = JSON.parse(readFileSync(join(dirname(__dirname), 'package.json'), 'utf8')) as { version?: string }
        this.pluginVersion = typeof pkg.version === 'string' ? pkg.version : undefined
      } catch {
        this.pluginVersion = undefined
      }
    }
    return this.pluginVersion
  }

  /** Git short commit of the plugin repo, read once (best-effort). */
  private gitCommit(): string | undefined {
    if (this.pluginCommit === undefined) {
      try {
        const root = dirname(__dirname)
        const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
        this.pluginCommit = commit !== '' ? commit : undefined
      } catch {
        this.pluginCommit = undefined
      }
    }
    return this.pluginCommit
  }

  /** Read the chat→session mapping file (for /id and /status when no live chat). */
  private async sessionIdFromMapping(chatId: ChatId): Promise<string | undefined> {
    const file = join(this.deps.config.mediaDir, MAPPING_FILE)
    try {
      const text = await readFile(file, 'utf8')
      const map = JSON.parse(text) as Record<string, string>
      const id = map[chatId]
      return typeof id === 'string' && id !== '' ? id : undefined
    } catch {
      return undefined
    }
  }

  /** Current default model selection, best-effort (absent services return undefined). */
  private safeDefaultModel(): ModelSelection | undefined {    try {
      return this.deps.agentDefaultModel?.currentSelection()
    } catch (error) {
      this.deps.log('debug', 'currentSelection failed: ' + String(error))
      return undefined
    }
  }

  /**
   * Build the message body text: placeholders become annotated local paths
   * (images/voices/videos) and voice files are transcribed when enabled.
   */
  private async buildBody(
    text: string,
    media: MediaRef[],
    chatId: ChatId,
    userId: string,
    messageType: string,
  ): Promise<string> {
    if (media.length === 0) return text
    let out = text
    for (const ref of media) {
      const placeholder = placeholderFor(ref)
      const idx = out.indexOf(placeholder)
      const annotation = await this.resolveMediaRef(ref, chatId, userId, messageType)
      if (idx >= 0 && annotation !== '') {
        out = out.slice(0, idx) + annotation + out.slice(idx + placeholder.length)
      }
    }
    return out
  }

  /** Resolve one media ref to a text annotation with a local path. */
  private async resolveMediaRef(ref: MediaRef, chatId: ChatId, userId: string, messageType: string): Promise<string> {
    if (ref.kind === 'file') {
      return await this.resolveNasFile(ref)
    }
    const resolved = await this.deps.media.resolve(ref, async (kind, file) => {
      if (kind === 'image') {
        const data = await this.deps.connection.call('get_image', { file }) as { url?: string; file?: string }
        return { url: data.url, file: data.file }
      }
      if (kind === 'voice') {
        const data = await this.deps.connection.call('get_record', { file, out_format: 'mp3' }) as { file?: string }
        return { file: data.file }
      }
      return undefined
    })
    if (resolved === undefined) return ''
    switch (resolved.kind) {
      case 'image':
        // Remember the most recent inbound image for /ocr (survives /new).
        this.chatLastImagePaths.set(chatId, resolved.path)
        return '[图片:' + resolved.path + ']'
      case 'voice': {
        if (this.deps.transcriber.enabled) {
          try {
            const text = await this.deps.transcriber.transcribe(resolved.path)
            const label = transcriptLabel(text)
            if (label !== '') return '[语音]' + label
          } catch (error) {
            this.deps.log('warn', 'STT failed: ' + (error instanceof Error ? error.message : String(error)))
          }
        }
        return '[语音]'
      }
      case 'video':
        return '[视频:' + resolved.path + ']'
      default:
        return '[文件:' + resolved.path + ']'
    }
  }

  /** Expand a quoted (reply) message into [引用] text via get_msg. */
  private async expandQuote(messageId: string): Promise<string> {
    try {
      const data = await this.deps.connection.call('get_msg', { message_id: Number(messageId) }) as {
        message?: unknown
        raw_message?: string
        sender?: { nickname?: string }
      }
      const segments = Array.isArray(data.message) ? data.message as OneBotSegment[] : undefined
      const raw = typeof data.raw_message === 'string' ? data.raw_message : ''
      const text = cqUnescape(segmentText(segments, raw))
      if (text.trim() === '') return ''
      const name = data.sender?.nickname ?? ''
      return '[引用]' + (name !== '' ? name + ': ' : '') + text
    } catch (error) {
      this.deps.log('debug', 'quote expansion failed: ' + (error instanceof Error ? error.message : String(error)))
      return ''
    }
  }

  /**
   * Fetch an inbound QQ file to a local path. NapCat's get_file may return
   * container-internal paths unreachable from this host, so:
   *   1. prefer the private-file direct link (get_private_file_url → HTTP
   *      CDN download, works for private chats);
   *   2. fall back to get_file base64 / http-url payloads.
   * Returns the [文件:path] annotation, or '' when disabled/failed.
   */
  private async resolveNasFile(ref: MediaRef): Promise<string> {
    const name = ref.name !== undefined && ref.name !== '' ? ref.name : 'file'
    const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_')
    const fid = ref.fileId ?? ref.file ?? ''
    if (fid === '') return ''
    try {
      // 1. Private-chat direct link (works without any container access).
      const direct = await this.deps.connection.call('get_private_file_url', { file_id: fid }) as {
        url?: string
      }
      if (direct.url !== undefined && direct.url !== '') {
        const localPath = await this.downloadToMedia(direct.url, safeName)
        if (localPath !== '') {
          this.deps.log('info', 'qq file fetched via direct link: ' + localPath)
          return '[文件:' + localPath + ']'
        }
      }
    } catch (error) {
      this.deps.log('debug', 'get_private_file_url failed (falling back to get_file): ' + (error instanceof Error ? error.message : String(error)))
    }
    // 2. get_file: with NapCat's file server enabled it returns a `base64`
    //    payload or an http(s) `url`; otherwise a container path we cannot reach.
    try {
      const data = await this.deps.connection.call('get_file', { file: fid }) as {
        file?: string
        url?: string
        base64?: string
        file_size?: string | number
      }
      const size = Number(data.file_size ?? 0)
      if (this.deps.config.maxInboundFileBytes > 0 && size > this.deps.config.maxInboundFileBytes) {
        this.deps.log('warn', 'qq file too large (' + size + 'B), skipping fetch')
        return ''
      }
      if (data.base64 !== undefined && data.base64 !== '') {
        const localPath = await this.writeMediaFile(Buffer.from(data.base64, 'base64'), safeName)
        if (localPath !== '') {
          this.deps.log('info', 'qq file fetched via get_file base64: ' + localPath)
          return '[文件:' + localPath + ']'
        }
      }
      if (data.url !== undefined && /^https?:\/\//.test(data.url)) {
        const localPath = await this.downloadToMedia(data.url, safeName)
        if (localPath !== '') {
          this.deps.log('info', 'qq file fetched via get_file url: ' + localPath)
          return '[文件:' + localPath + ']'
        }
      }
    } catch (error) {
      this.deps.log('debug', 'get_file base64/url path failed: ' + (error instanceof Error ? error.message : String(error)))
    }
    this.deps.log('warn', 'qq file fetch failed: no direct link / base64 / http url available for ' + fid)
    return ''
  }

  /** Download a URL into the local media dir; returns the path or ''. */
  private async downloadToMedia(url: string, safeName: string): Promise<string> {
    try {
      const response = await fetch(url)
      if (!response.ok || response.body === null) {
        this.deps.log('warn', 'qq file direct download failed: HTTP ' + response.status)
        return ''
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (this.deps.config.maxInboundFileBytes > 0 && buffer.length > this.deps.config.maxInboundFileBytes) {
        this.deps.log('warn', 'qq file too large (' + buffer.length + 'B), skipping')
        return ''
      }
      return await this.writeMediaFile(buffer, safeName)
    } catch (error) {
      this.deps.log('warn', 'qq file direct download failed: ' + (error instanceof Error ? error.message : String(error)))
      return ''
    }
  }

  /** Write bytes into the local media dir; returns the path or ''. */
  private async writeMediaFile(buffer: Buffer, safeName: string): Promise<string> {
    try {
      await mkdir(this.deps.config.mediaDir, { recursive: true })
      const localPath = this.deps.config.mediaDir.endsWith('/')
        ? this.deps.config.mediaDir + safeName
        : this.deps.config.mediaDir + '/' + safeName
      await writeFile(localPath, buffer)
      return localPath
    } catch (error) {
      this.deps.log('warn', 'media write failed: ' + (error instanceof Error ? error.message : String(error)))
      return ''
    }
  }

  /** Expand a combined-forward id into "name: content" lines. */
  private async expandForward(forwardId: string): Promise<string> {
    try {
      const data = await this.deps.connection.call('get_forward_msg', { id: forwardId }) as {
        messages?: Array<{ sender?: { nickname?: string; user_id?: number | string }; content?: unknown }>
      }
      const lines: string[] = []
      for (const node of data.messages ?? []) {
        const name = node.sender?.nickname ?? String(node.sender?.user_id ?? '未知')
        const text = nodeContentText(node.content)
        if (text !== '') lines.push(name + ': ' + text)
      }
      if (lines.length === 0) return ''
      return '[合并转发]\n' + lines.join('\n')
    } catch (error) {
      this.deps.log('debug', 'forward expansion failed: ' + (error instanceof Error ? error.message : String(error)))
      return '[合并转发]'
    }
  }

  // ------------------------------------------------------------ outbound

  /** Serialize work on one chat's send chain. */
  private enqueue<T>(chatId: ChatId, work: () => Promise<T>): Promise<T> {
    const existing = this.chats.get(chatId)
    const chain = (existing?.queue ?? Promise.resolve()) as Promise<unknown>
    const run = chain.then(work, work)
    if (existing !== undefined) {
      existing.queue = run.catch(() => undefined)
    } else {
      void run.catch(() => undefined)
    }
    return run
  }

  /** Send one message to a chat and return its message id. */
  private async sendMsg(chatId: ChatId, segments: OutboundSegment[], options: SendOptions): Promise<string | undefined> {
    const ref = splitChatId(chatId)
    const params: Record<string, unknown> = {}
    let target: number
    try {
      target = Number(ref.target)
      if (!Number.isFinite(target)) throw new Error('bad target')
    } catch {
      throw new OneBotActionError('invalid chat target: ' + chatId)
    }
    if (ref.kind === 'group') params.group_id = target
    else params.user_id = target
    params.message = segments
    if (options.replyTo !== undefined) {
      params.message = [{ type: 'reply', data: { id: options.replyTo } }, ...segments]
    }
    const data = await this.deps.connection.call('send_msg', params) as { message_id?: number | string }
    return data.message_id !== undefined ? String(data.message_id) : undefined
  }

  /** Send [[qq_forward]] nodes as a merged-forward message. */
  async sendForward(chatId: ChatId, nodes: Array<{ name: string; content: string }>): Promise<void> {
    const ref = splitChatId(chatId)
    const target = Number(ref.target)
    if (!Number.isFinite(target)) throw new OneBotActionError('invalid chat target: ' + chatId)
    const messages = nodes.map(node => ({
      type: 'node',
      data: {
        uin: this.deps.connection.selfId || this.deps.config.botQQ,
        name: node.name.slice(0, 24),
        content: [{ type: 'text', data: { text: node.content.slice(0, 500) } }],
      },
    }))
    if (ref.kind === 'group') {
      await this.deps.connection.call('send_forward_msg', { group_id: target, messages })
    } else {
      await this.deps.connection.call('send_private_forward_msg', { user_id: target, messages })
    }
  }

  /** Cancel a message's pending 90s auto-recall timer. */
  private clearInterimTimer(chat: ChatAgent, id: string): void {
    const timer = chat.recallTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      chat.recallTimers.delete(id)
    }
  }

  /** Clear every pending interim auto-recall timer for a chat (dispose path). */
  private clearInterimTimers(chat: ChatAgent): void {
    for (const timer of chat.recallTimers.values()) clearTimeout(timer)
    chat.recallTimers.clear()
  }

  /**
   * Recall the still-on-screen interim originals (turn/end step 2). Ids the
   * 90s timer already revoked during the turn are skipped (already gone).
   * Recall failure is logged only — the summary card still carries the text.
   */
  private async recallLoopMessages(chatId: ChatId, chat: ChatAgent, buf: Array<{ id: string; text: string }>): Promise<void> {
    for (const { id } of buf) {
      if (chat.recalledInterimIds.has(id)) continue
      this.clearInterimTimer(chat, id)
      try {
        await this.deps.connection.call('delete_msg', { message_id: id })
        chat.recalledInterimIds.add(id)
        await new Promise(resolve => setTimeout(resolve, RECALL_SPACING_MS))
      } catch (error) {
        this.deps.log('debug', 'loop recall delete_msg failed for ' + id + ': ' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }

  /** Fire when an interim's own 90s timer elapses mid-turn: revoke it alone. */
  private revokeInterim(chatId: ChatId, chat: ChatAgent, id: string): void {
    chat.recallTimers.delete(id)
    this.deps.connection.call('delete_msg', { message_id: id }).then(() => {
      chat.recalledInterimIds.add(id)
    }).catch(error => {
      this.deps.log('debug', 'interim auto-recall failed for ' + id + ': ' + (error instanceof Error ? error.message : String(error)))
    })
  }

  /** Render this turn's interims into one t2i image (summary card, before final). */
  private async sendInterimSummary(chatId: ChatId, buf: Array<{ id: string; text: string }>): Promise<void> {
    const body = buf.map((item, index) => (index + 1) + '. ' + item.text.trim()).filter(line => line !== '').join('\n\n')
    if (body === '') return
    let png: Buffer
    try {
      png = renderTextImage(body, {
        title: '📋 本轮中间记录',
        footerBrand: this.deps.config.cardFooter,
        fontFiles: this.deps.config.fontFiles,
        fontFamilies: this.deps.config.fontFamilies,
      })
    } catch (error) {
      this.deps.log('warn', 'interim summary t2i failed, sending as text: ' + (error instanceof Error ? error.message : String(error)))
      await this.sendToChat(chatId, body)
      return
    }
    const b64 = 'base64://' + png.toString('base64')
    if (b64.length <= this.deps.config.maxImageBytes) {
      await this.sendMsg(chatId, [{ type: 'image', data: { file: b64 } }], {})
    } else {
      await this.sendToChat(chatId, body)
    }
  }

  // ------------------------------------------------------------ session events

  /** Send one interim live and record it: text for the turn/end summary card,
   * plus a per-message auto-recall timer (config interimRecallMs) so long turns
   * clean up their early messages even before the summary arrives. */
  private sendInterim(chatId: ChatId, chat: ChatAgent, text: string): void {
    this.sendToChat(chatId, text).then(ids => {
      const sentAt = Date.now()
      for (const id of ids) {
        chat.loopBuffer.push({ id, text, sentAt })
        const delay = this.deps.config.interimRecallMs ?? 90_000
        const timer = setTimeout(() => this.revokeInterim(chatId, chat, id), delay)
        chat.recallTimers.set(id, timer)
      }
    }).catch(error => {
      this.deps.log('warn', 'interim send failed: ' + (error instanceof Error ? error.message : String(error)))
    })
  }

  /**
   * Settle a finished turn's interim trail (interimMessages on): drain the send
   * chain so every interim id is recorded, then render ONE t2i summary card of
   * all interims, immediately recall the still-on-screen originals, and finally
   * send the deferred final text. No merged-forward any more — QQ refuses to
   * recall messages older than ~2 min, and a forward of aged interims would
   * leave the originals plus a duplicate card, so interims are surfaced live
   * and auto-revoked per message (90s) during long turns.
   */
  private async settleLoop(chatId: ChatId, chat: ChatAgent): Promise<void> {
    try {
      await chat.queue
    } catch {
      // failures already settle the enqueue chain; keep going
    }
    const buf = chat.loopBuffer
    chat.loopBuffer = []
    if (buf.length >= 1) {
      try {
        await this.sendInterimSummary(chatId, buf)
      } catch (error) {
        this.deps.log('warn', 'interim summary send failed: ' + (error instanceof Error ? error.message : String(error)))
      }
      try {
        await this.recallLoopMessages(chatId, chat, buf)
      } catch (error) {
        this.deps.log('warn', 'loop recall failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    if (chat.loopPending !== null) {
      const final = chat.loopPending
      chat.loopPending = null
      try {
        await this.sendToChat(chatId, final)
      } catch (error) {
        this.deps.log('warn', 'final send failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (this.stopping) return
    const chatId = this.bySession.get(session.id)
    if (chatId === undefined) return
    const chat = this.chats.get(chatId)
    if (chat === undefined || chat.sessionId !== session.id) return
    if (event.type === 'assistant/message') {
      // Dedupe: the session may re-emit the same message (streaming/usage
      // updates); each id is handled exactly once, or interims would send
      // repeatedly and flood the loop buffer.
      const messageId = event.data.message.id
      if (messageId !== undefined && chat.lastHandledMessageId === messageId) return
      if (messageId !== undefined) chat.lastHandledMessageId = messageId
      // Host-plane cards (plan review / ask_user_question) never enter the
      // session text stream — the model calls a tool whose arguments carry the
      // content and whose text block is empty, so the `text === ''` early
      // return below would otherwise leave QQ silent. Relay those cards here,
      // before any early return, so the user is never left hanging.
      this.relayHostCards(chatId, event.data.message.content)
      const text = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (text === '') return
      if (this.effectiveInterim(chatId)) {
        // The arriving message proves the previously deferred text interim —
        // flush it now, regardless of this message's shape.
        const prior = chat.loopPending
        if (prior !== null) {
          chat.loopPending = null
          this.sendInterim(chatId, chat, prior)
        }
        // A message carrying tool calls can never be the final reply (the
        // model continues after the tool) — send it immediately instead of
        // deferring one step, so QQ receives interims without the one-step
        // lag. Only tool-free text stays deferred until turn/end proves it
        // either interim (next assistant/message) or final.
        const hasToolCall = event.data.message.content.some(block => block.type === 'tool-call')
        if (hasToolCall) {
          this.sendInterim(chatId, chat, text)
        } else {
          chat.loopPending = text
        }
      } else {
        chat.pendingFinal = text
      }
      return
    }
    if (event.type === 'turn/end') {
      if (this.effectiveInterim(chatId)) {
        void this.settleLoop(chatId, chat)
      } else if (chat.pendingFinal !== '') {
        const final = chat.pendingFinal
        chat.pendingFinal = ''
        this.sendToChat(chatId, final).catch(error => {
          this.deps.log('warn', 'final send failed: ' + (error instanceof Error ? error.message : String(error)))
        })
      }
      if (event.data.reason.kind === 'error' && this.deps.config.sendErrorNotice) {
        const message = event.data.reason.error.message
        this.sendToChat(chatId, '⚠️ 运行出错：' + message).catch(() => undefined)
        if (/persisted log on disk that does not match this live session|id collision/i.test(message)) {
          void this.healSessionCollision(chatId)
        }
      }
      this.stopTyping(chat)
      chat.busy = false
      this.deps.log('info', 'turn/end for ' + chatId + ': ' + event.data.reason.kind)
      // Durable: flush the session so a later restart can resume it.
      void this.deps.sessions.flush(chat.agent.session).catch((error: unknown) => {
        this.deps.log('warn', 'session flush failed: ' + String(error))
      })
      void this.saveMappingDebounced()
    }
  }

  private async onSessionFlush(session: Session): Promise<void> {
    if (this.stopping) return
    const chatId = this.bySession.get(session.id)
    if (chatId === undefined) return
    await this.saveMapping()
  }

  // ------------------------------------------------------------ chat lifecycle

  /** Get (or create) the agent for a chat. */
  private async ensureChat(chatId: ChatId, nickname: string): Promise<ChatAgent> {
    const existing = this.chats.get(chatId)
    if (existing !== undefined) return existing
    await this.mappingLoaded
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
    const selection = this.deps.defaultModel?.()
    const agentOptions: { provider?: string; model?: string } = {}
    if (selection !== undefined) {
      agentOptions.provider = selection.provider
      agentOptions.model = selection.model
    }
    const cwd = this.effectiveCwd(chatId)
    const presetId = await this.resolvePresetId(chatId)
    const meta: { cwd: string; agentPreset?: string } = { cwd }
    if (presetId !== undefined) meta.agentPreset = presetId
    const selectionRef = selection !== undefined
      ? { current: selection, assembled: undefined }
      : undefined
    const setup: AgentSetup = async agentCtx => {
      this.installChannelScope(agentCtx)
      await this.joinPreset(agentCtx)
      if (selectionRef !== undefined) {
        installModelSelection(agentCtx, selectionRef)
      }
    }
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
      this.deps.log('warn', 'agent create failed (' + (error instanceof Error ? error.message : String(error)) + '); retrying with ' + fallbackId)
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
    const chat: ChatAgent = {
      chatId,
      sessionId: actualSessionId,
      agent: handle.agent,
      dispose: () => handle.dispose(),
      queue: Promise.resolve(),
      pendingFinal: '',
      loopPending: null,
      loopBuffer: [],
      recallTimers: new Map(),
      recalledInterimIds: new Set(),
      lastHandledMessageId: undefined,
      busy: false,
      typingTimer: undefined,
      lastNickname: nickname,
      lastUserId: '',
      lastFollowup: undefined,
      selectionRef,
    }
    await handle.agent.whenIdle()
    this.chats.set(chatId, chat)
    this.bySession.set(actualSessionId, chatId)
    this.deps.log('info', 'agent created for ' + chatId + ' (session ' + actualSessionId + ')')
    void this.saveMapping()
    return chat
  }

  /** Resume persisted chats from the mapping file (best-effort). */
  private async loadMapping(): Promise<void> {
    try {
      const content = await readFile(this.mappingPath(), 'utf8')
      const mapping = JSON.parse(content) as Record<string, string>
      this.deps.log('debug', 'mapping file has ' + Object.keys(mapping).length + ' chat(s)')
      for (const [chatId, sessionId] of Object.entries(mapping)) {
        this.deps.log('debug', 'attempting resume of ' + chatId + ' @ ' + sessionId)
        if (this.stopping) return
        try {
          const selection = this.deps.defaultModel?.()
          const agentOptions: { provider?: string; model?: string } = {}
          const selectionRef = selection !== undefined
            ? { current: selection, assembled: undefined }
            : undefined
          if (selection !== undefined) {
            agentOptions.provider = selection.provider
            agentOptions.model = selection.model
          }
          const recordedPreset = await this.recordedPresetFor(makeSessionId(sessionId))
          const handle = await this.deps.agents.resume({
            resumeSessionId: makeSessionId(sessionId),
            agentOptions,
            setup: async agentCtx => {
              this.installChannelScope(agentCtx)
              await this.joinPreset(agentCtx, recordedPreset)
              if (selectionRef !== undefined) {
                installModelSelection(agentCtx, selectionRef)
              }
            },
          })
          await this.attachToWorkspace(handle.agent.session.id, handle.agent.session.header?.cwd)
          // /workspace persistence across restarts: the per-chat override map is
          // in-memory only, but a session's cwd is frozen in its header. When the
          // resumed session's directory differs from what this chat would default
          // to now, restore it as the override so /workspace and future /new
          // sessions keep using it.
          const headerCwd = handle.agent.session.header?.cwd
          if (headerCwd !== undefined && headerCwd !== '' && headerCwd !== this.effectiveCwd()) {
            this.chatWorkspacePaths.set(chatId, headerCwd)
            this.deps.log('debug', 'workspace override restored for ' + chatId + ': ' + headerCwd)
          }
          const chat: ChatAgent = {
            chatId,
            sessionId: handle.agent.session.id,
            agent: handle.agent,
            dispose: () => handle.dispose(),
            queue: Promise.resolve(),
            pendingFinal: '',
            loopPending: null,
            loopBuffer: [],
            recallTimers: new Map(),
            recalledInterimIds: new Set(),
            lastHandledMessageId: undefined,
            busy: false,
            typingTimer: undefined,
            lastNickname: '',
            lastUserId: '',
            lastFollowup: undefined,
            selectionRef,
          }
          await handle.agent.whenIdle()
          this.chats.set(chatId, chat)
          this.bySession.set(handle.agent.session.id, chatId)
        } catch (error) {
          this.retireSession(sessionId)
          this.deps.log('warn', 'resume failed for ' + chatId + ': ' + (error instanceof Error ? error.message : String(error)))
        }
      }
    } catch {
      // No mapping file yet — fresh start.
    }
  }

  private mappingPath(): string {
    return this.deps.config.mediaDir.endsWith('/') || this.deps.config.mediaDir.endsWith('\\')
      ? this.deps.config.mediaDir + MAPPING_FILE
      : this.deps.config.mediaDir + '/' + MAPPING_FILE
  }

  private async saveMapping(): Promise<void> {
    try {
      await mkdir(this.deps.config.mediaDir, { recursive: true })
      const mapping: Record<string, string> = {}
      for (const chat of this.chats.values()) {
        mapping[chat.chatId] = chat.sessionId
      }
      await writeFile(this.mappingPath(), JSON.stringify(mapping, null, 2), 'utf8')
    } catch (error) {
      this.deps.log('warn', 'mapping save failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  private saveMappingDebounced(): void {
    if (this.mappingSaveTimer !== undefined) clearTimeout(this.mappingSaveTimer)
    this.mappingSaveTimer = setTimeout(() => {
      this.mappingSaveTimer = undefined
      void this.saveMapping()
    }, 2_000).unref()
  }

  // ------------------------------------------------------------ retired ids

  /** Whether a session id must never be created again (this run or on disk). */
  private isSessionIdBlocked(id: string): boolean {
    return this.brokenSessions.has(id) || this.retiredSessionIds.includes(id)
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
    if (!this.retiredSessionIds.includes(id)) {
      this.retiredSessionIds.push(id)
    }
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

  private async loadRetired(): Promise<void> {
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
        this.deps.log('warn', 'retired-sessions read failed; keeping the current set: ' + (error instanceof Error ? error.message : String(error)))
      }
      return
    }
    try {
      const parsed = JSON.parse(content) as unknown
      if (Array.isArray(parsed)) {
        this.retiredSessionIds = parsed.filter((id): id is string => typeof id === 'string')
        for (const id of this.retiredSessionIds) this.brokenSessions.add(id)
        this.deps.log('debug', 'retired-sessions file has ' + this.retiredSessionIds.length + ' id(s)')
      } else {
        this.deps.log('warn', 'retired-sessions file is not a JSON array; ignoring')
      }
    } catch (error) {
      // Corrupt JSON: keep the current in-memory set (never replace it with
      // an empty array) and warn so a future save does not obliterate history.
      this.deps.log('warn', 'retired-sessions file is unparsable; keeping the current set: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  private async saveRetired(): Promise<void> {
    try {
      await mkdir(this.deps.config.mediaDir, { recursive: true })
      // Atomic write: a temp file + rename never leaves a half-written file
      // that a concurrent/future loadRetired could parse into a broken empty set.
      const tmpPath = this.retiredPath() + '.tmp'
      await writeFile(tmpPath, JSON.stringify(this.retiredSessionIds, null, 2), 'utf8')
      await rename(tmpPath, this.retiredPath())
    } catch (error) {
      this.deps.log('warn', 'retired-sessions save failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /**
   * Recover from a session-log collision: the live session cannot append to
   * the mismatched on-disk log, so dispose the agent and rebuild the chat on
   * a fresh session id. The user is asked to resend.
   */
  private async healSessionCollision(chatId: ChatId): Promise<void> {
    const chat = this.chats.get(chatId)
    if (chat === undefined) return
    this.retireSession(chat.sessionId)
    // The bare derived id shares the chat's stale log; retire it too so the
    // next ensureChat can never pick it again in this run OR after a restart.
    this.retireSession(sessionIdForChat(chatId))
    this.chats.delete(chatId)
    this.bySession.delete(chat.sessionId)
    this.stopTyping(chat)
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
  private effectiveCwd(chatId?: ChatId): string {
    if (chatId !== undefined) {
      const override = this.chatWorkspacePaths.get(chatId)
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
  private async resolvePresetId(chatId: ChatId): Promise<string | undefined> {
    // A /preset override wins for this chat (survives /new, so the re-created
    // session registers the chosen preset in its header).
    const override = chatId !== undefined ? this.chatPresetOverrides.get(chatId) : undefined
    if (override !== undefined && override !== '') return override
    const presets = this.deps.agentPresets
    if (presets === undefined) return undefined
    const configured = this.deps.config.agentPreset
    const wanted = configured !== undefined && configured !== '' ? configured : presets.defaultId
    try {
      const preset = await presets.resolve(wanted)
      return preset.id
    } catch (error) {
      this.deps.log('warn', 'agent preset resolve failed; session header records no preset: ' + (error instanceof Error ? error.message : String(error)))
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
      this.deps.log('warn', 'preset record read failed for ' + sessionId + ' (falling back to config/default): ' + (error instanceof Error ? error.message : String(error)))
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
      this.deps.log('warn', 'agent preset mount failed (tools fall back to the global layer): ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /**
   * Compose the QQ channel's scoped world for one agent: the QQ platform
   * prompt section and the qq_* tools. Registered on `agentCtx` (the agent's
   * own scope) instead of the plugin context, so Web/local sessions never see
   * the channel instructions or the media tools — they cannot (and should
   * not) push messages to QQ.
   */
  private installChannelScope(agentCtx: Context): void {
    agentCtx.systemPrompt.section({
      name: 'channel:dsh-onebot',
      order: 90,
      text: buildPlatformPrompt(this.deps.config.restrictedMemberPrefix),
    })
    registerTools(agentCtx, this, this.deps.connection, {
      maxImageBytes: this.deps.config.maxImageBytes,
      maxVoiceBytes: this.deps.config.maxVoiceBytes,
      maxFileBytes: this.deps.config.maxFileBytes,
    })
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
      this.deps.log('warn', 'workspace attach failed for ' + sessionId + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /**
   * /new: dispose the current chat agent and retire its session id, so the
   * next inbound message creates a brand-new session (fresh history; the old
   * conversation stays on disk). The confirmation is sent directly through
   * the outbound pipeline since no agent is left to reply.
   */
  private async resetChat(chatId: ChatId): Promise<void> {
    const chat = this.chats.get(chatId)
    if (chat !== undefined) {
      this.stopTyping(chat)
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
        this.deps.log('warn', 'reset dispose failed: ' + (error instanceof Error ? error.message : String(error)))
      }
      this.deps.log('info', 'reset chat ' + chatId + ' (old session ' + chat.sessionId + ' retired)')
    }
    void this.saveMapping()
    this.sendToChat(chatId, '✅ 已开启新会话，下一条消息将进入全新会话，旧对话历史保留在之前的会话中。').catch((error: unknown) => {
      this.deps.log('warn', 'reset notice send failed: ' + String(error))
    })
  }

  // ------------------------------------------------------------ typing

  /** Start the NapCat typing indicator (private chats only). */
  private startTyping(chat: ChatAgent): void {
    const ref = splitChatId(chat.chatId)
    if (ref.kind !== 'private') return
    this.stopTyping(chat)
    const pulse = (): void => {
      if (this.stopping) return
      void this.deps.connection.call('set_input_status', {
        user_id: Number(ref.target),
        event_type: 1,
      }).catch(() => undefined)
    }
    pulse()
    chat.typingTimer = setInterval(pulse, 5_000).unref()
  }

  /** Stop the typing indicator. */
  private stopTyping(chat: ChatAgent): void {
    if (chat.typingTimer !== undefined) {
      clearInterval(chat.typingTimer)
      chat.typingTimer = undefined
    }
    const ref = splitChatId(chat.chatId)
    if (ref.kind !== 'private') return
    void this.deps.connection.call('set_input_status', {
      user_id: Number(ref.target),
      event_type: 0,
    }).catch(() => undefined)
  }
}

/** The placeholder a media ref contributes to the parsed text. */
function placeholderFor(ref: MediaRef): string {
  switch (ref.kind) {
    case 'image': return '[图片]'
    case 'voice': return '[语音]'
    case 'video': return '[视频]'
    default: return ref.name !== undefined ? '[文件:' + ref.name + ']' : '[文件]'
  }
}

/**
 * Extract text from a forward-node content (segment array or CQ string).
 */
function nodeContentText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map(seg => {
        const s = seg as { type?: string; data?: Record<string, unknown> }
        if (s?.type === 'text') return String(s.data?.text ?? '')
        if (s?.type === 'face') return '😀'
        return '[非文本]'
      })
      .join('')
      .trim()
  }
  if (typeof content === 'string') return content.trim()
  return ''
}

/** Convenience for tools: file → base64 segment with the plugin's caps. */
export async function imageSegment(path: string, maxBytes: number): Promise<OutboundSegment> {
  return { type: 'image', data: { file: await fileToBase64(path, maxBytes) } }
}

export { OneBotNotConnectedError, OneBotActionError }
