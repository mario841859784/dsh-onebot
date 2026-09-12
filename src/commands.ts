/**
 * Slash-command surface (M2-D1-PR1): the routed command table, the narrow
 * CommandContext through which handlers touch the bridge, and the router.
 * Extracted verbatim from bridge.ts — reply texts, argument parsing and
 * error behavior are byte-identical to the pre-split if-chain; /help is now
 * generated from the table (snapshot-gated in tests/commands.spec.ts).
 * @module dsh-onebot/commands
 */
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { OneBotConnection } from './connection.js'
import type { MediaRef } from './cq.js'
import type { ChatId, UserRole } from './chat.js'
import { fileToBase64 } from './media.js'
import type { AgentDefaultModelLike, AgentPresetsLike, BridgeConfig, BridgeDeps, LlmCatalogPort, WorkspaceRegistryLike } from './bridge.js'
import { describeError } from './errors.js'

/** Narrow view of a live chat the command handlers may read or mutate —
 * the structural subset of the bridge's internal ChatAgent that the
 * pre-split handlers actually touched. */
export interface CommandChatView {
  agent: Agent
  sessionId: SessionId
  busy: boolean
  lastFollowup: string | undefined
  lastNickname: string
  loopPending: string | null
  loopBuffer: Array<{ id: string; text: string; sentAt: number }>
  selectionRef: ModelSelectionRef | undefined
}

/** The bridge capabilities the command surface may touch. Deliberately
 * narrower than BridgeDeps: handlers get the outbound send path, the
 * per-chat state they already owned pre-split, and the few services they
 * call — never the agent registry, media store, or the policy allowlists
 * (the admin gate is answered by `isAdmin`, not by exposing `policy`). */
export interface CommandContext {
  /** Full outbound pipeline send (the commands' only reply path). */
  sendToChat(chatId: ChatId, text: string): Promise<string[]>
  /** Bridge log line callback. */
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
  /** Router entry gate: the admin check against the policy allowlist. */
  isAdmin(userId: string): boolean
  /** Live chat lookup / existence probe. */
  getChat(chatId: ChatId): CommandChatView | undefined
  hasChat(chatId: ChatId): boolean
  /** Registry capabilities the commands legitimately trigger. */
  resetChat(chatId: ChatId): Promise<void>
  dispatchFollowup(chatId: ChatId, text: string, role: UserRole, nickname?: string): Promise<void>
  /** Per-chat state readers/writers (the pre-split private maps). */
  effectiveCwd(chatId: ChatId): string
  sessionIdFromMapping(chatId: ChatId): Promise<string | undefined>
  resolvePresetId(chatId: ChatId): Promise<string | undefined>
  setChatWorkspacePath(chatId: ChatId, path: string): void
  presetOverride(chatId: ChatId): string | undefined
  setPresetOverride(chatId: ChatId, id: string): void
  hasPresetOverride(chatId: ChatId): boolean
  interimOverride(chatId: ChatId): boolean | undefined
  setInterimOverride(chatId: ChatId, value: boolean): void
  goal(chatId: ChatId): string | undefined
  setGoal(chatId: ChatId, value: string): void
  deleteGoal(chatId: ChatId): void
  lastImagePath(chatId: ChatId): string | undefined
  lastImagePath(chatId: ChatId): string | undefined
  /** Lazy media resolution for the /ocr pending image ref (C6a). */
  resolveMediaRef(ref: MediaRef, chatId: ChatId): Promise<string>
  /** Consume the pending pre-routing image ref (get + delete, /ocr only). */
  takePendingImageRef(chatId: ChatId): MediaRef | undefined
  /** Services (narrow slices of the bridge deps). */
  /** Live model catalog for /model (M2-C5b port; index.ts wires it over the
   * live llm service — commands never touch Context). */
  llmCatalog: LlmCatalogPort | undefined
  workspaceRegistry: WorkspaceRegistryLike | undefined
  agentDefaultModel: AgentDefaultModelLike | undefined
  agentPresets: AgentPresetsLike | undefined
  commands: BridgeDeps['commands']
  connection: OneBotConnection
  dshHome: string | undefined
  /** The only config fields the commands read. */
  config: Pick<BridgeConfig, 'interimMessages' | 'maxImageBytes'>
}

/** One routed slash command: the table row IS the registration (D1-PR1) —
 * adding a command is exactly one row here and /help picks it up for free. */
export interface CommandDefinition {
  /** Command word after the leading slash (matched case-insensitively). */
  name: string
  /** Admin-only flag; every current command is gated at the router entry. */
  adminOnly: boolean
  /** /help description shown after "/name " (exact pre-split wording). */
  help: string
  handler(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void>
}

/** The routed command table. Row order = /help output order (the router
 * matches by name, so ordering is routing-neutral). */
export const COMMANDS: CommandDefinition[] = [
  { name: 'new', adminOnly: true, help: '开启新会话（清空上下文）', handler: async (ctx, chatId) => {
    ctx.log('info', 'slash /new for ' + chatId)
    await ctx.resetChat(chatId)
  } },
  { name: 'stop', adminOnly: true, help: '停止当前生成', handler: (ctx, chatId) => handleStopCommand(ctx, chatId) },
  { name: 'model', adminOnly: true, help: '[--default] <provider> <model> 查看或切换模型（--default 改部署默认）', handler: (ctx, chatId, arg) => handleModelCommand(ctx, chatId, arg) },
  { name: 'workspace', adminOnly: true, help: '[路径|list] 查看或切换工作区', handler: (ctx, chatId, arg) => handleWorkspaceCommand(ctx, chatId, arg) },
  { name: 'preset', adminOnly: true, help: '[id] 查看或切换 agent 预设', handler: (ctx, chatId, arg) => handlePresetCommand(ctx, chatId, arg) },
  { name: 'status', adminOnly: true, help: '会话全景状态', handler: (ctx, chatId) => handleStatusCommand(ctx, chatId) },
  { name: 'retry', adminOnly: true, help: '重跑上一条', handler: (ctx, chatId) => handleRetryCommand(ctx, chatId) },
  { name: 'id', adminOnly: true, help: '查看 session/chat id', handler: (ctx, chatId) => handleIdCommand(ctx, chatId) },
  { name: 'ver', adminOnly: true, help: '插件版本', handler: (ctx, chatId) => handleVerCommand(ctx, chatId) },
  { name: 'ocr', adminOnly: true, help: '识别最近一张图片', handler: (ctx, chatId) => handleOcrCommand(ctx, chatId) },
  { name: 'mode', adminOnly: true, help: '[interim|instant] 切换出站模式', handler: (ctx, chatId, arg) => handleModeCommand(ctx, chatId, arg) },
  { name: 'plan', adminOnly: true, help: '[off|内容] 宿主计划模式（/plan off 退出）', handler: (ctx, chatId, arg) => handlePlanCommand(ctx, chatId, arg) },
  { name: 'goal', adminOnly: true, help: '[目标|clear] 查看/设置目标', handler: (ctx, chatId, arg) => handleGoalCommand(ctx, chatId, arg) },
  { name: 'help', adminOnly: true, help: '本帮助', handler: async (ctx, chatId) => {
    await ctx.sendToChat(chatId, helpText())
  } },
]

/** /help body, generated from the table so a new registration stays a
 * one-row change. Byte-identical to the pre-split hardcoded text. */
function helpText(): string {
  return '可用命令：\n' + COMMANDS.map(c => '/' + c.name + ' ' + c.help).join('\n') + '\n\n其他 / 开头的文本会直接交给模型。'
}

/**
 * Slash-command router. Commands are admin-only (the Hermes member
 * slash-command block) and are matched on the first word; a leading
 * @mention glued to the command (QQ group at + text) is stripped first.
 * A path like /tmp/x is never a command (command words are
 * /[A-Za-z][A-Za-z0-9_-]* only). Unknown commands return false so the
 * message reaches the model, matching the Hermes "fall through" behavior.
 * @param ctx - bridge capabilities (built by ChatBridge).
 * @param chatId - the chat the command arrived in.
 * @param text - parsed inbound text.
 * @param userId - sender QQ number.
 * @returns true when the message was consumed by a command.
 */
export async function tryHandleCommand(ctx: CommandContext, chatId: ChatId, text: string, userId: string): Promise<boolean> {
  const normalized = text.replace(/^@\d+\s*/, '')
  const first = (normalized.split(/\s+/, 1)[0] ?? '').trim()
  if (!/^\/[A-Za-z][A-Za-z0-9_-]*$/.test(first)) return false

  if (!ctx.isAdmin(userId)) {
    await ctx.sendToChat(chatId, '该命令仅管理员可用。')
    return true
  }

  const name = first.slice(1).toLowerCase()
  ctx.log('debug', 'slash /' + name + ' for ' + chatId)
  const command = COMMANDS.find(c => c.name === name)
  if (command === undefined) return false
  await command.handler(ctx, chatId, normalized.slice(first.length).trim())
  return true
}

/** /stop: cancel the running generation and drop deferred loop state. */
async function handleStopCommand(ctx: CommandContext, chatId: ChatId): Promise<void> {
  const chat = ctx.getChat(chatId)
  if (chat !== undefined && chat.agent.status === 'running') {
    chat.agent.cancel({ kind: 'user' })
    // Drop the deferred loop state so the cancelled turn settles silently
    // instead of flushing its partial text as a final.
    chat.loopPending = null
    chat.loopBuffer = []
    await ctx.sendToChat(chatId, '⏹ 已停止生成。')
  } else {
    await ctx.sendToChat(chatId, '当前没有正在进行的生成。')
  }
}

/** /model: show the current model (+ discoverable providers), or switch.
 * A bare switch retargets ONLY this chat's selection ref (M2-C5a: it no
 * longer rewrites the deployment default — that is the explicit --default
 * form's job). */
async function handleModelCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void> {
  const chat = ctx.getChat(chatId)
  const current = chat?.selectionRef?.current
    ?? safeDefaultModel(ctx)
  if (arg === '') {
    const cur = current !== undefined ? current.provider + '/' + current.model : '（未设置）'
    let out = '当前模型：' + cur
    try {
      const providers = ctx.llmCatalog?.listProviders() ?? []
      for (const p of providers.slice(0, 6)) {
        try {
          const models = (await ctx.llmCatalog?.listModels(p.id)) ?? []
          out += '\n' + p.id + ': ' + models.slice(0, 10).map(m => m.id).join(', ')
        } catch (error) {
          out += '\n' + p.id + ': （列表不可用）'
          ctx.log('warn', 'listModels failed for ' + p.id + ': ' + String(error))
        }
      }
    } catch (error) {
      out += '\n（模型列表不可用）'
      ctx.log('warn', 'listProviders failed: ' + String(error))
    }
    await ctx.sendToChat(chatId, out)
    return
  }
  const first = arg.split(/\s+/, 1)[0] ?? ''
  const toDefault = first === '--default'
  const rest = toDefault ? arg.slice(first.length).trim() : arg
  const m = /^(\S+)[\s/]+(\S+)$/.exec(rest)
  if (m === null) {
    await ctx.sendToChat(chatId, '用法：/model <provider> <model> 切换当前会话；/model --default <provider> <model> 修改部署默认')
    return
  }
  const provider = m[1]
  const model = m[2]
  try {
    const models = (await ctx.llmCatalog?.listModels(provider)) ?? []
    if (models.length > 0 && !models.some(x => x.id === model)) {
      await ctx.sendToChat(chatId, `❌ ${provider} 下没有模型 ${model}。可用：` + models.slice(0, 10).map(x => x.id).join(', '))
      return
    }
  } catch (error) {
    ctx.log('debug', 'model switch precheck failed for ' + provider + ': ' + String(error))
  }
  const next = { provider, model }
  if (toDefault) {
    // Explicit --default: rewrite the deployment-wide default only (M2-C5a).
    if (ctx.agentDefaultModel !== undefined) {
      try {
        await ctx.agentDefaultModel.saveSelection(next)
      } catch (error) {
        ctx.log('warn', 'saveSelection failed: ' + String(error))
      }
    }
    await ctx.sendToChat(chatId, `✅ 已修改部署默认模型：${provider}/${model}（下一步生效）`)
    return
  }
  // Bare switch: retarget only this chat's selection ref — never the global
  // default (M2-C5a; the old silent saveSelection here was a scope leak).
  if (chat?.selectionRef !== undefined) {
    chat.selectionRef.current = next
  }
  await ctx.sendToChat(chatId, `✅ 已切换当前会话模型：${provider}/${model}（下一步生效）`)
}

/** /workspace: show current cwd, list workspaces, or switch directory. */
async function handleWorkspaceCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void> {
  if (arg === '') {
    const cwd = ctx.effectiveCwd(chatId)
    let suffix = ''
    try {
      const ws = await ctx.workspaceRegistry?.resolveByPath(cwd)
      suffix = ws !== undefined ? `（工作区 ${ws.id}，${ws.sessionIds.length} 个会话）` : '（无 workspace 记录）'
    } catch (error) {
      ctx.log('debug', 'resolveByPath failed: ' + String(error))
    }
    await ctx.sendToChat(chatId, `当前工作目录：${cwd} ${suffix}\n用法：/workspace <目录路径> 切换；/workspace list 列出全部`)
    return
  }
  if (arg === 'list') {
    try {
      const list = ctx.workspaceRegistry?.list() ?? []
      if (list.length === 0) {
        await ctx.sendToChat(chatId, '（没有任何 workspace 记录）')
        return
      }
      await ctx.sendToChat(chatId, list.map(w => `${w.id}  ${w.path}（${w.sessionIds.length} 会话）`).join('\n'))
    } catch (error) {
      ctx.log('debug', 'workspace list failed: ' + String(error))
      await ctx.sendToChat(chatId, '❌ 无法列出工作区。')
    }
    return
  }
  try {
    const path = await realpath(arg)
    const s = await stat(path)
    if (!s.isDirectory()) {
      await ctx.sendToChat(chatId, `❌ 不是目录：${arg}`)
      return
    }
    const hadChat = ctx.hasChat(chatId)
    ctx.setChatWorkspacePath(chatId, path)
    if (hadChat) {
      // Retire the current agent: its session cwd is frozen at creation, so
      // the next message re-creates the session under the new directory.
      await ctx.resetChat(chatId)
    }
    await ctx.sendToChat(chatId, `✅ 工作区已切换：${path}\n下一条消息将使用新工作区（新会话）。`)
    ctx.log('info', 'workspace switch for ' + chatId + ' -> ' + path)
  } catch (error) {
    ctx.log('debug', 'workspace switch failed: ' + String(error))
    await ctx.sendToChat(chatId, `❌ 目录无效或不可访问：${arg}`)
  }
}

/** /id: show the chat/session identity (admin debug aid). */
async function handleIdCommand(ctx: CommandContext, chatId: ChatId): Promise<void> {
  const sessionId = ctx.getChat(chatId)?.sessionId ?? await ctx.sessionIdFromMapping(chatId)
  await ctx.sendToChat(chatId,
    'chat    : ' + chatId + '\n' +
    'session : ' + (sessionId ?? '（未建立会话，下一条消息创建）') + '\n' +
    'cwd     : ' + ctx.effectiveCwd(chatId))
}

/** /ver: plugin version + git commit (each read once and cached). */
async function handleVerCommand(ctx: CommandContext, chatId: ChatId): Promise<void> {
  const commit = gitCommit()
  await ctx.sendToChat(chatId, 'dsh-onebot v' + (packageVersion() ?? '?') + (commit !== undefined ? ' (' + commit + ')' : ''))
}

/** /status: one-shot snapshot of the chat session state. */
async function handleStatusCommand(ctx: CommandContext, chatId: ChatId): Promise<void> {
  const chat = ctx.getChat(chatId)
  const sessionId = chat?.sessionId ?? await ctx.sessionIdFromMapping(chatId)
  const override = ctx.presetOverride(chatId)
  let preset: string
  if (override !== undefined) {
    preset = override + '（/preset 覆盖）'
  } else {
    const resolved = await ctx.resolvePresetId(chatId)
    preset = (resolved ?? undefined) !== undefined ? (resolved ?? '') + '（默认/配置）' : '（未记录）'
  }
  const current = chat?.selectionRef?.current ?? safeDefaultModel(ctx)
  const model = current !== undefined ? current.provider + '/' + current.model : '（未设置）'
  const cwd = ctx.effectiveCwd(chatId)
  let wsSuffix = ''
  try {
    const ws = await ctx.workspaceRegistry?.resolveByPath(cwd)
    wsSuffix = ws !== undefined ? `（工作区 ${ws.id}，${ws.sessionIds.length} 个会话）` : '（无 workspace 记录）'
  } catch (error) {
    ctx.log('debug', 'resolveByPath failed: ' + String(error))
  }
  const interim = ctx.interimOverride(chatId)
  const modeLabel = interim !== undefined
    ? (interim ? 'interim（合并卡片）' : 'instant（逐条即时）') + '（/mode 覆盖）'
    : (ctx.config.interimMessages ? 'interim（合并卡片）' : 'instant（逐条即时）') + '（全局配置）'
  const agentState = chat !== undefined
    ? 'busy=' + chat.busy + ' loopBuffer=' + chat.loopBuffer.length
    : '（未建立会话）'
  await ctx.sendToChat(chatId,
    'chat    : ' + chatId + '\n' +
    'session : ' + (sessionId ?? '（未建立会话）') + '\n' +
    'preset  : ' + preset + '\n' +
    'model   : ' + model + '\n' +
    'cwd     : ' + cwd + ' ' + wsSuffix + '\n' +
    '出站     : ' + modeLabel + '\n' +
    'agent   : ' + agentState)
}

/** /mode: per-chat outbound-mode override (interim vs instant). */
async function handleModeCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void> {
  const v = arg.trim().toLowerCase()
  if (v === '' || v === 'status' || v === 'view') {
    const interim = ctx.interimOverride(chatId)
    const eff = interim ?? ctx.config.interimMessages
    const suffix = interim !== undefined ? '（/mode 覆盖）' : '（全局配置）'
    await ctx.sendToChat(chatId, `当前出站模式：${eff ? 'interim（合并卡片）' : 'instant（逐条即时）'}${suffix}\n用法：/mode interim|instant 切换；/mode 查看`)
    return
  }
  if (v === 'interim' || v === 'on' || v === 'merge') {
    ctx.setInterimOverride(chatId, true)
    await ctx.sendToChat(chatId, '✅ 出站模式已切换为 interim（合并卡片）。下一条回复生效。')
    return
  }
  if (v === 'instant' || v === 'off' || v === 'direct') {
    ctx.setInterimOverride(chatId, false)
    await ctx.sendToChat(chatId, '✅ 出站模式已切换为 instant（逐条即时）。下一条回复生效。')
    return
  }
  await ctx.sendToChat(chatId, '用法：/mode interim|instant 切换；/mode 查看当前')
}

/** /retry: re-feed the last user message into the agent. */
async function handleRetryCommand(ctx: CommandContext, chatId: ChatId): Promise<void> {
  const chat = ctx.getChat(chatId)
  if (chat === undefined) {
    await ctx.sendToChat(chatId, '没有可重试的上一条消息。')
    return
  }
  if (chat.busy) {
    await ctx.sendToChat(chatId, '当前正在生成，请稍后再重试。')
    return
  }
  const text = chat.lastFollowup
  if (text === undefined || text === '') {
    await ctx.sendToChat(chatId, '没有可重试的上一条消息。')
    return
  }
  // Start a fresh reply cycle exactly like a new inbound turn.
  chat.loopBuffer = []
  chat.loopPending = null
  ctx.log('info', 'retry for ' + chatId)
  // /retry is admin-gated in tryHandleCommand, so the retried turn's role is
  // the admin who issued the command (M1-A2).
  await ctx.dispatchFollowup(chatId, text, 'admin', chat.lastNickname)
}

/** /ocr: OCR the most recent inbound image via NapCat's ocr_image. */
async function handleOcrCommand(ctx: CommandContext, chatId: ChatId): Promise<void> {
  // C6a: the command routed before media parsing — resolve the registered
  // pending image ref now (downloads on first use, records the last-image
  // path exactly like the normal path).
  const pending = ctx.takePendingImageRef(chatId)
  if (pending !== undefined) {
    await ctx.resolveMediaRef(pending, chatId)
  }
  const path = ctx.lastImagePath(chatId)
  if (path === undefined || path === '') {
    await ctx.sendToChat(chatId, '请先在对话里发一张图片，再 /ocr。')
    return
  }
  let b64: string
  try {
    b64 = await fileToBase64(path, ctx.config.maxImageBytes)
  } catch (error) {
    ctx.log('warn', 'ocr image read failed: ' + String(error))
    await ctx.sendToChat(chatId, `❌ 读取图片失败：${describeError(error)}`)
    return
  }
  let lines: string
  try {
    const data = await ctx.connection.call('ocr_image', { image: 'base64://' + b64 }) as { texts?: Array<{ text?: string }> }
    const texts = Array.isArray(data.texts) ? data.texts.map(t => t.text ?? '').filter(t => t !== '') : []
    lines = texts.join('\n')
  } catch (error) {
    ctx.log('warn', 'ocr_image failed: ' + String(error))
    await ctx.sendToChat(chatId, `❌ OCR 失败：${describeError(error)}`)
    return
  }
  if (lines.trim() === '') {
    await ctx.sendToChat(chatId, 'OCR 未识别到文本。')
    return
  }
  await ctx.sendToChat(chatId, 'OCR 结果：\n' + lines)
}

/** /preset: show available agent presets and the current one, or switch. */
async function handlePresetCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void> {
  const listed = await listPresets(ctx)
  if (arg.trim() === '') {
    const current = ctx.presetOverride(chatId)
      ?? await ctx.resolvePresetId(chatId)
      ?? ctx.agentPresets?.defaultId
    let out = '当前预设：' + (current ?? '（未记录）') + (ctx.hasPresetOverride(chatId) ? '（/preset 覆盖）' : '')
    if (listed.length > 0) out += '\n可用预设：\n' + listed.join('\n')
    out += '\n用法：/preset <id> 切换（重建会话）；/preset 查看'
    await ctx.sendToChat(chatId, out)
    return
  }
  const id = arg.trim()
  if (ctx.agentPresets === undefined) {
    await ctx.sendToChat(chatId, '❌ 当前宿主未提供 agentPresets 服务。')
    return
  }
  let resolvedId: string
  try {
    const preset = await ctx.agentPresets.resolve(id)
    resolvedId = preset.id
  } catch (error) {
    ctx.log('debug', 'preset resolve failed: ' + String(error))
    await ctx.sendToChat(chatId, '❌ 预设不存在：' + id + (listed.length > 0 ? '\n可用：' + listed.join(', ') : ''))
    return
  }
  ctx.setPresetOverride(chatId, resolvedId)
  if (ctx.hasChat(chatId)) {
    await ctx.resetChat(chatId)
  }
  ctx.log('info', 'preset switch for ' + chatId + ' -> ' + resolvedId)
  await ctx.sendToChat(chatId, `✅ 预设已切换：${resolvedId}\n下一条消息将重建会话并按新预设运行。`)
}

/** /plan: forward to the HOST plan command so QQ enters/leaves host plan
 * mode (the host `/plan off` path exits directly, no Web review card). The
 * plugin no longer runs its own prefix plan mode — that duplicated the host
 * semantic and shadowed the host `/plan off` exit. */
async function handlePlanCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void> {
  const chat = ctx.getChat(chatId)
  if (chat === undefined) {
    await ctx.sendToChat(chatId, '请先发一条消息建立会话，再 /plan。')
    return
  }
  const commands = ctx.commands
  if (commands === undefined) {
    await ctx.sendToChat(chatId, '❌ 宿主未提供 commands 服务，无法切换计划模式。')
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
    await ctx.sendToChat(chatId, text + hint)
    ctx.log('info', 'host plan command for ' + chatId + ': ' + line)
  } catch (error) {
    ctx.log('warn', 'host plan command failed: ' + String(error))
    await ctx.sendToChat(chatId, '❌ 计划模式切换失败：' + describeError(error))
  }
}

/** /goal: per-chat objective — recorded and reminded on each turn. */
async function handleGoalCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void> {
  const v = arg.trim()
  if (v === '') {
    const goal = ctx.goal(chatId)
    await ctx.sendToChat(chatId, '当前目标：' + (goal !== undefined && goal !== '' ? '\n' + goal : '（未设置）') + '\n用法：/goal <目标> 设置/更新；/goal clear 清除')
    return
  }
  if (v.toLowerCase() === 'clear' || v === '删除' || v === '移除') {
    ctx.deleteGoal(chatId)
    await ctx.sendToChat(chatId, '✅ 目标已清除。')
    return
  }
  ctx.setGoal(chatId, v)
  await ctx.sendToChat(chatId, '✅ 目标已记录（每轮自动附带提醒）：\n' + v)
}

/** Current default model selection, best-effort (absent services return undefined). */
function safeDefaultModel(ctx: CommandContext): ModelSelection | undefined {
  try {
    return ctx.agentDefaultModel?.currentSelection()
  } catch (error) {
    ctx.log('debug', 'currentSelection failed: ' + String(error))
    return undefined
  }
}

/** Enumerate the on-disk agent presets (<dsh-home>/.agent-presets/*). */
async function listPresets(ctx: CommandContext): Promise<string[]> {
  const home = ctx.dshHome
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
    ctx.log('debug', 'preset enumeration failed: ' + String(error))
    return []
  }
}

/** Plugin version from package.json, read once (per process). */
let cachedPluginVersion: string | undefined
function packageVersion(): string | undefined {
  if (cachedPluginVersion === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(join(dirname(__dirname), 'package.json'), 'utf8')) as { version?: string }
      cachedPluginVersion = typeof pkg.version === 'string' ? pkg.version : undefined
    } catch {
      cachedPluginVersion = undefined
    }
  }
  return cachedPluginVersion
}

/** Git short commit of the plugin repo, read once (best-effort, per process). */
let cachedGitCommit: string | undefined
function gitCommit(): string | undefined {
  if (cachedGitCommit === undefined) {
    try {
      const root = dirname(__dirname)
      const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      cachedGitCommit = commit !== '' ? commit : undefined
    } catch {
      cachedGitCommit = undefined
    }
  }
  return cachedGitCommit
}
