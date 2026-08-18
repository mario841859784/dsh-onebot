/**
 * dsh-onebot: a QQ (OneBot 11 / NapCat) chat channel for DeepSeek Harness.
 *
 * Mounts inside the dsh host process: a reverse- or forward-WebSocket link to
 * NapCat, one Agent per QQ chat, inbound images/voice handled for the model
 * (whisper STT when enabled), outbound replies split at sentence boundaries,
 * [[qq_forward]] merged forwards, allowlist/mention access control, and a set
 * of qq_* tools for media and NapCat APIs.
 * @module dsh-onebot
 */

import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type ToolRuntime from '@deepseek-ai/dsh-tools'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'

import { OneBotConnection } from './connection.js'
import type { OneBotEvent } from './connection.js'
import { ChatBridge } from './bridge.js'
import type { WorkspaceRegistryLike } from './bridge.js'
import { MediaStore, IMAGE_MAX_BYTES, VOICE_MAX_BYTES, MEDIA_MAX_BYTES } from './media.js'
import { Transcriber } from './stt.js'
import { registerTools } from './tools.js'
import { buildPlatformPrompt } from './prompt.js'
import type { AccessPolicyConfig } from './chat.js'

type Context = CordisContext & {
  tools: ToolRuntime
  systemPrompt: SystemPrompt
  agents: AgentRegistry
  sessions: SessionStore
  agentDefaultModel: { currentSelection(): ModelSelection | undefined; saveSelection(next: ModelSelection): Promise<void> }
  agentPresets: {
    readonly defaultId: string
    resolve(id?: string): Promise<{ id: string }>
    mount(agentCtx: unknown, id?: string): Promise<{ id: string }>
  }
  sessionPersistence: {
    inspect(id: string): Promise<{
      meta: { agentPreset?: string; cwd?: string }
      events: readonly { type?: string; data?: { agentPreset?: string } }[]
    }>
  }
  workspaceRegistry: {
    resolveByPath(path: string): Promise<{ id: string; path: string; sessionIds: readonly string[]; attachSession(sessionId: string): Promise<void> } | undefined>
    create(path: string, title?: string): Promise<{ id: string; path: string; sessionIds: readonly string[]; attachSession(sessionId: string): Promise<void> }>
    list(): Array<{ id: string; path: string; sessionIds: readonly string[] }>
  }
}

export const name = 'dsh-onebot'
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions', 'agentDefaultModel', 'agentPresets', 'sessionPersistence', 'workspaceRegistry']

/** Plugin configuration (validated by schemastery). */
export interface Config {
  mode: 'reverse' | 'forward'
  host: string
  port: number
  url: string
  accessToken: string
  botQQ: string
  splitLength: number
  requireMention: boolean
  dmPolicy: 'open' | 'allowlist' | 'disabled'
  groupPolicy: 'open' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groupAllowFrom: string[]
  adminUsers: string[]
  allowAllUsers: boolean
  ignoreSelf: boolean
  interimMessages: boolean
  sendErrorNotice: boolean
  restrictedMemberPrefix: boolean
  sensitivePatterns: string[]
  mediaDir: string
  tempTtlHours: number
  maxImageBytes: number
  maxVoiceBytes: number
  maxFileBytes: number
  imageMaxSize: number
  sttEnabled: boolean
  sttEngine: 'auto' | 'openai' | 'whisper-cpp' | 'custom'
  sttCommand: string
  sttArgs: string[]
  sttModel: string
  sttTimeoutMs: number
  textImageThreshold: number
  cardFooter: string
  fontFiles: string[]
  fontFamilies: string[]
  agentPreset: string
  workspacePath: string
  maxInboundFileBytes: number
  /** Editable root for the guarded code_safe_edit tools (empty = disabled). */
  safeEditRoot: string
  /** Backup dir for code_safe_edit (empty = <safeEditRoot>/.backups). */
  backupDir: string
}

const ENV = (name: string): string => process.env[name] ?? ''

/** Default media dir: <dsh-home>/media/onebot (dsh-home = $DSH_HOME or ~/.dsh). */
export function defaultMediaDir(): string {
  const home = ENV('DSH_HOME') !== '' ? ENV('DSH_HOME') : join(process.env.HOME ?? '/tmp', '.dsh')
  return join(home, 'media', 'onebot')
}

/** The dsh data home ($DSH_HOME or ~/.dsh); source of the .agent-presets dir. */
export function dshHome(): string {
  return ENV('DSH_HOME') !== '' ? ENV('DSH_HOME') : join(process.env.HOME ?? '/tmp', '.dsh')
}

export const Config: z<Config> = z.object({
  mode: z.union([z.const('reverse'), z.const('forward')]).default('reverse')
    .description('连接模式：reverse = NapCat ws-reverse 拨入（本插件监听端口）；forward = 本插件主动连接 NapCat 的 ws 服务'),
  host: z.string().default('0.0.0.0')
    .description('reverse 模式监听地址'),
  port: z.number().default(8643)
    .description('reverse 模式监听端口'),
  url: z.string().default('ws://127.0.0.1:3001')
    .description('forward 模式的 NapCat ws 地址'),
  accessToken: z.string().role('secret').default('')
    .description('OneBot access_token（reverse 校验 / forward 发送 Authorization: Bearer）'),
  botQQ: z.string().default('')
    .description('机器人自身 QQ 号；留空则从 meta 事件自动学习'),
  splitLength: z.number().default(100)
    .description('长回复分段长度（按句号等标点切分）'),
  requireMention: z.boolean().default(true)
    .description('群聊是否仅在 @机器人（或回复其消息）时响应'),
  dmPolicy: z.union([z.const('open'), z.const('allowlist'), z.const('disabled')]).default('open')
    .description('私聊策略：open=仅管理员；allowlist=仅 allowFrom；disabled=拒绝所有私聊'),
  groupPolicy: z.union([z.const('open'), z.const('allowlist'), z.const('disabled')]).default('open')
    .description('群聊策略：open=所有群；allowlist=仅 groupAllowFrom；disabled=拒绝所有群'),
  allowFrom: z.array(z.string()).default([])
    .description('dmPolicy=allowlist 时允许私聊的 QQ 号'),
  groupAllowFrom: z.array(z.string()).default([])
    .description('groupPolicy=allowlist 时允许的群号'),
  adminUsers: z.array(z.string()).default([])
    .description('管理员 QQ 号（也可用环境变量 ONEBOT_ALLOWED_USERS 逗号分隔指定）'),
  allowAllUsers: z.boolean().default(false)
    .description('放行所有用户（仅开发用；也可用 ONEBOT_ALLOW_ALL_USERS=true）'),
  ignoreSelf: z.boolean().default(true)
    .description('忽略机器人自己发出的消息（防自循环）'),
  interimMessages: z.boolean().default(true)
    .description('是否把模型每步（含工具调用之间的中间回复）的文本立即发出；false 则只发最终回复'),
  sendErrorNotice: z.boolean().default(true)
    .description('一轮运行出错时向用户发送 ⚠️ 错误提示'),
  restrictedMemberPrefix: z.boolean().default(true)
    .description('群聊非管理员消息注入 [受限用户:仅问答] 前缀（软限制）'),
  sensitivePatterns: z.array(z.string()).default([])
    .description('出站敏感内容审计正则（默认内置 rm -rf/关机/删库/密钥 等模式；留空用默认）'),
  mediaDir: z.string().default('')
    .description('入站媒体与映射文件目录；留空默认 <dsh-home>/media/onebot'),
  tempTtlHours: z.number().default(6)
    .description('入站临时媒体文件保留时长（小时），到期自动清理'),
  maxImageBytes: z.number().default(IMAGE_MAX_BYTES)
    .description('出站图片大小上限（字节）'),
  imageMaxSize: z.number().default(2048)
    .description('入站图片长边上限（像素）；超过则等比压缩后交给视觉模型，<=0 禁用'),
  maxVoiceBytes: z.number().default(VOICE_MAX_BYTES)
    .description('出站语音大小上限（字节）'),
  maxFileBytes: z.number().default(MEDIA_MAX_BYTES)
    .description('出站视频/文件大小上限（字节）'),
  sttEnabled: z.boolean().default(true)
    .description('入站语音是否转写（需要 ffmpeg 和 whisper CLI；失败时降级为 [语音] 占位）'),
  sttEngine: z.union([z.const('auto'), z.const('openai'), z.const('whisper-cpp'), z.const('custom')]).default('auto')
    .description('STT 引擎：auto 自动探测 whisper-cli / whisper / mlx_whisper'),
  sttCommand: z.string().default('')
    .description('custom 引擎的程序名/路径'),
  sttArgs: z.array(z.string()).default([])
    .description('custom 引擎参数模板，{file} 与 {out} 会被替换'),
  sttModel: z.string().default('small')
    .description('whisper 模型（openai: small/base/medium...；whisper.cpp: 模型名或 .bin 绝对路径）'),
  sttTimeoutMs: z.number().default(300_000)
    .description('单次转写超时（毫秒）'),
  textImageThreshold: z.number().default(150)
    .description('回复正文超过该长度（字符数）时渲染为文字图卡片发送；<=0 禁用卡片路径'),
  cardFooter: z.string().default('dsh')
    .description('文字图卡片页脚品牌文字（"Powered by <brand>"）'),
  fontFiles: z.array(z.string()).default([])
    .description('t2i 渲染器注册的字体文件路径（Linux/自定义字体；macOS 自动用系统字体）'),
  fontFamilies: z.array(z.string()).default([])
    .description('t2i 渲染器优先使用的字体家族名（覆盖平台默认）'),
  agentPreset: z.string().default('')
    .description('QQ 会话加入的 agent 预设 id；留空用部署默认（settings 的 agent-presets.default，当前为 router-flash）。创建时总是解析有效预设并写入会话 header，Web 界面可见；resume 优先恢复会话自己记录的预设'),
  workspacePath: z.string().default('')
    .description('QQ 会话的工作区目录（写入会话 cwd，并自动归入该工作区，不存在则创建）；留空用宿主进程 cwd'),
  maxInboundFileBytes: z.number().default(20 * 1024 * 1024)
    .description('QQ 入站文件最大字节数（直链/base64 拉取，0 = 不限制）'),
  safeEditRoot: z.string().default('')
    .description('受守卫的文件编辑工具（code_safe_edit/code_safe_rollback/code_list_backups）的可编辑根目录；留空 = 禁用整个工具组。QQ 渠道仅管理员可用，其他渠道默认可用（A1）'),
  backupDir: z.string().default('')
    .description('code_safe_edit 备份目录；留空默认 <safeEditRoot>/.backups'),
})

/** Resolve env-var fallbacks into the effective access policy. */
function resolvePolicy(config: Config): AccessPolicyConfig {
  const envAdmins = ENV('ONEBOT_ALLOWED_USERS')
    .split(',')
    .map(v => v.trim())
    .filter(v => v !== '')
  const adminUsers = [...new Set([...config.adminUsers, ...envAdmins])]
  return {
    dmPolicy: config.dmPolicy,
    groupPolicy: config.groupPolicy,
    allowFrom: config.allowFrom,
    groupAllowFrom: config.groupAllowFrom,
    adminUsers,
    allowAllUsers: config.allowAllUsers || ENV('ONEBOT_ALLOW_ALL_USERS').toLowerCase() === 'true',
    requireMention: config.requireMention,
  }
}

/** Mount the plugin. */
export function apply(ctx: Context, config: Config): void {
  const mediaDir = config.mediaDir !== '' ? config.mediaDir : defaultMediaDir()
  const policy = resolvePolicy(config)
  const connection = new OneBotConnection(
    {
      mode: config.mode,
      host: config.host,
      port: config.port,
      url: config.url,
      accessToken: config.accessToken,
      callTimeoutMs: 30_000,
    },
  )
  const media = new MediaStore(mediaDir, config.tempTtlHours, config.imageMaxSize)
  const transcriber = new Transcriber({
    enabled: config.sttEnabled,
    engine: config.sttEngine,
    command: config.sttCommand,
    args: config.sttArgs,
    model: config.sttModel,
    timeoutMs: config.sttTimeoutMs,
  })
  connection.onMessage = (event: OneBotEvent) => {
    void bridge.handleInbound(event)
  }
  connection.onMeta = (event: OneBotEvent) => {
    console.log('[dsh-onebot] meta event; bot QQ: ' + connection.selfId + '; ' + (event.meta_event_type ?? ''))
  }
  const bridge = new ChatBridge({
    ctx,
    connection,
    dshHome: dshHome(),
    media,
    transcriber,
    agents: ctx.agents,
    sessions: ctx.sessions,
    agentPresets: ctx.agentPresets,
    sessionPersistence: ctx.sessionPersistence,
    workspaceRegistry: ctx.workspaceRegistry as unknown as WorkspaceRegistryLike,
    agentDefaultModel: ctx.agentDefaultModel,
    defaultModel: () => {
      try {
        return ctx.agentDefaultModel.currentSelection()
      } catch {
        return undefined
      }
    },
    config: {
      botQQ: config.botQQ,
      ignoreSelf: config.ignoreSelf,
      splitLength: config.splitLength,
      requireMention: config.requireMention,
      interimMessages: config.interimMessages,
      sendErrorNotice: config.sendErrorNotice,
      restrictedMemberPrefix: config.restrictedMemberPrefix,
      sensitivePatterns: config.sensitivePatterns,
      mediaDir,
      maxImageBytes: config.maxImageBytes,
      maxVoiceBytes: config.maxVoiceBytes,
      maxFileBytes: config.maxFileBytes,
      textImageThreshold: config.textImageThreshold,
      cardFooter: config.cardFooter,
      fontFiles: config.fontFiles,
      fontFamilies: config.fontFamilies,
      agentPreset: config.agentPreset,
      workspacePath: config.workspacePath,
      maxInboundFileBytes: config.maxInboundFileBytes,
    },
    policy,
    log: (level, message) => {
      const prefix = '[dsh-onebot] '
      if (level === 'error') console.error(prefix + message)
      else if (level === 'warn') console.warn(prefix + message)
      else console.log(prefix + message)
    },
  })

  // Lifecycle: start the bridge and transport; unwind everything on unload.
  ctx.effect(() => {
    bridge.start()
    connection.start()
    const disposer = registerTools(ctx, bridge, connection, {
      maxImageBytes: config.maxImageBytes,
      maxVoiceBytes: config.maxVoiceBytes,
      maxFileBytes: config.maxFileBytes,
    }, {
      safeEditRoot: config.safeEditRoot,
      backupDir: config.backupDir,
    })
    ctx.systemPrompt.section({
      name: 'channel:dsh-onebot',
      order: 90,
      text: buildPlatformPrompt(config.restrictedMemberPrefix),
    })
    return async () => {
      disposer()
      await bridge.stop()
      await connection.stop()
    }
  }, 'dsh-onebot.lifecycle')

  console.log('[dsh-onebot] mounted (mode=' + config.mode + ', media=' + mediaDir + ', admins=' + policy.adminUsers.length + ')')
}
