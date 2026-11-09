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
import type Z from '@deepseek-ai/schemastery'
import type { OneBotEvent } from './connection.js'
import { createPokeHandler } from './poke.js'
import type { BridgeDeps, WorkspaceRegistryLike } from './bridge.js'
import type { AccessPolicyConfig } from './chat.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

// R1 部署加固：peer 依赖解析失败/关键模块缺失时必须显眼报错并 fail-loud，
// 不能静默不挂载。静态 import 会在本模块任何代码运行之前就以晦涩的
// ERR_MODULE_NOT_FOUND 失败（宿主侧表现为插件被静默跳过），因此运行时
// 值依赖改为入口顶部受控动态加载：失败时先输出含「peer/依赖」的显式
// 错误，再把原错误抛出。
let z: typeof import('@deepseek-ai/schemastery').default
let OneBotConnection: typeof import('./connection.js').OneBotConnection
let ChatBridge: typeof import('./bridge.js').ChatBridge
let MediaStore: typeof import('./media.js').MediaStore
let IMAGE_MAX_BYTES: number
let VOICE_MAX_BYTES: number
let MEDIA_MAX_BYTES: number
let Transcriber: typeof import('./stt.js').Transcriber
let TraceSink: typeof import('./trace.js').TraceSink
let InboundRecorder: typeof import('./record.js').InboundRecorder
let InjectChannel: typeof import('./inject.js').InjectChannel
let redactSnapshot: typeof import('./health.js').redactSnapshot
let describeError: typeof import('./errors.js').describeError
let configureSendSegments: typeof import('./tools.js').configureSendSegments
let resolveUserQuestions: typeof import('./ask-tool.js').resolveUserQuestions

try {
  ;({ default: z } = await import('@deepseek-ai/schemastery'))
  ;({ OneBotConnection } = await import('./connection.js'))
  ;({ ChatBridge } = await import('./bridge.js'))
  ;({ MediaStore, IMAGE_MAX_BYTES, VOICE_MAX_BYTES, MEDIA_MAX_BYTES } = await import('./media.js'))
  ;({ Transcriber } = await import('./stt.js'))
  ;({ TraceSink } = await import('./trace.js'))
  ;({ InboundRecorder } = await import('./record.js'))
  ;({ InjectChannel } = await import('./inject.js'))
  ;({ redactSnapshot } = await import('./health.js'))
  ;({ describeError } = await import('./errors.js'))
  ;({ configureSendSegments } = await import('./tools.js'))
  ;({ resolveUserQuestions } = await import('./ask-tool.js'))
} catch (error) {
  console.error('[dsh-onebot] 挂载失败：peer 依赖解析失败或关键模块缺失 —— 部署副本必须带完整 node_modules 链接集（scripts/link-host.sh 产物），只复制 lib/ 不够。原始错误：' + (error instanceof Error ? error.message : String(error)))
  throw error
}

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
    /** dsh-session-persistence 0.1.6 `stat`: the stored snapshot, or
     * undefined when the id owns no durable log (the retired `inspect`
     * convenience no longer exists on the host service). */
    stat(id: string): Promise<object | undefined>
    /** /session list previews: open a stored session read-only (never takes
     * write ownership), read the header + a small event prefix, then close. */
    open(id: string, access: 'read'): Promise<{
      header: { createdAt?: number; agentPreset?: string }
      read(offset?: number, length?: number): Promise<{ events: readonly { type?: string; data?: { agentPreset?: string; source?: { kind?: string }; content?: readonly { type?: string; text?: string }[] } }[] }>
      close(): Promise<void>
    }>
  }
  workspaceRegistry: {
    resolveByPath(path: string): Promise<{ id: string; path: string; sessionIds: readonly string[]; attachSession(sessionId: string): Promise<void> } | undefined>
    create(path: string, title?: string): Promise<{ id: string; path: string; sessionIds: readonly string[]; attachSession(sessionId: string): Promise<void> }>
    list(): Array<{ id: string; path: string; sessionIds: readonly string[] }>
  }
  commands: {
    execute(agent: unknown, line: string, submittedAttachments: readonly unknown[], signal: AbortSignal): Promise<{ kind?: string; text?: string; result?: { kind?: string; text?: string } }>
  }
  /** T2-B1/B3: the host userQuestions service (dsh-base registers it). Not in
   * the inject list on purpose — a deployment without it must degrade to "no
   * ask_user_question tool / no answer interception", never block the load. */
  userQuestions?: {
    askTimed(request: unknown, callId: string, timeoutMs: number): Promise<unknown>
    answer(agent: unknown, callId: string, payload: { answers: Array<{ id: string; selected: string[]; custom?: string }> }): Promise<boolean>
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
  requireMention: boolean
  /** T1 (PR port): 戳一戳唤醒开关；false = poke notice 一律忽略。 */
  pokeEnabled: boolean
  /** T1 (PR port): 引用即叫——群聊回复任意消息（不限机器人）也算 @机器人。 */
  replyCountsAsMention: boolean
  /** T1 (PR port): @全体即叫——群聊 @全体成员 也算 @机器人。 */
  atAllCountsAsMention: boolean
  /** T1 (PR port): 管理员唤醒词；群聊消息以任一词开头即视为 @机器人。 */
  wakeNamesAdmin: string[]
  /** T1 (PR port): 成员唤醒词；群聊消息以任一词开头即视为 @机器人。 */
  wakeNamesMember: string[]
  /** Unknown slash-command handling: intercept（默认）=拦截并给建议；passthrough=透传给模型。 */
  unknownCommand: 'intercept' | 'passthrough'
  /** T2 (P1): 任务运行中的新消息处理策略：queue=排队（默认）；steer=插话进当前任务。 */
  newMessagePolicy: 'queue' | 'steer'
  /** T9-B (用户裁决 2026-10-12)：steer 模式下自动插话资格：admin=仅管理员（默认）；all=不限。 */
  autoSteerPolicy: 'admin' | 'all'
  /** T3 (P2): 等待模型回复超时阈值（毫秒）——超时后登记补发跟踪、回合完成后向原聊天补发最终文字；0=关闭。 */
  deferredTimeoutMs: number
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
  /** T8/#27: auto-receipt notice switches — boolean, or a custom text string. */
  notices: { steerAccepted?: boolean | string, queue?: boolean | string, answerAccepted?: boolean | string, deferredTimeout?: boolean | string, rateLimited?: boolean | string }
  /** T14 (#6 补充): qq_send_segments 插件页开关与分段发送间隔（呼吸感）。 */
  segments: { enabled: boolean, intervalMs: number }
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
  monoFamilies: string[]
  agentPreset: string
  /** 权限分档 A3: 群聊粗档 preset——设置后群聊会话优先使用该 preset id；空串=现行为。 */
  agentPresetGroup: string
  /** 权限分档 A2: 成员档位工具权限（none=成员回合禁用全部 qq_* 工具，默认；all=不限）。 */
  permissions: { memberTools: 'none' | 'all' }
  workspacePath: string
  /** T3 (PR port 群工作区)：群聊会话的默认工作区目录；空串=现行为。 */
  groupWorkspacePath: string
  /** T3 (PR port 退休会话自动恢复)：退休会话自动重绑开关；false=默认关。 */
  sessionAutoRecover: boolean
  inboundFileMaxBytes: number
  /** @deprecated D4a alias of inboundFileMaxBytes; honored for one release. */
  maxInboundFileBytes?: number
  /** B8c: chats idle longer than this many days are evicted (0 disables). */
  chatIdleEvictDays: number
  /** Escape hatch: skip the download private-address check (local reverse proxy). */
  allowPrivateHosts: boolean
  /** Roots allowed for inbound file:// refs; empty rejects all. */
  fileRefRoots: string[]
  /** Optional CIDR allowlist for trusted private download targets. */
  allowCidrs: string[]
  /** W2-②: inbound (chatId, message_id) dedup window in seconds; 0 disables. */
  dedupWindowSeconds: number
  /** W2-③: bridge-wide proactive-write (qq_send_* tools) cap per minute; 0 disables. */
  actionRatePerMinute: number
  /** W2-③: bridge-wide proactive-write cap per calendar day; 0 disables. */
  actionRatePerDay: number
  /** W2-③: proactive-write audit jsonl (mediaDir/qq-actions.log). */
  actionAuditEnabled: boolean
  /** T2 (PR port): 出站防御总开关——复读/信封清洗、残留标记兜底与
   * [[at:QQ]] 拆段；默认 false（上游 0.9.19 原始行为）。 */
  outboundDefenseEnabled: boolean
  /** T2 (PR port): 纯括号旁白（如「（嗯……）」）静默丢弃；默认 false。 */
  asideOnlySilentEnabled: boolean
  /** W1: decision-trace jsonl (mediaDir/qq-trace.jsonl); default off — zero
   * file, zero behavior difference vs 0.6.0. */
  traceEnabled: boolean
  /** W1: trace level; 'warn' records only ok:false (rejected/failed/dropped) events. */
  traceLevel: 'debug' | 'warn'
  /** W1/T5: record every inbound event into mediaDir/qq-inbox.jsonl (default off). */
  recordInbound: boolean
  /** W1/T5: mask 6+ digit runs (QQ/group numbers) in the recording (default off). */
  inboxRedact: boolean
  /** W1/T5 (DEBUG-ONLY): enable the qq-inject.jsonl injection channel (default off). */
  injectEnabled: boolean
  /** W1/T5: intercept all outbound writes of injected rounds (default true). */
  injectDryRun: boolean
  /** W1/T5: inject queue poll interval in ms (min 500). */
  injectIntervalMs: number
  /** Console log gate: messages below this level are dropped (debug < info < warn < error). */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

const ENV = (name: string): string => process.env[name] ?? ''

/** Default media dir: <dsh-home>/media/onebot (dsh-home = $DSH_HOME or ~/.dsh). */
export function defaultMediaDir(): string {
  // os.homedir() reads $HOME first and falls back to the passwd entry — the
  // systemd service runs without HOME, so `?? '/tmp'` used to resolve to
  // /tmp/.dsh and preset enumeration hit ENOENT (web log line 14429).
  const home = ENV('DSH_HOME') !== '' ? ENV('DSH_HOME') : join(homedir() || '/tmp', '.dsh')
  return join(home, 'media', 'onebot')
}

/** The dsh data home ($DSH_HOME or ~/.dsh); source of the .agent-presets dir. */
export function dshHome(): string {
  return ENV('DSH_HOME') !== '' ? ENV('DSH_HOME') : join(homedir() || '/tmp', '.dsh')
}

/** D4a: schema defaults for the renamed fields (referenced by the deprecated-name fallback). */
const INBOUND_IMAGE_MAX_PX = 2048
const OUTBOUND_IMAGE_MAX_BYTES = IMAGE_MAX_BYTES
const INBOUND_FILE_MAX_BYTES = 20 * 1024 * 1024

export const Config: Z<Config> = z.object({
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
  requireMention: z.boolean().default(true)
    .description('群聊是否仅在 @机器人（或回复其消息）时响应'),
  pokeEnabled: z.boolean().default(true)
    .description('戳一戳唤醒（T1 PR port）：收到“戳一戳”notice 时转为伪消息唤醒机器人——私聊直接响应，群聊补 @机器人 段过 @ 门；仅响应戳机器人本人的戳一戳，同一发起者 3 秒内只响应一次；false=忽略全部戳一戳'),
  replyCountsAsMention: z.boolean().default(false)
    .description('引用即叫（T1 PR port）：群聊中回复任意消息（不限于机器人自己的消息）也算 @机器人并跳过引用作者核实；默认关闭=仅回复机器人的消息才唤醒'),
  atAllCountsAsMention: z.boolean().default(false)
    .description('@全体即叫（T1 PR port）：群聊中 @全体成员 也算 @机器人；默认关闭=@全体成员不唤醒机器人'),
  wakeNamesAdmin: z.array(z.string()).default([])
    .description('管理员唤醒词（T1 PR port）：群聊消息以任一唤醒词开头即视为 @机器人（仅对管理员生效）；留空=不启用'),
  wakeNamesMember: z.array(z.string()).default([])
    .description('成员唤醒词（T1 PR port）：群聊消息以任一唤醒词开头即视为 @机器人（仅对成员生效）；留空=不启用'),
  unknownCommand: z.union([z.const('intercept'), z.const('passthrough')]).default('intercept')
    .description('未知斜杠命令处理：intercept（默认）=拦截并提示相近命令或 /help；passthrough=透传给模型（旧行为）'),
  newMessagePolicy: z.union([z.const('queue'), z.const('steer')]).default('queue')
    .description('任务运行中的新消息处理策略（P1）：queue（默认）=排队——新消息在当前任务结束后按序处理为后续回合，等待期间至多提示一次；steer=插话——运行中收到的新普通纯文字消息作为补充指令加入当前任务（模型在下一步读取）并回复提交提示；图片/文件/语音/带引用消息与 [受限用户:仅问答] 消息两种模式下都按排队处理，/steer 命令两种模式下均可用'),
  autoSteerPolicy: z.union([z.const('admin'), z.const('all')]).default('admin')
    .description('steer 模式下自动插话的发送者资格（T9-B 用户裁决 2026-10-12）：admin（默认）=仅管理员可自动插话；all=所有非受限发送者均可。不具备资格的消息按排队处理；/steer 命令始终仅管理员、不受本项影响；queue 模式行为不变'),
  deferredTimeoutMs: z.number().default(600_000)
    .description('等待模型回复超时阈值（毫秒，T3/P2 超时补发）：回合超过该时长没有任何模型输出时提示超时并登记补发跟踪，任务完成后向原聊天自动补发最终文字（走既有出站管线）；发送明确失败最多尝试 3 次（退避），结果不确定时保留记录停止自动重试；/stop 终止该聊天的补发跟踪；0=关闭超时补发'),
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
  notices: z.object({
    // T1 (#27)：各键语义统一——false=不发；true/缺省=默认文案（0.9.x 行为不变）；
    // 非空 string=自定义文案；空串=不发。解析见 src/notices.ts resolveNoticeText。
    steerAccepted: z.union([z.boolean(), z.string()]).default(true)
      .description('steer 模式下补充指令受理后的自动回执文案：false=不发自动回执；true/缺省=默认文案；非空 string=自定义文案（/steer 命令确认同样改用，false 时不影响命令确认）；空串=不发'),
    queue: z.union([z.boolean(), z.string()]).default(true)
      .description('消息排队提示文案（每个运行回合至多一条）：false=不发；true/缺省=默认文案；非空 string=自定义文案；空串=不发'),
    answerAccepted: z.union([z.boolean(), z.string()]).default(true)
      .description('问题回答回执（✔ 已提交回答）文案：false=不发；true/缺省=默认文案；非空 string=自定义文案；空串=不发'),
    deferredTimeout: z.union([z.boolean(), z.string()]).default(true)
      .description('等待模型回复超时提示文案：false=不发；true/缺省=默认文案；非空 string=自定义文案；空串=不发'),
    rateLimited: z.union([z.boolean(), z.string()]).default(true)
      .description('消息太频繁频控提示文案（每窗口至多一条）：false=不发；true/缺省=默认文案；非空 string=自定义文案；空串=不发'),
  }).default({})
    .description('自动回执开关/自定义文案集合；缺省全部为默认文案开启（与 0.9.x 行为一致）'),
  segments: z.object({
    enabled: z.boolean().default(true)
      .description('qq_send_segments 分段发送工具开关（T14）：true（默认）=工具可用；false=工具下线（模型不可见，无法调用）'),
    intervalMs: z.number().min(0).max(3000).default(0)
      .description('分段消息相邻两段的发送间隔（毫秒，0–3000，默认 0 = 不等待）：逐条发送之间的间隔营造打字呼吸感；qq_send_segments 的 intervalMs 参数可按次临时覆盖（同样截断到 0–3000）'),
  }).default({})
    .description('qq_send_segments 分段发送配置（T14）；缺省 = 启用且无间隔（与 0.9.10 行为一致）'),
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
  monoFamilies: z.array(z.string()).default([])
    .description('t2i 渲染器代码文本优先使用的等宽字体家族名（优先于 fontFamilies 与平台默认，如 Cascadia Code / Consolas）'),
  agentPreset: z.string().default('')
    .description('QQ 会话加入的 agent 预设 id；留空用部署默认（settings 的 agent-presets.default，当前为 router-flash）。创建时总是解析有效预设并写入会话 header，Web 界面可见；resume 优先恢复会话自己记录的预设'),
  agentPresetGroup: z.string().default('')
    .description('权限分档：群聊会话的 agent 预设 id（粗档）——设置后群聊优先使用它，私聊仍用 agentPreset；留空 = 群私同源'),
  permissions: z.object({
    memberTools: z.union([z.const('none'), z.const('all')]).default('none')
      .description('成员档位（非管理员）的工具权限：none=成员回合禁用全部 qq_* 工具（默认，插件硬拦截）；all=不限'),
  }),
  workspacePath: z.string().default('')
    .description('QQ 会话的工作区目录（写入会话 cwd，并自动归入该工作区，不存在则创建）；留空时使用宿主进程工作目录并在启动时告警提醒（宿主未提供可编程查询的默认工作区），单聊 /workspace 覆盖优先且已持久化到会话映射文件，重启/恢复失败均不丢失'),
  groupWorkspacePath: z.string().default('')
    .description('群工作区目录（T3 PR 移植）：设置后群聊会话默认落在该独立目录（自动归入该工作区），私聊不受影响；单聊 /workspace 覆盖仍最优先；留空 = 群聊与私聊同源 workspacePath（默认，维持现行为）'),
  sessionAutoRecover: z.boolean().default(false)
    .description('退休会话自动恢复（T3 PR 移植）：chat 绑定的会话在宿主侧已退休/不存在时，启动加载扫描宿主 sessions 目录，找该 chat 可用的最新会话自动重绑；扫描失败/无候选时静默降级为原行为（保持退休跳过或重新建会话）；默认关（不改变现行为）'),
  inboundFileMaxBytes: z.number().default(INBOUND_FILE_MAX_BYTES)
    .description('QQ 入站文件最大字节数（直链/base64 拉取，0 = 不限制）'),
  maxInboundFileBytes: z.number().deprecated()
    .description('[deprecated] 旧名别名（现 inboundFileMaxBytes）：QQ 入站文件最大字节数；本版兼容读取，新配置请用新名'),
  allowPrivateHosts: z.boolean().default(false)
    .description('下载 SSRF 防护逃生门：默认拒绝解析到私网/环回/链路本地地址的下载目标（协议仅 http/https、重定向逐跳复检仍生效）；NapCat 文件服务器或反代部署在本机/内网时置 true 跳过私网检查'),
  fileRefRoots: z.array(z.string()).default([])
    .description('允许复制的 file:// 源根目录列表；空数组（默认）拒绝所有入站 file:// ref；路径按 realpath 校验，必须在这些根目录内'),
  allowCidrs: z.array(z.string()).default([])
    .description('可选 CIDR 白名单（IPv4/IPv6，如 100.64.0.0/10、fd7a:115c:a1e0::/48）：只放行这些私网段，其他私网/环回仍拒绝；空数组保持原行为'),
  chatIdleEvictDays: z.number().default(7)
    .description('会话空闲淘汰天数：chat 超过该天数无任何活动时，在下一条入站消息处理前清理其 agent（会话先落盘 flush、映射保留，之后同一 chat 的消息可 resume 恢复原会话）；0 = 禁用'),
  dedupWindowSeconds: z.number().default(300)
    .description('入站消息去重窗口（秒，W2-②）：同一会话内相同 message_id 在该窗口内重投（断线重连重放等）只处理第一条，后续静默跳过并记 debug；仅对会触发回复处理的消息事件生效（notice/meta 类不经过此闸）；0 = 禁用去重'),
  actionRatePerMinute: z.number().default(20)
    .description('主动写操作每分钟全桥合计上限（W2-③）：约束 qq_send_image/voice/video/file/segments 与 qq_send_forward 等工具发起的主动发送（回合内的被动回复/interim/通知不受此闸，由 rateLimitPerMinute 与离线队列上限约束）；超限拒发并记 warn 与审计；0 = 禁用分钟限额'),
  actionRatePerDay: z.number().default(500)
    .description('主动写操作每日（本地自然日）全桥合计上限（W2-③）：口径同 actionRatePerMinute；超限拒发并记 warn 与审计，次日自动恢复；0 = 禁用日限额'),
  actionAuditEnabled: z.boolean().default(true)
    .description('主动写审计（W2-③）：每次主动写（成功/失败）与拒发事件追加写一行 JSON 到 mediaDir/qq-actions.log（含 ts/chatId/action/ok/reason）；写失败仅 warn 不影响发送'),
  outboundDefenseEnabled: z.boolean().default(false)
    .description('出站防御（T2 移植）：回复正文先经 cleanOutboundText 清洗——砍复读（同一小段连着 8 次以上或整行连着 5 行以上）、切掉模型复读出来的 <user_message> 宿主信封尾巴、剥半截 DSML/收尾标记与独立 URL 行，残留的 [[reply…]]/[[qq_forward]] 歪写标记兜底删除，正文里的 [[at:QQ号]] 换成真 at 段；默认关闭——与上游 0.9.19 行为逐字节等价'),
  asideOnlySilentEnabled: z.boolean().default(false)
    .description('旁白静默（T2 移植）：整条回复只剩括号旁白（如「（嗯……）」）时静默不发送；默认关闭——照常发送'),
  traceEnabled: z.boolean().default(false)
    .description('链路追踪（W1）：为每条入站消息生成 traceId 并贯穿入站→模型回合→出站，决策事件（含限流/去重/白名单/@ 门控/闸门拒发与每个静默丢弃分支的中文 reason）逐行 JSON 落盘 mediaDir/qq-trace.jsonl（4MiB 改名轮转，保留 qq-trace.1/2.jsonl；同一原因 5 分钟限频）；默认关闭——关闭时不生成 traceId、不落盘、决策行为与 0.6.0 完全一致'),
  traceLevel: z.union([z.const('debug'), z.const('warn')]).default('debug')
    .description('追踪事件级别（W1）：debug=记录全部决策事件；warn=仅记录 ok:false（被拒/失败/丢弃）事件'),
  recordInbound: z.boolean().default(false)
    .description('入站录制（W1）：把收到的每条入站事件（含被门控跳过的，附当时决策 reason）按可回放形状逐行 JSON 追加写 mediaDir/qq-inbox.jsonl（2MiB 改名轮转，保留 qq-inbox.1/2.jsonl；注入的帧不会被二次录制）；纯旁路：写失败仅 warn 限频，绝不影响回复管线；默认关闭——零文件零开销'),
  inboxRedact: z.boolean().default(false)
    .description('录制脱敏（W1）：落盘前把帧中 6 位以上的数字串（QQ 号/群号等）脱敏为前 3 位+****（数字型 id 字段一并处理），便于把录制文件发给别人离线回放；默认关闭'),
  injectEnabled: z.boolean().default(false)
    .description('事件注入通道（W1，仅调试用——信任边界：注入是调试通道，默认全关，勿在生产开启）：开启后按 injectIntervalMs 轮询 mediaDir/qq-inject.jsonl，把新行喂进真实入站管线（trace 事件标 stage=inject）；启动时已存在的历史行跳过并记一条说明；默认关闭'),
  injectDryRun: z.boolean().default(true)
    .description('注入干跑（W1）：true（默认，强烈建议保持）=注入回合触发的全部出站写操作（发消息/撤回等，含异步模型回合的最终回复——拦截点在出站动作层）被拦截计数、原文进 trace 事件、绝不真发 QQ；false=注入内容会真实发送，仅限隔离环境实验'),
  injectIntervalMs: z.number().default(2000)
    .description('注入队列轮询间隔（毫秒，W1；最小 500）'),
  logLevel: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')]).default('info')
    .description('控制台日志级别门槛（debug < info < warn < error）：低于该级别的日志不输出。debug=全部输出（含「session 事件早退」等调试行）；info=常规信息（启动、连接建立、meta 事件等，默认）；warn=仅警告与错误；error=仅错误'),
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

/** Severity rank for the logLevel gate (debug < info < warn < error). */
const LOG_LEVEL_RANK: Record<Config['logLevel'], number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Log a meta event; periodic heartbeat events are silenced to keep the log readable. */
export function logMetaEvent(selfId: string, event: OneBotEvent, minLevel: Config['logLevel'] = 'info'): void {
  const metaType = typeof event.meta_event_type === 'string' ? event.meta_event_type : ''
  if (metaType === 'heartbeat') return
  if (LOG_LEVEL_RANK.info < LOG_LEVEL_RANK[minLevel]) return
  console.log('[dsh-onebot] meta event; bot QQ: ' + selfId + '; ' + metaType)
}

/** Mount the plugin. */
export function apply(ctx: Context, config: Config): void {
  // D4a: honor the deprecated config names before any consumer reads them.
  config = resolveDeprecatedConfig(config)
  // T14: qq_send_segments 插件页开关与发送间隔——必须在任何 agent scope 注册
  // 工具（bridge.installChannelScope → registerTools）之前生效。
  configureSendSegments(config.segments)
  const mediaDir = config.mediaDir !== '' ? config.mediaDir : defaultMediaDir()
  const policy = resolvePolicy(config)
  /** Console log line callback (level, message) — shared by the bridge deps,
   * the connection log port and the host-ready boot gate below (M2-C5b). */
  const log = (level: 'info' | 'warn' | 'error' | 'debug', message: string): void => {
    if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[config.logLevel]) return
    const prefix = '[dsh-onebot] '
    if (level === 'error') console.error(prefix + message)
    else if (level === 'warn') console.warn(prefix + message)
    else console.log(prefix + message)
  }
  // T3 方案 B: the host exposes no queryable default workspace —
  // WorkspaceRegistry has no default getter and the session controller's
  // defaultCwd is assembly-internal — so the unconfigured fallback stays the
  // host process cwd. Say so once at mount so a /root surprise is explainable.
  if (config.workspacePath === '') {
    log('warn', '未配置 workspacePath：QQ 会话默认目录将使用宿主进程工作目录 ' + process.cwd() + '，建议在配置中设置 workspacePath，避免会话工作区落在宿主启动目录')
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
  const media = new MediaStore(mediaDir, config.tempTtlHours, config.inboundImageMaxPx, { maxBytes: config.inboundFileMaxBytes, allowPrivateHosts: config.allowPrivateHosts, fileRefRoots: config.fileRefRoots, allowCidrs: config.allowCidrs })
  // W1: the trace sink exists only when explicitly enabled — default off
  // means no sink, no traceIds, no jsonl, zero behavior difference.
  const traceSink = config.traceEnabled
    ? new TraceSink({ dir: mediaDir, level: config.traceLevel, log: (level, message) => log(level, message) })
    : undefined
  // W1/T5: the inbound recorder exists only when recordInbound is on (pure
  // bypass: its own writer, failures only warn); the inject channel only
  // when injectEnabled is on (DEBUG-ONLY) — both absent by default.
  const recorder = config.recordInbound
    ? new InboundRecorder({ dir: mediaDir, redact: config.inboxRedact, log: (level, message) => log(level, message) })
    : undefined
  const injectChannel: import('./inject.js').InjectChannel | undefined = config.injectEnabled
    ? new InjectChannel({
        dir: mediaDir,
        dryRun: config.injectDryRun,
        intervalMs: config.injectIntervalMs,
        handleEvent: async (event: import('./connection.js').OneBotEvent): Promise<void> =>
          bridge.handleInbound(event, { injected: true }),
        trace: traceSink,
        log: (level, message) => log(level, message),
      })
    : undefined
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
    logMetaEvent(connection.selfId, event, config.logLevel)
  }
  // T1 (PR port): 戳一戳 notice → 伪消息。节流表随插件挂载存续；伪消息
  // 重新走 bridge.handleInbound 全管线（白名单/@ 门/限流等照常生效）。
  connection.onNotice = createPokeHandler({
    pokeEnabled: config.pokeEnabled,
    selfId: () => connection.selfId,
    dispatch: event => {
      void bridge.handleInbound(event)
    },
    log,
  })
  // W2-②③ gate keys: BridgeConfig (bridge.ts) keeps its declared shape; the
  // pipelines read them off the runtime object via optional intersection
  // members (see InboundContext/OutboundContext.config), so the spread here
  // is the wiring — no bridge.ts change.
  const gateConfig = {
    dedupWindowSeconds: config.dedupWindowSeconds,
    actionRatePerMinute: config.actionRatePerMinute,
    actionRatePerDay: config.actionRatePerDay,
    actionAuditEnabled: config.actionAuditEnabled,
    // T1 (PR port): 引用即叫 / @全体即叫 / 唤醒词——入站管线经可选交叉成员
    // 读取（见 InboundContext.config），走 spread 以绕过对象字面量多余属性检查。
    replyCountsAsMention: config.replyCountsAsMention,
    atAllCountsAsMention: config.atAllCountsAsMention,
    wakeNamesAdmin: config.wakeNamesAdmin,
    wakeNamesMember: config.wakeNamesMember,
    // T2 (PR port): 出站防御与旁白静默——出站管线经可选交叉成员读取
    //（见 OutboundContext.config），同上走 spread 接线。
    outboundDefenseEnabled: config.outboundDefenseEnabled,
    asideOnlySilentEnabled: config.asideOnlySilentEnabled,
  }
  const bridge: import('./bridge.js').ChatBridge = new ChatBridge({
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
    // Live lookup per read: patch line order does not decide load order, so the
    // service may arrive after this plugin applied.
    get userQuestions() {
      return resolveUserQuestions(ctx)
    },
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
      requireMention: config.requireMention,
      unknownCommand: config.unknownCommand,
      newMessagePolicy: config.newMessagePolicy,
      autoSteerPolicy: config.autoSteerPolicy,
      deferredTimeoutMs: config.deferredTimeoutMs,
      interimMessages: config.interimMessages,
      interimRecallMs: config.interimRecallMs,
      interimRecall: config.interimRecall,
      sendErrorNotice: config.sendErrorNotice,
      notices: config.notices,
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
      monoFamilies: config.monoFamilies,
      agentPreset: config.agentPreset,
      agentPresetGroup: config.agentPresetGroup,
      permissions: { memberTools: config.permissions.memberTools },
      workspacePath: config.workspacePath,
      groupWorkspacePath: config.groupWorkspacePath,
      sessionAutoRecover: config.sessionAutoRecover,
      maxInboundFileBytes: config.inboundFileMaxBytes,
      chatIdleEvictDays: config.chatIdleEvictDays,
      ...gateConfig,
      trace: traceSink,
      recorder,
      inject: injectChannel,
    },
    policy,
    // W1/T5 health: the config snapshot is redacted at the source — secrets
    // (token/password/apikey…) never leave this closure in the clear.
    configSnapshot: () => redactSnapshot(config as unknown as Record<string, unknown>),
    log,
  })

  // W3/T4 (P3): connection faults mint QQ-CONN-… references through the
  // bridge (registry + trace + structured log); the transport appends the
  // returned reference to its own log line, so host logs and qq-trace.jsonl
  // share the same number for one fault.
  connection.onFailure = (stage: string, detail: string): string => bridge.registerConnectionFailure(stage, detail)

  // Lifecycle: start the bridge and transport; unwind everything on unload.
  // The effect body is async (cordis AsyncEffect): injectChannel.start() must
  // be awaited — it skips history before arming its poll timer, and a stop
  // landing before start completes would leave a dangling timer. The effect's
  // disposer is awaitable and dispose waits for the setup promise to settle
  // first, so an unload during startup runs the cleanup chain strictly after
  // start completes: no overlapping start/stop, no ghost timers or listeners.
  ctx.effect(async () => {
    // T2-board: two-phase lifecycle log — 'starting' prints synchronously
    // when the effect body runs; 'mounted' only after the whole start chain
    // has settled (the old single line printed BEFORE completion, claiming
    // "mounted" while the channels were still coming up).
    const mountDetails = ' (mode=' + config.mode + ', media=' + mediaDir + ', admins=' + policy.adminUsers.length + ')'
    console.log('[dsh-onebot] starting' + mountDetails)
    try {
      await bridge.start()
      await connection.start()
      await injectChannel?.start()
    } catch (error) {
      // #37: an async-effect rejection is swallowed by cordis (task?.catch —
      // no log, fiber stays active). Surface the failure and unwind the
      // already-started chain (same order as the disposer) before rethrowing.
      log('error', 'dsh-onebot 启动失败: ' + describeError(error))
      await injectChannel?.stop()
      await bridge.stop()
      await connection.stop()
      throw error
    }
    console.log('[dsh-onebot] mounted' + mountDetails)
    // QQ 平台说明与 qq_* 工具现按会话 agent 注入（见 ChatBridge.installChannelScope）
    return async () => {
      await injectChannel?.stop()
      await bridge.stop()
      await connection.stop()
    }
  }, 'dsh-onebot.lifecycle')
}
