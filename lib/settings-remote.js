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
/** 快照固定值：25 键均为插件级热重启生效（T1 §5；W1/W2 新增 6 布尔键同粒度）。 */
export const REMOTE_EFFECT = 'restart';
/** 设置页 UI 四组 25 键（T1 §4；与 src/index.ts Config schema 一一对应）。
 *  W6：permissions/behavior 三组 19 键保持不动，W1/W2 的 6 个布尔键独立成
 *  「diagnostics（诊断）」组——它们全部默认关（除 actionAuditEnabled 默认开）、
 *  属观测/调试面，与连接权限行为组的使用频率与风险等级都不同，独立分组让
 *  「默认全关的调试开关」一眼可辨（对齐竞品 v0.6.0 面板的开关分组话术）。 */
export const SETTINGS_GROUPS = {
    connection: ['mode', 'host', 'port', 'url', 'accessToken', 'botQQ'],
    permissions: ['requireMention', 'adminUsers', 'dmPolicy', 'groupPolicy', 'allowAllUsers', 'allowFrom', 'groupAllowFrom'],
    behavior: ['interimMessages', 'interimRecall', 'interimRecallMs', 'sendErrorNotice', 'unknownCommand', 'rateLimitPerMinute'],
    diagnostics: ['actionAuditEnabled', 'traceEnabled', 'recordInbound', 'inboxRedact', 'injectEnabled', 'injectDryRun'],
};
/** schema 默认值（T1 §4 表；摘自 src/index.ts:171-245），快照生效值的底层。 */
export const SCHEMA_DEFAULTS = {
    mode: 'reverse',
    host: '127.0.0.1',
    port: 8643,
    url: 'ws://127.0.0.1:3001',
    accessToken: '',
    botQQ: '',
    requireMention: true,
    adminUsers: [],
    dmPolicy: 'open',
    groupPolicy: 'open',
    allowAllUsers: false,
    allowFrom: [],
    groupAllowFrom: [],
    interimMessages: true,
    interimRecall: true,
    interimRecallMs: 90_000,
    sendErrorNotice: true,
    unknownCommand: 'intercept',
    rateLimitPerMinute: 30,
    // W6：W1/W2 可观测/调试布尔键（schema 默认值摘自 src/index.ts:297-317）。
    actionAuditEnabled: true,
    traceEnabled: false,
    recordInbound: false,
    inboxRedact: false,
    injectEnabled: false,
    injectDryRun: true,
};
/** 快照返回侧脱敏的键（T1 §3 敏感字段行；写入侧明文落盘属宿主既有行为）。 */
export const SECRET_KEYS = ['accessToken'];
const ENUM_KEYS = {
    mode: ['reverse', 'forward'],
    dmPolicy: ['open', 'allowlist', 'disabled'],
    groupPolicy: ['open', 'allowlist', 'disabled'],
    unknownCommand: ['intercept', 'passthrough'],
};
const NUMBER_KEYS = ['port', 'interimRecallMs', 'rateLimitPerMinute'];
/** 数字键取值范围（评审 B4：port 1–65535、时长/频控 ≥0；越界在 Remote 层拒绝，不再只依赖宿主回滚兜底）。 */
const NUMBER_RANGE = {
    port: [1, 65535],
    interimRecallMs: [0, undefined],
    rateLimitPerMinute: [0, undefined],
};
/** 布尔键白名单（T1 §4 + W6 扩展：W1/W2 观测/调试 6 键入列；顺序与
 *  SETTINGS_GROUPS.diagnostics 一致。数值键 dedupWindowSeconds/actionRatePerMinute/
 *  actionRatePerDay/injectIntervalMs 与枚举键 traceLevel 本期不入 UI 白名单——
 *  面板仅布尔开关与既有 19 键，调优键仍走 patch config 手改，取舍见 DEVLOG W6）。 */
const BOOLEAN_KEYS = [
    'requireMention', 'allowAllUsers', 'interimMessages', 'interimRecall', 'sendErrorNotice',
    'actionAuditEnabled', 'traceEnabled', 'recordInbound', 'inboxRedact', 'injectEnabled', 'injectDryRun',
];
const STRING_KEYS = ['host', 'url', 'accessToken', 'botQQ'];
const STRING_ARRAY_KEYS = ['adminUsers', 'allowFrom', 'groupAllowFrom'];
/** 全部 25 键（校验与快照的唯一键集；4 枚举 + 3 数字 + 11 布尔 + 4 字符串 + 3 字符串数组）。 */
export const ALL_KEYS = [
    ...Object.keys(ENUM_KEYS), ...NUMBER_KEYS, ...BOOLEAN_KEYS, ...STRING_KEYS, ...STRING_ARRAY_KEYS,
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
/** 25 键生效值 = schema 默认值 ← 条目 config 覆盖（T1 §3 合并优先级一句话）。 */
export function effectiveConfig(raw) {
    const effective = {};
    for (const key of ALL_KEYS) {
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
/** updateSettings 入参校验（T1 §4：25 键的任意子集，扁平 JSON）。未知键整单
 *  拒绝（不静默丢弃）；类型/枚举不符拒绝；具体取值合法性交由宿主 schemastery
 *  校验 + reconcile 失败自动回滚兜底（T1 §5）。 */
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
    const merged = { ...current, ...clean };
    if (isDeepStrictEqual(merged, current))
        return buildSnapshot(entry, state); // no-op：不递增（§3.1 #4）
    try {
        await editor.edit(entry, (fresh) => ({ ...fresh, ...clean }));
    }
    catch (cause) {
        // W6 错误归一：只翻译、不重试、不补偿写；宿主已保证 patch 文件未被破坏或已逐字节还原。
        // details 带宿主原文（可跨网关序列化），cause 仅进程内诊断。
        throw new RemoteError(EDIT_FAILED_CODE, describeEditFailure(cause), { hostMessage: cause instanceof Error ? cause.message : String(cause) }, { cause });
    }
    return buildSnapshot(findEntry(editor), state);
}
/** 组装 descriptor 方法对象（测试与降级类共用；与类方法同一实现）。 */
export function createOnebotSettingsMethods(editor, state = createRevisionState()) {
    return {
        getSettings: () => getSettings(editor, state),
        updateSettings: (patch, expectedRevision) => updateSettings(editor, state, patch, expectedRevision),
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
    }
    markRemote(OnebotSettingsRemote, 'getSettings');
    markRemote(OnebotSettingsRemote, 'updateSettings');
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
    }
    OnebotSettingsService = OnebotSettingsPlain;
}
export default OnebotSettingsService;
export { OnebotSettingsService };
