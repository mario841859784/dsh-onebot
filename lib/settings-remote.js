/**
 * dsh-onebot — `onebotSettings` Typert Remote service（T3 · T1 定案 B 路径）
 *
 * Host-plane root service declared in cordis.patch.yml（仓库模板同名文件）via an
 * independent insert row (`- id: onebot-settings-remote / name:
 * <DEPLOY_DIR>/lib/settings-remote.js`)，so the api-gateway discovers the
 * `onebotSettings` Remote namespace and the settings page client（T4,
 * lib/client.js）can read/write the dsh-onebot entry's config override row.
 * 契约唯一来源：docs/settings-page-design.md（T1 定案）§2 / §3 / §3.1 / §4。
 *
 * Contract — namespace `onebotSettings`，每方法一个 descriptor，全 positional
 * （宿主网关按 descriptor 位置序调用，methodParameterNames 拒绝解构/默认值/
 * rest，dsh-api-gateway/lib/index.js:1458-1495）：
 *
 *   getSettings()                            → OnebotSettingsSnapshot
 *   updateSettings(patch, expectedRevision)  → OnebotSettingsSnapshot
 *   listWorkspaces()                         → WorkspaceListResult（W7：只读查询宿主
 *     dsh-workspace 注册表，供设置页「快速填入 workspace」；registry 缺席/list()
 *     失败一律降级为 {available:false, workspaces:[]}，不抛错——辅助查询绝不
 *     阻塞 getSettings/updateSettings 主链路，也绝不打开 registry 内部态）
 *
 * 持久层 = profile patch 中 `dsh-onebot` 条目的 config 覆盖行（T1 §3——设置页
 * /手改 patch/宿主原生设置页三方同源，无第二优先级）。写入经宿主
 * configEditor.edit（dsh-config-editor/lib/index.js:63-123：文件锁 + 原子写 +
 * reconcile 热生效 + 激活失败自动回滚），本模块不发明第二条写路径。
 *
 * revision 语义（T1 §3.1，对齐宿主 SettingsForms）：
 * - 每宿主进程、每服务实例一个内存计数器，从 0 开始，不持久化；
 * - 读侧每次调用将 entry.options.config 序列化为指纹与上次比较，任何来源的
 *   已提交变更都 +1（本 Remote / 宿主原生设置页 / HMR 后的手改 patch）；
 * - updateSettings 的 expectedRevision ≠ 当前值 → 拒写，抛
 *   RemoteError('onebot-settings/conflict', {expected, actual})；undefined =
 *   无条件写（对齐宿主 settingsController 的 expectedRevision 语义，
 *   dsh-api-settings-controller/lib/index.js:404）；
 * - 不递增：写入被拒（校验失败 / 锁冲突 / 激活失败回滚）、no-op（合并结果与
 *   当前生效 config 全等，跳过 edit）。
 *
 * 敏感字段：accessToken 快照返回侧脱敏——snapshot.config.accessToken 恒为
 * ''，明文是否已配置由 snapshot.secrets 标记（T1 §3 敏感字段行；写入侧在
 * patch 文件明文落盘是宿主既有管道默认行为，加密存储范围外）。
 *
 * @deepseek-ai/dsh-typert-protocol 不可解析时（裸 dev checkout；装好的 profile
 * 内可解析）降级为普通 cordis 服务而非炸掉插件加载（照抄
 * dsh-expert-orchestrator/lib/remote.js 的降级骨架）。
 */
import { isDeepStrictEqual } from 'node:util';
/** patch insert 中 dsh-onebot 主条目的 id（T1 §2/§3：唯一持久层条目）。 */
export const ENTRY_ID = 'dsh-onebot';
/** Typert Remote 命名空间 = cordis 服务键（T1 §4）。 */
export const NAMESPACE = 'onebotSettings';
/** 快照固定值：全部键均为插件级热重启生效（T1 §5；T5 扩到 66 键、T7 扩到 69 键同粒度）。 */
export const REMOTE_EFFECT = 'restart';
/** 设置页 UI 六组 71 键（T5：键表对齐贡献者 0.9.19 版——connection 14 /
 *  permissions 15 / behavior 10 / session 5 / media 15 / diagnostics 7；T6 media
 *  组尾增 gifFramesEnabled、T7 behavior 组尾增 inboxQueueEnabled/
 *  inboxQueueDelayMs、T11 组尾增 sidebarEntryEnabled、T24 behavior 组尾增
 *  titleSyncEnabled；0.10.0 重排：connection 6 键（通道配置）、
 *  workspacePath/groupWorkspacePath/forceSessionId/dmPromptFile/groupPromptFile
 *  归 session（6→10）、allowPrivateHosts 归 media（17）、ignoreSelf/
 *  sidebarEntryEnabled 归 behavior（12→14）；与
 *  src/index.ts Config schema 一一对应，未入库功能的键
 *  先行进表、schema 定义随后批接上，见 PENDING_SCHEMA_KEYS）。T1 四组 29 键
 *  仍为前四组前缀，旧面板（lib/client.js 手写真相源，T8 重写）继续可渲染。
 *  分组沿用 W6 取舍：diagnostics 组 = 观测/调试面开关；session/media 两组来自
 *  贡献者键表（T4 提示词/记忆文件、T5 媒体限额键的 UI 归属）。gifFramesEnabled
 *  为本仓 T6 批次自有开关（贡献者无对应键），归入 media 组。 */
export const SETTINGS_GROUPS = {
    // 0.10.0 重排（用户裁定方案 A）：连接=通道配置 6 键；工作区/强制会话/提示词文件
    // 归 session；allowPrivateHosts 归 media；ignoreSelf/sidebarEntryEnabled 归 behavior。
    connection: ['mode', 'host', 'port', 'url', 'accessToken', 'botQQ'],
    permissions: ['requireMention', 'memberTools', 'adminUsers', 'dmPolicy', 'groupPolicy', 'allowAllUsers', 'allowFrom', 'groupAllowFrom', 'wakeNamesAdmin', 'wakeNamesMember', 'replyCountsAsMention', 'atAllCountsAsMention', 'reactionOnMention', 'reactionEmoji', 'faceStyle', 'pokeEnabled', 'restrictedMemberPrefix', 'sensitivePatterns'],
    behavior: ['interimMessages', 'interimRecall', 'interimRecallMs', 'sendErrorNotice', 'unknownCommand', 'rateLimitPerMinute', 'newMessagePolicy', 'autoSteerPolicy', 'deferredTimeoutMs', 'inboxQueueEnabled', 'inboxQueueDelayMs', 'titleSyncEnabled', 'ignoreSelf', 'sidebarEntryEnabled'],
    // #58 群聊旁观：默认全关/空（enabled=false 时其余四键零行为）。
    bystander: ['bystanderEnabled', 'bystanderCapacity', 'bystanderCooldownMinutes', 'bystanderDailyLimit', 'bystanderTopics'],
    session: ['newSessionGreeting', 'firstMessageAsUser', 'memoryFilesEnabled', 'memoryFiles', 'agentPreset', 'workspacePath', 'groupWorkspacePath', 'forceSessionId', 'dmPromptFile', 'groupPromptFile'],
    media: ['sttEnabled', 'sttEngine', 'sttCommand', 'sttArgs', 'sttModel', 'textImageEnabled', 'textImageThreshold', 'cardFooter', 'fontFiles', 'fontFamilies', 'outboundImageMaxBytes', 'maxVoiceBytes', 'maxFileBytes', 'inboundImageMaxPx', 'inboundFileMaxBytes', 'gifFramesEnabled', 'allowPrivateHosts'],
    diagnostics: ['actionAuditEnabled', 'traceEnabled', 'recordInbound', 'inboxRedact', 'injectEnabled', 'injectDryRun', 'logLevel'],
};
/** schema 默认值（摘自 src/index.ts Config schema 默认值），快照生效值的底层。
 *  T5：默认值翻转 10 处（用户裁定①，含安全面项 allowPrivateHosts/injectEnabled/
 *  injectDryRun）+ 键表扩到 66 键（贡献者 0.9.19 批次）。其中 injectEnabled/
 *  injectDryRun 已改回默认关 + 干跑（注入通道仅调试用，见 src/inject.ts 头注释）。
 *  与贡献者取值的偏差（本仓已拍板事实优先）：dmPromptFile/groupPromptFile 默认
 *  ''（T4 拍板默认关，贡献者为 ~/.dsh 路径）、memoryFilesEnabled 默认 false
 *  （同 T4，贡献者 true）、notices 无 newSession 键（我们 schema 无该键）。 */
export const SCHEMA_DEFAULTS = {
    mode: 'forward',
    host: '127.0.0.1',
    port: 8643,
    url: 'ws://127.0.0.1:3001',
    accessToken: '',
    botQQ: '',
    // W7：会话默认工作区路径（schema 默认 ''，src/index.ts:287——留空 = 宿主进程 cwd）。
    workspacePath: '',
    // T3：群聊会话默认工作区路径（schema 默认 ''，留空 = 跟随 workspacePath）。
    groupWorkspacePath: '',
    // PENDING（未入库功能键）：强制会话 id（schema 定义后批接上；贡献者组内列出但缺默认，此处补 ''）。
    forceSessionId: '',
    // PENDING：私聊/群聊提示词文件（贡献者默认 ~/.dsh 路径；本仓 T4 拍板默认关 = ''）。
    dmPromptFile: '',
    groupPromptFile: '',
    // T5 翻转：下载 SSRF 防护逃生门（原 false）。
    allowPrivateHosts: true,
    ignoreSelf: true,
    // T11：DSH 首页左侧边栏「QQ 机器人」入口开关（用户裁定默认开；客户端按
    // 当前快照条件注册，false 时侧边栏入口与配对 main 面板 slot 均不注册）。
    sidebarEntryEnabled: true,
    requireMention: true,
    // A2 (#59)：成员档位工具权限默认关（fail-closed，与 schema 默认一致）。
    memberTools: 'none',
    // #58 群聊旁观（默认关；与 schema 默认逐项一致）。
    bystanderEnabled: false,
    bystanderCapacity: 50,
    bystanderCooldownMinutes: 45,
    bystanderDailyLimit: 20,
    bystanderTopics: [],
    adminUsers: [],
    dmPolicy: 'open',
    groupPolicy: 'open',
    allowAllUsers: false,
    allowFrom: [],
    groupAllowFrom: [],
    wakeNamesAdmin: [],
    wakeNamesMember: [],
    replyCountsAsMention: false,
    atAllCountsAsMention: false,
    // 群聊 @ 表情回执（默认关；仅 NapCat/SnowLuma 支持 set_msg_emoji_like）。
    reactionOnMention: false,
    reactionEmoji: 178,
    // T6 转正：@ 消息样式（name=显示名字，emoji=仅表情）。
    faceStyle: 'name',
    // T6 (PR port GIF 分帧)：开关默认 false，关闭时不装依赖也不触碰 FS（上游等价）。
    gifFramesEnabled: false,
    pokeEnabled: true,
    restrictedMemberPrefix: true,
    sensitivePatterns: [],
    interimMessages: true,
    interimRecall: false,
    interimRecallMs: 90_000,
    sendErrorNotice: false,
    unknownCommand: 'intercept',
    rateLimitPerMinute: 30,
    // T2 (P1)：任务运行中的新消息处理策略（steer=插话默认；queue=排队）。
    newMessagePolicy: 'steer',
    // T9-B (用户裁决 2026-10-12)：自动插话资格档位（admin=仅管理员默认；all=不限）。
    autoSteerPolicy: 'admin',
    // T3 (P2)：等待模型回复超时阈值（毫秒；0=关闭超时补发）。
    deferredTimeoutMs: 600_000,
    // T7 (PR port 入站连发合并)：开关默认关（关侧与上游逐字节等价）；合并窗口
    // 600ms（首条起最多 3000ms 封顶，常量在 src/inbound-queue.ts）。
    inboxQueueEnabled: false,
    inboxQueueDelayMs: 600,
    // T24 (PR port 会话标题同步)：开关默认关（裁定口径；钉住态标题永不覆盖）。
    titleSyncEnabled: false,
    // PENDING：新会话欢迎语/首条消息按用户身份发送。
    newSessionGreeting: true,
    firstMessageAsUser: true,
    // T4：会话记忆文件（本仓 T4 拍板默认关；贡献者 true）。
    memoryFilesEnabled: false,
    memoryFiles: [],
    agentPreset: '',
    sttEnabled: true,
    sttEngine: 'auto',
    sttCommand: '',
    sttArgs: [],
    sttModel: 'small',
    // PENDING：正文渲染文字图卡片开关（textImageThreshold 已翻转，开关键后批接上）。
    textImageEnabled: true,
    // T5 翻转：正文超 350 字符（原 150）渲染文字图卡片。
    textImageThreshold: 350,
    // T5 翻转：文字图卡片页脚品牌文字（原 'dsh'）。
    cardFooter: 'OneBot',
    fontFiles: [],
    fontFamilies: [],
    // 媒体限额（与 src/media.ts 常量及 schema 默认一致）。
    outboundImageMaxBytes: 8 * 1024 * 1024,
    maxVoiceBytes: 15 * 1024 * 1024,
    maxFileBytes: 20 * 1024 * 1024,
    inboundImageMaxPx: 2048,
    inboundFileMaxBytes: 20 * 1024 * 1024,
    chatIdleEvictDays: 7,
    // W6：W1/W2 可观测/调试布尔键 + T5 翻转（inboxRedact）；注入通道默认关 + 干跑。
    actionAuditEnabled: true,
    traceEnabled: false,
    recordInbound: false,
    inboxRedact: true,
    injectEnabled: false,
    injectDryRun: true,
    logLevel: 'info',
    // 通知开关（schema 默认全 true；单独校验通道见 validatePatch）。
    notices: { steerAccepted: true, queue: true, answerAccepted: true, deferredTimeout: true, rateLimited: true },
};
/** notices 对象的合法子键（我们 schema 无贡献者的 newSession，故 5 键）。 */
export const NOTICE_KEYS = ['steerAccepted', 'queue', 'answerAccepted', 'deferredTimeout', 'rateLimited'];
/** T7 键表先行、schema 定义后批接上的键（T7 落地前，完整性测试豁免）。
 *  faceStyle 已随 T6 官方表情名表批次转正（src/index.ts schema 已定义）。 */
export const PENDING_SCHEMA_KEYS = ['forceSessionId', 'newSessionGreeting', 'firstMessageAsUser', 'textImageEnabled'];
/** 快照返回侧脱敏的键（T1 §3 敏感字段行；写入侧明文落盘属宿主既有行为）。 */
export const SECRET_KEYS = ['accessToken'];
const ENUM_KEYS = {
    mode: ['reverse', 'forward'],
    dmPolicy: ['open', 'allowlist', 'disabled'],
    groupPolicy: ['open', 'allowlist', 'disabled'],
    unknownCommand: ['intercept', 'passthrough'],
    // T2 (P1)：steer=插话（默认）；queue=排队。
    newMessagePolicy: ['queue', 'steer'],
    // T9-B (用户裁决 2026-10-12)：admin=仅管理员（默认）；all=不限。
    autoSteerPolicy: ['admin', 'all'],
    // A2 (#59)：成员档位工具权限——none=禁用全部（默认）；send=仅发送类；all=不限。
    memberTools: ['none', 'send', 'all'],
    // T5 键表新增：@ 样式 / 日志级别 / 语音转写引擎。
    faceStyle: ['name', 'emoji'],
    logLevel: ['debug', 'info', 'warn', 'error'],
    sttEngine: ['auto', 'openai', 'whisper-cpp', 'custom'],
};
const NUMBER_KEYS = ['port', 'interimRecallMs', 'rateLimitPerMinute', 'deferredTimeoutMs', 'textImageThreshold', 'chatIdleEvictDays', 'outboundImageMaxBytes', 'maxVoiceBytes', 'maxFileBytes', 'inboundImageMaxPx', 'inboundFileMaxBytes', 'inboxQueueDelayMs', 'bystanderCapacity', 'bystanderCooldownMinutes', 'bystanderDailyLimit', 'reactionEmoji'];
/** 数字键取值范围（评审 B4：port 1–65535、时长/频控 ≥0；越界在 Remote 层拒绝，不再只依赖宿主回滚兜底）。 */
const NUMBER_RANGE = {
    port: [1, 65535],
    interimRecallMs: [0, undefined],
    rateLimitPerMinute: [0, undefined],
    deferredTimeoutMs: [0, undefined],
    textImageThreshold: [0, undefined],
    chatIdleEvictDays: [0, undefined],
    outboundImageMaxBytes: [1, 104857600],
    maxVoiceBytes: [1, 52428800],
    maxFileBytes: [1, 4294967296],
    inboundImageMaxPx: [0, undefined],
    inboundFileMaxBytes: [0, undefined],
    // T7：合并窗口毫秒数（≥0；0=立即投递，等同关闭合并但串行链仍生效）。
    inboxQueueDelayMs: [0, undefined],
    // #58 旁观：容量条数 / 冷却分钟 / 每日上限。
    bystanderCapacity: [5, 500],
    bystanderCooldownMinutes: [5, 1440],
    bystanderDailyLimit: [1, 200],
    // 群聊 @ 表情回执：表情 ID（非负整数）。
    reactionEmoji: [0, undefined],
};
/** 布尔键白名单（T1 §4 + W6 + T5 键表 22 键 + T6 gifFramesEnabled + T7
 *  inboxQueueEnabled + T11 sidebarEntryEnabled + T24 titleSyncEnabled：26 键）。 */
const BOOLEAN_KEYS = [
    'requireMention', 'allowAllUsers', 'interimMessages', 'interimRecall', 'sendErrorNotice',
    'newSessionGreeting', 'replyCountsAsMention', 'atAllCountsAsMention', 'reactionOnMention',
    'actionAuditEnabled', 'traceEnabled', 'recordInbound', 'inboxRedact', 'injectEnabled', 'injectDryRun',
    'textImageEnabled', 'pokeEnabled', 'firstMessageAsUser', 'memoryFilesEnabled', 'ignoreSelf',
    'sttEnabled', 'restrictedMemberPrefix', 'allowPrivateHosts', 'gifFramesEnabled', 'inboxQueueEnabled',
    'sidebarEntryEnabled', 'titleSyncEnabled', 'bystanderEnabled',
];
const STRING_KEYS = ['host', 'url', 'accessToken', 'botQQ', 'workspacePath', 'groupWorkspacePath', 'forceSessionId', 'dmPromptFile', 'groupPromptFile', 'cardFooter', 'agentPreset', 'sttCommand', 'sttModel'];
const STRING_ARRAY_KEYS = ['adminUsers', 'allowFrom', 'groupAllowFrom', 'wakeNamesAdmin', 'wakeNamesMember', 'memoryFiles', 'sensitivePatterns', 'sttArgs', 'fontFiles', 'fontFamilies', 'bystanderTopics'];
/** 全部 71 键（校验与快照的唯一键集；9 枚举 + 12 数字 + 26 布尔 + 13 字符串 +
 *  10 字符串数组 + notices 单独通道；T6 新增 gifFramesEnabled、T7 新增
 *  inboxQueueEnabled/inboxQueueDelayMs、T11 新增 sidebarEntryEnabled、T24 新增
 *  titleSyncEnabled、T1 reaction 新增 reactionOnMention/reactionEmoji，实际
 *  键数以 ALL_KEYS 数组为准）。 */
export const ALL_KEYS = [
    ...Object.keys(ENUM_KEYS), ...NUMBER_KEYS, ...BOOLEAN_KEYS, ...STRING_KEYS, ...STRING_ARRAY_KEYS, 'notices',
];
/** typert-protocol 不可解析时的降级错误：结构对齐 RemoteError（code/details/
 *  isDSHRemoteError 标记），保证失败路径语义一致。 */
class FallbackRemoteError extends Error {
    code;
    details;
    isDSHRemoteError = true;
    constructor(code, message, details, options) {
        super(message, options);
        this.code = code;
        this.details = details;
        this.name = 'RemoteError';
    }
}
let protocol = null;
try {
    protocol = await import('@deepseek-ai/dsh-typert-protocol');
}
catch {
    protocol = null;
}
/** RemoteError 统一出口：协议在位用宿主类（跨域识别按 isDSHRemoteError），否则降级类。
 *  宿主类对 code 有 RemoteErrorDetailsMap 泛型约束（类型层），本服务使用自有
 *  onebot-settings/* 错误码（运行期任意字符串均可，网关原样透传），故统一收窄为
 *  本模块的宽松构造签名。 */
const RemoteError = (protocol?.RemoteError ?? FallbackRemoteError);
/** 乐观锁/降级以外唯一会抛的宿主依赖缺失情形：configEditor 不在位。 */
function requireConfigEditor(ctx) {
    const editor = ctx?.get?.('configEditor');
    if (!editor || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
        throw new RemoteError('onebot-settings/no-config-editor', 'configEditor service is unavailable: the onebot-settings-remote row must mount beside the host bundle\'s dsh-config-editor', { entryId: ENTRY_ID });
    }
    return editor;
}
/** 在 profile patch 的可寻址条目中定位 dsh-onebot 主条目；不存在必须显式报错
 *  （T1 §2：条目不存在时返回明确错误，不得静默）。 */
function findEntry(editor) {
    const entry = editor.entries().find((candidate) => candidate?.options?.id === ENTRY_ID);
    if (!entry) {
        throw new RemoteError('onebot-settings/no-entry', `no active "${ENTRY_ID}" entry in the profile patch — mount dsh-onebot first`, { entryId: ENTRY_ID });
    }
    return entry;
}
/** T1 §2/§5：条目 fiber.state === 2 = active（与 configEditor.edit 的活性判据一致）。 */
function entryActiveOf(entry) {
    return entry.fiber !== undefined && entry.fiber.state === 2;
}
export function createRevisionState() {
    return { revision: 0, fingerprint: null };
}
function fingerprintOf(config) {
    return JSON.stringify(config ?? null);
}
/** §3.1 #2：读侧观察——config 指纹相对上次有差异即 +1（任何来源的已提交变更
 *  一视同仁）；首次调用仅建立基线不递增。 */
export function observeRevision(state, config) {
    const fingerprint = fingerprintOf(config);
    if (state.fingerprint !== null && fingerprint !== state.fingerprint)
        state.revision += 1;
    state.fingerprint = fingerprint;
    return state.revision;
}
/** W7：listWorkspaces 纯实现（descriptor 方法体共用；对 registry 形状做防御性
 *  校验——与 requireConfigEditor 同款「运行期再校验形状」风格，但绝不抛错：
 *  缺席/形状不符/list() 失败都归一为 unavailable 空列表）。 */
export function listWorkspaces(registry) {
    if (registry === undefined || typeof registry.list !== 'function') {
        return { available: false, workspaces: [] };
    }
    try {
        const workspaces = registry.list().map((workspace) => ({
            id: String(workspace?.id ?? ''),
            path: String(workspace?.path ?? ''),
            sessionCount: Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.length : 0,
        }));
        return { available: true, workspaces };
    }
    catch {
        // 只读辅助查询：注册表异常（存储失败等）不该炸掉设置页，降级为不可用。
        return { available: false, workspaces: [] };
    }
}
/** W7：惰性解析宿主 workspaceRegistry（不经 static inject——保持可选依赖，
 *  registry 缺席时服务照常挂载，仅 listWorkspaces 降级 unavailable）。 */
function resolveWorkspaceRegistry(ctx) {
    const registry = ctx?.get?.('workspaceRegistry');
    return registry !== undefined && registry !== null && typeof registry.list === 'function' ? registry : undefined;
}
/** 70 键生效值 = schema 默认值 ← 条目 config 覆盖（T1 §3 合并优先级一句话）。
 *  memberTools (#59) 是「面板扁平键 ↔ 宿主嵌套对象」特例（notices 先例）：
 *  宿主配置里它是 permissions.memberTools，快照读取时降一层取值。 */
export function effectiveConfig(raw) {
    const effective = {};
    for (const key of ALL_KEYS) {
        if (key === 'memberTools') {
            const permissions = raw.permissions;
            effective[key] = (typeof permissions === 'object' && permissions !== null ? permissions.memberTools : undefined) ?? SCHEMA_DEFAULTS[key];
            continue;
        }
        const value = raw[key];
        effective[key] = value === undefined ? SCHEMA_DEFAULTS[key] : value;
    }
    return effective;
}
function buildSnapshot(entry, state) {
    const raw = entry.options.config ?? {};
    const revision = observeRevision(state, raw);
    const config = effectiveConfig(raw);
    const secrets = SECRET_KEYS.map((key) => {
        const set = typeof raw[key] === 'string' && raw[key].length > 0;
        config[key] = ''; // 脱敏：快照不回显明文（T1 §3）
        return { path: [key], set };
    });
    return {
        revision,
        entryActive: entryActiveOf(entry),
        config,
        secrets,
        groups: Object.fromEntries(Object.entries(SETTINGS_GROUPS).map(([group, keys]) => [group, [...keys]])),
        effect: REMOTE_EFFECT,
    };
}
/** updateSettings 入参校验（T1 §4：ALL_KEYS 任意子集，扁平 JSON）。未知键整单
 *  拒绝（不静默丢弃）；类型/枚举不符拒绝；notices 走单独白名单通道（T5 对齐
 *  贡献者 0.9.19：子键须在 NOTICE_KEYS 内、值须 boolean|string，通过后作为
 *  增量对象原样入 clean——未提及的子键由宿主 schemastery 按默认值补齐）；具体
 *  取值合法性交由宿主 schemastery 校验 + reconcile 失败自动回滚兜底（T1 §5）。 */
export function validatePatch(patch) {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw new RemoteError('onebot-settings/bad-request', 'patch must be a flat JSON object keyed by setting names', {
            issues: ['patch 必须是扁平 JSON 对象'],
        });
    }
    const issues = [];
    const clean = {};
    for (const [key, value] of Object.entries(patch)) {
        const enums = ENUM_KEYS[key];
        if (enums !== undefined) {
            if (typeof value === 'string' && enums.includes(value))
                clean[key] = value;
            else
                issues.push(`${key} 必须是 ${enums.join(' | ')} 之一`);
        }
        else if (NUMBER_KEYS.includes(key)) {
            const [min, max] = NUMBER_RANGE[key];
            if (typeof value === 'number' && Number.isFinite(value) && value >= min && (max === undefined || value <= max))
                clean[key] = value;
            else
                issues.push(`${key} 必须是 ${max === undefined ? `≥${min}` : `${min}–${max}`} 的有限数字`);
        }
        else if (BOOLEAN_KEYS.includes(key)) {
            if (typeof value === 'boolean')
                clean[key] = value;
            else
                issues.push(`${key} 必须是布尔值`);
        }
        else if (STRING_KEYS.includes(key)) {
            if (typeof value === 'string')
                clean[key] = value;
            else
                issues.push(`${key} 必须是字符串`);
        }
        else if (STRING_ARRAY_KEYS.includes(key)) {
            if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
                clean[key] = value;
            else
                issues.push(`${key} 必须是字符串数组`);
        }
        else if (key === 'notices') {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                issues.push('notices 必须是对象');
            }
            else {
                const cleanNotices = {};
                for (const [noticeKey, noticeValue] of Object.entries(value)) {
                    if (!NOTICE_KEYS.includes(noticeKey)) {
                        issues.push(`未知 notice 键 "${noticeKey}"（仅支持 ${NOTICE_KEYS.join(', ')}）`);
                    }
                    else if (typeof noticeValue !== 'boolean' && typeof noticeValue !== 'string') {
                        issues.push(`notices.${noticeKey} 必须是布尔值或字符串`);
                    }
                    else {
                        cleanNotices[noticeKey] = noticeValue;
                    }
                }
                if (issues.length === 0)
                    clean[key] = { ...cleanNotices };
            }
        }
        else {
            issues.push(`未知设置键 "${key}"（仅支持 ${ALL_KEYS.length} 键：${ALL_KEYS.join(', ')}）`);
        }
    }
    if (issues.length > 0) {
        throw new RemoteError('onebot-settings/bad-request', `invalid settings patch: ${issues.join('; ')}`, { issues });
    }
    return clean;
}
/** getSettings 实现（descriptor 方法体共用；descriptor 参数 0 个）。 */
export function getSettings(editor, state) {
    return buildSnapshot(findEntry(editor), state);
}
/** W6 错误归一：宿主 configEditor.edit 的原生失败（文件锁超时 / 活性检查 /
 *  schema 校验 / home-patch 守卫 / 激活失败回滚后 rethrow）按
 *  docs/m1-characterization/config-editor.md §3 矩阵归类，转成面板可直接渲染的
 *  中文 RemoteError('onebot-settings/edit-failed')，原始错误挂 cause（网关透传
 *  detail 不吞诊断信息）。归类按宿主错误消息特征词匹配，未命中走通用文案；
 *  所有分支的共同事实（该文档 §3 已钉死）：失败时 patch 文件要么从未被写、要么
 *  已被宿主逐字节还原，本模块不做任何补偿写（不重试、不回写），仅归一转发。 */
export const EDIT_FAILED_CODE = 'onebot-settings/edit-failed';
export function describeEditFailure(cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/timed out waiting for the writer lock/i.test(message)) {
        return '写入失败：配置文件被其他写入方占用（等待文件锁超时），本次修改未落盘，请稍后重试';
    }
    if (/no longer available|changed during reload/i.test(message)) {
        return '写入失败：dsh-onebot 条目在编辑期间被替换或失活，本次修改未落盘，请刷新后重试';
    }
    if (/no longer active/i.test(message)) {
        return '写入失败：dsh-onebot 插件当前未激活，本次修改未落盘，请检查插件加载状态';
    }
    if (/overridden by a home patch|command-line overlay/i.test(message)) {
        return '写入失败：该配置被 home patch 或命令行覆盖层接管，修改被宿主拒绝；请改在对应层修改';
    }
    return `写入失败：宿主 configEditor 拒绝了本次修改（${message}），配置保持不变`;
}
/** updateSettings 实现（descriptor 参数 (patch, expectedRevision)，全 positional）。
 *
 * 流程：定位条目 → 观察当前 revision → 乐观锁校验 → patch 校验 → no-op 短路
 * （合并结果与当前生效 config 全等则不写、不递增）→ configEditor.edit 合并写
 * （next = fresh config ∪ patch，未知原键原样保留；等于继承层时由宿主整行删
 * 除覆盖行，dsh-config-editor/lib/index.js:93-104）→ 成功后返回新快照（指纹
 * 变化 → revision +1）。
 *
 * W6：edit 失败不再裸抛宿主原生 Error（此前锁超时/激活回滚等错误绕开
 * onebot-settings/* 错误码体系直达网关，面板拿到的是英文技术文案）——按
 * describeEditFailure 归一为 onebot-settings/edit-failed 中文错误并保留 cause；
 * 失败路径 revision 不递增（指纹观察只在成功后的 buildSnapshot 发生）、不重试、
 * 不补偿写，patch 文件由宿主保证未被破坏（config-editor.md §3 矩阵）。 */
export async function updateSettings(editor, state, patch, expectedRevision) {
    const entry = findEntry(editor);
    const actual = observeRevision(state, entry.options.config ?? {});
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision !== actual)) {
        throw new RemoteError('onebot-settings/conflict', `expectedRevision ${String(expectedRevision)} does not match current revision ${actual}; re-read getSettings() and replay`, { expected: expectedRevision, actual });
    }
    const clean = validatePatch(patch);
    const current = entry.options.config ?? {};
    // memberTools (#59)：面板键扁平（memberTools），宿主配置嵌套（permissions.memberTools）。
    // 写入侧重组进 permissions 对象并与现状合并（permissions 现仅此一键）；
    // notices 同属「面板扁平键 ↔ 嵌套对象」特例。
    if (typeof clean.memberTools === 'string') {
        const currentPermissions = (typeof current.permissions === 'object' && current.permissions !== null ? current.permissions : {});
        clean.permissions = { ...currentPermissions, memberTools: clean.memberTools };
        delete clean.memberTools;
    }
    const merged = { ...current, ...clean };
    if (isDeepStrictEqual(merged, current))
        return buildSnapshot(entry, state); // no-op：不递增（§3.1 #4）
    try {
        await editor.edit(entry, (fresh) => {
            // 观察窗口内 permissions 若被并发写入，以 fresh 为底再合并一次防丢键。
            if (typeof fresh.permissions === 'object' && fresh.permissions !== null && typeof clean.permissions === 'object' && clean.permissions !== null) {
                return { ...fresh, ...clean, permissions: { ...fresh.permissions, ...clean.permissions } };
            }
            return { ...fresh, ...clean };
        });
    }
    catch (cause) {
        // W6 错误归一：只翻译、不重试、不补偿写；宿主已保证 patch 文件未被破坏或已逐字节还原。
        // details 带宿主原文（可跨网关序列化），cause 仅进程内诊断。
        throw new RemoteError(EDIT_FAILED_CODE, describeEditFailure(cause), { hostMessage: cause instanceof Error ? cause.message : String(cause) }, { cause });
    }
    return buildSnapshot(findEntry(editor), state);
}
/** 组装 descriptor 方法对象（测试与降级类共用；与类方法同一实现）。
 *  W7：workspaceRegistry 可选注入——省略时 listWorkspaces 降级 unavailable
 *  （与类分支的惰性 ctx 解析同一 listWorkspaces 纯函数出口）。 */
export function createOnebotSettingsMethods(editor, state = createRevisionState(), workspaceRegistry) {
    return {
        getSettings: () => getSettings(editor, state),
        updateSettings: (patch, expectedRevision) => updateSettings(editor, state, patch, expectedRevision),
        listWorkspaces: async () => listWorkspaces(workspaceRegistry),
    };
}
/** 把 typert-protocol 的 Remote 标记应用到类原型（无原生装饰器语法的 shim，
 *  照抄 dsh-expert-orchestrator/lib/remote.js:99-115；mark() 对同一原型幂等）。 */
function markRemote(klass, methodName) {
    if (!protocol?.Remote)
        return;
    const initializers = [];
    const decorator = protocol.Remote(methodName);
    decorator(undefined, {
        name: methodName,
        private: false,
        static: false,
        addInitializer(fn) { initializers.push(fn); },
    });
    const receiver = Object.create(klass.prototype);
    for (const fn of initializers)
        fn.call(receiver);
}
/** 服务装配：协议在位 → TypertRemoteService 子类（网关按 typertRemote 绑定 +
 *  原型 descriptor 发现）；否则降级为普通 cordis 服务（同名方法面，仅无网关
 *  发现）。两个分支共用上方导出的实现函数与同一 descriptor 形状。 */
// 显式 any：两个分支的类形状在运行期二选一，降级分支没有 Service 基类可声明。
let OnebotSettingsService;
if (protocol?.TypertRemoteService) {
    class OnebotSettingsRemote extends protocol.TypertRemoteService {
        static inject = ['configEditor', 'profileContext'];
        state = createRevisionState();
        /** Service 基类的 ctx 为 protected 且跨包声明，此处自存一份只读引用供惰性解析。 */
        ownerCtx;
        constructor(ctx) {
            super(ctx, NAMESPACE);
            this.ownerCtx = ctx;
        }
        /** 惰性解析宿主 configEditor（static inject 保证在位；运行期再校验形状）。 */
        configEditor() {
            return requireConfigEditor(this.ownerCtx);
        }
        async getSettings() {
            return getSettings(this.configEditor(), this.state);
        }
        async updateSettings(patch, expectedRevision) {
            return updateSettings(this.configEditor(), this.state, patch, expectedRevision);
        }
        /** W7：只读查询宿主 workspace 注册表（惰性解析，缺席降级 unavailable，不抛错）。 */
        async listWorkspaces() {
            return listWorkspaces(resolveWorkspaceRegistry(this.ownerCtx));
        }
    }
    markRemote(OnebotSettingsRemote, 'getSettings');
    markRemote(OnebotSettingsRemote, 'updateSettings');
    markRemote(OnebotSettingsRemote, 'listWorkspaces');
    OnebotSettingsService = OnebotSettingsRemote;
}
else {
    console.warn('[dsh-onebot] @deepseek-ai/dsh-typert-protocol unavailable — onebotSettings remote degrades to a plain cordis service');
    class OnebotSettingsPlain {
        static inject = ['configEditor', 'profileContext'];
        name = NAMESPACE;
        state = createRevisionState();
        ctx;
        constructor(ctx) {
            this.ctx = ctx;
        }
        configEditor() {
            return requireConfigEditor(this.ctx);
        }
        getSettings() {
            return getSettings(this.configEditor(), this.state);
        }
        async updateSettings(patch, expectedRevision) {
            return updateSettings(this.configEditor(), this.state, patch, expectedRevision);
        }
        /** W7：与 typert 分支同一惰性解析 + 降级语义。 */
        async listWorkspaces() {
            return listWorkspaces(resolveWorkspaceRegistry(this.ctx));
        }
    }
    OnebotSettingsService = OnebotSettingsPlain;
}
export default OnebotSettingsService;
export { OnebotSettingsService };
