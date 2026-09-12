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
import type { BridgeDeps, WorkspaceRegistryLike } from './bridge.js'
import { MediaStore, IMAGE_MAX_BYTES, VOICE_MAX_BYTES, MEDIA_MAX_BYTES } from './media.js'
import { Transcriber } from './stt.js'
import type { AccessPolicyConfig } from './chat.js'
import { describeError } from './errors.js'

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
  commands: {
    execute(agent: unknown, line: string, signal: AbortSignal): Promise<{ kind?: string; text?: string }>
  }
}

export const name = 'dsh-onebot'
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions', 'agentDefaultModel', 'agentPresets', 'sessionPersistence', 'workspaceRegistry', 'commands', 'llm']

/** Plugin configuration (validated by schemastery). */
export interface Config {
  mode: 'reverse' | 'forward'
  host: string
  port: number
  url: string
  accessToken: string
  /** Forward-mode reconnect attempt limit; 0 = retry forever. */
  reconnectMaxAttempts: number
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
  /** Per-interim auto-recall delay (ms) from each interim's send completion. */
  interimRecallMs: number
  /** M3-D2b: interim recall degrade switch (false = send-only interims). */
  interimRecall: boolean
  sendErrorNotice: boolean
  /** Per-chat per-minute sliding-window cap for normal (non-command) messages; 0 disables. */
  rateLimitPerMinute: number
  restrictedMemberPrefix: boolean
  sensitivePatterns: string[]
  mediaDir: string
  tempTtlHours: number
  outboundImageMaxBytes: number
  maxVoiceBytes: number
  maxFileBytes: number
  inboundImageMaxPx: number
  /** @deprecated D4a alias of inboundImageMaxPx; honored for one release. */
  imageMaxSize?: number
  /** @deprecated D4a alias of outboundImageMaxBytes; honored for one release. */
  maxImageBytes?: number
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
  inboundFileMaxBytes: number
  /** @deprecated D4a alias of inboundFileMaxBytes; honored for one release. */
  maxInboundFileBytes?: number
  /** B8c: chats idle longer than this many days are evicted (0 disables). */
  chatIdleEvictDays: number
  /** Escape hatch: skip the download private-address check (local reverse proxy). */
  allowPrivateHosts: boolean
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

/** D4a: schema defaults for the renamed fields (referenced by the deprecated-name fallback). */
const INBOUND_IMAGE_MAX_PX = 2048
const OUTBOUND_IMAGE_MAX_BYTES = IMAGE_MAX_BYTES
const INBOUND_FILE_MAX_BYTES = 20 * 1024 * 1024

export const Config: z<Config> = z.object({
  mode: z.union([z.const('reverse'), z.const('forward')]).default('reverse')
    .description('连接模式：reverse = NapCat ws-reverse 拨入（本插件监听端口）；forward = 本插件主动连接 NapCat 的 ws 服务'),
  host: z.string().default('127.0.0.1')
    .description('reverse 模式监听地址；跨机部署（NapCat 从其他机器拨入）需显式改为 0.0.0.0'),
  port: z.number().default(8643)
    .description('reverse 模式监听端口'),
  url: z.string().default('ws://127.0.0.1:3001')
    .description('forward 模式的 NapCat ws 地址'),
  accessToken: z.string().role('secret').default('')
    .description('OneBot access_token（reverse 校验 / forward 发送 Authorization: Bearer）'),
  reconnectMaxAttempts: z.number().default(100)
    .description('forward 模式重连上限：连续失败达到该次数后放弃重连并打印恢复指引；0 = 无限重试（退避间隔封顶 60s）'),
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
    .description('是否把模型每步（含工具调用之间的中间回复）的文本立即发出；false 则只发最终回复。true 时：中间消息实时可见、每条在 interimRecallMs 后自动单独撤回、回合结束先发一张整轮 t2i 小结卡再发最终回复'),
  interimRecallMs: z.number().default(90_000)
    .description('中间消息各自发送完成后多久自动单独撤回（毫秒；QQ 撤回时限约 2 分钟，建议 ≤110000）'),
  interimRecall: z.boolean().default(true)
    .description('中间消息撤回开关：true（默认）=每条中间消息在 interimRecallMs 后自动撤回，回合结束先发整轮 t2i 小结卡再立即撤回原消息；false=只发不撤——中间消息照常实时发出但保留在聊天里：不排自动撤回定时器、回合结束不发小结卡也不撤回原消息，只发最终回复'),
  sendErrorNotice: z.boolean().default(true)
    .description('一轮运行出错时向用户发送 ⚠️ 错误提示'),
  rateLimitPerMinute: z.number().default(30)
    .description('每 chat 每分钟允许的普通消息条数上限（60 秒滑动窗口）；命令消息不计入也不受限；超限时每窗口最多提示一次；0=禁用频控'),
  restrictedMemberPrefix: z.boolean().default(true)
    .description('群聊非管理员消息注入 [受限用户:仅问答] 前缀（软限制）'),
  sensitivePatterns: z.array(z.string()).default([])
    .description('出站敏感内容审计正则（默认内置 rm -rf/关机/删库/密钥 等模式；留空用默认）'),
  mediaDir: z.string().default('')
    .description('入站媒体与映射文件目录；留空默认 <dsh-home>/media/onebot'),
  tempTtlHours: z.number().default(6)
    .description('入站临时媒体文件保留时长（小时），到期自动清理'),
  outboundImageMaxBytes: z.number().default(OUTBOUND_IMAGE_MAX_BYTES)
    .description('出站图片大小上限（字节）'),
  maxImageBytes: z.number().deprecated()
    .description('[deprecated] 旧名别名（现 outboundImageMaxBytes）：出站图片大小上限（字节）；本版兼容读取，新配置请用新名'),
  inboundImageMaxPx: z.number().default(INBOUND_IMAGE_MAX_PX)
    .description('入站图片长边上限（像素）；超过则等比压缩后交给视觉模型，<=0 禁用'),
  imageMaxSize: z.number().deprecated()
    .description('[deprecated] 旧名别名（现 inboundImageMaxPx）：入站图片长边上限（像素）；本版兼容读取，新配置请用新名'),
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
  sttTimeoutMs: z.number().default(60_000)
    .description('单次转写超时（毫秒，默认 60000）；超时后占位即终态，不追加转写'),
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
  inboundFileMaxBytes: z.number().default(INBOUND_FILE_MAX_BYTES)
    .description('QQ 入站文件最大字节数（直链/base64 拉取，0 = 不限制）'),
  maxInboundFileBytes: z.number().deprecated()
    .description('[deprecated] 旧名别名（现 inboundFileMaxBytes）：QQ 入站文件最大字节数；本版兼容读取，新配置请用新名'),
  allowPrivateHosts: z.boolean().default(false)
    .description('下载 SSRF 防护逃生门：默认拒绝解析到私网/环回/链路本地地址的下载目标（协议仅 http/https、重定向逐跳复检仍生效）；NapCat 文件服务器或反代部署在本机/内网时置 true 跳过私网检查'),
  chatIdleEvictDays: z.number().default(7)
    .description('会话空闲淘汰天数：chat 超过该天数无任何活动时，在下一条入站消息处理前清理其 agent（会话先落盘 flush、映射保留，之后同一 chat 的消息可 resume 恢复原会话）；0 = 禁用'),
})

/** D4a: the deprecated config names kept for one release, mapped onto their
 * renamed fields. */
const DEPRECATED_CONFIG_ALIASES: ReadonlyArray<readonly [oldName: string, newName: string, defaultValue: number]> = [
  ['imageMaxSize', 'inboundImageMaxPx', INBOUND_IMAGE_MAX_PX],
  ['maxImageBytes', 'outboundImageMaxBytes', OUTBOUND_IMAGE_MAX_BYTES],
  ['maxInboundFileBytes', 'inboundFileMaxBytes', INBOUND_FILE_MAX_BYTES],
]

/** Map deprecated config names onto their renamed fields: a legacy value is
 * honored only while the new name still sits at its schema default (the new
 * name wins when both are configured), each legacy use warns once, and the
 * legacy keys never leak into the effective config. */
export function resolveDeprecatedConfig(config: Config): Config {
  const resolved = { ...config } as Config & Record<string, unknown>
  for (const [oldName, newName, defaultValue] of DEPRECATED_CONFIG_ALIASES) {
    const legacy = resolved[oldName]
    if (legacy === undefined) continue
    console.warn('[dsh-onebot] config "' + oldName + '" is deprecated; rename it to "' + newName + '"')
    delete resolved[oldName]
    if (resolved[newName] === defaultValue) resolved[newName] = legacy
  }
  return resolved
}

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

/** Log a meta event; periodic heartbeat events are silenced to keep the log readable. */
export function logMetaEvent(selfId: string, event: OneBotEvent): void {
  const metaType = typeof event.meta_event_type === 'string' ? event.meta_event_type : ''
  if (metaType === 'heartbeat') return
  console.log('[dsh-onebot] meta event; bot QQ: ' + selfId + '; ' + metaType)
}

/** Mount the plugin. */
export function apply(ctx: Context, config: Config): void {
  // D4a: honor the deprecated config names before any consumer reads them.
  config = resolveDeprecatedConfig(config)
  const mediaDir = config.mediaDir !== '' ? config.mediaDir : defaultMediaDir()
  const policy = resolvePolicy(config)
  /** Console log line callback (level, message) — shared by the bridge deps,
   * the connection log port and the host-ready boot gate below (M2-C5b). */
  const log = (level: 'info' | 'warn' | 'error' | 'debug', message: string): void => {
    const prefix = '[dsh-onebot] '
    if (level === 'error') console.error(prefix + message)
    else if (level === 'warn') console.warn(prefix + message)
    else console.log(prefix + message)
  }
  const connection = new OneBotConnection(
    {
      mode: config.mode,
      host: config.host,
      port: config.port,
      url: config.url,
      accessToken: config.accessToken,
      reconnectMaxAttempts: config.reconnectMaxAttempts,
      callTimeoutMs: 30_000,
      log,
    },
  )
  const media = new MediaStore(mediaDir, config.tempTtlHours, config.inboundImageMaxPx, { maxBytes: config.inboundFileMaxBytes, allowPrivateHosts: config.allowPrivateHosts })
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
    logMetaEvent(connection.selfId, event)
  }
  const bridge = new ChatBridge({
    ctx,
    // M2-C5b: the bridge sees only explicit ports — the session-event feed
    // (this context's own `on`) and the two injectables below; the 'loader'
    // service lookup lives here, not in the bridge.
    hostReady: async () => {
      try {
        const loader = ctx.get('loader') as { await(): Promise<void> } | undefined
        await loader?.await()
      } catch (error) {
        log('debug', 'loader.await failed: ' + describeError(error))
      }
    },
    // Live llm lookup per call — same semantics as the pre-port live getter.
    llmCatalog: {
      listProviders: () => ctx.llm.listProviders(),
      listModels: provider => ctx.llm.listModels(provider),
    },
    connection,
    dshHome: dshHome(),
    media,
    transcriber,
    agents: ctx.agents,
    sessions: ctx.sessions,
    agentPresets: ctx.agentPresets,
    commands: ctx.commands as BridgeDeps['commands'],
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
      interimRecallMs: config.interimRecallMs,
      interimRecall: config.interimRecall,
      sendErrorNotice: config.sendErrorNotice,
      rateLimitPerMinute: config.rateLimitPerMinute,
      restrictedMemberPrefix: config.restrictedMemberPrefix,
      sensitivePatterns: config.sensitivePatterns,
      mediaDir,
      maxImageBytes: config.outboundImageMaxBytes,
      maxVoiceBytes: config.maxVoiceBytes,
      maxFileBytes: config.maxFileBytes,
      textImageThreshold: config.textImageThreshold,
      cardFooter: config.cardFooter,
      fontFiles: config.fontFiles,
      fontFamilies: config.fontFamilies,
      agentPreset: config.agentPreset,
      workspacePath: config.workspacePath,
      maxInboundFileBytes: config.inboundFileMaxBytes,
      chatIdleEvictDays: config.chatIdleEvictDays,
    },
    policy,
    log,
  })

  // Lifecycle: start the bridge and transport; unwind everything on unload.
  ctx.effect(() => {
    bridge.start()
    connection.start()
    // QQ 平台说明与 qq_* 工具现按会话 agent 注入（见 ChatBridge.installChannelScope）
    return async () => {
      await bridge.stop()
      await connection.stop()
    }
  }, 'dsh-onebot.lifecycle')

  console.log('[dsh-onebot] mounted (mode=' + config.mode + ', media=' + mediaDir + ', admins=' + policy.adminUsers.length + ')')
}
