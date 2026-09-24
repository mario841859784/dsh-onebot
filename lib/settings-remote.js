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
/** 快照固定值：19 键均为插件级热重启生效（T1 §5）。 */
export const REMOTE_EFFECT = 'restart';
/** 设置页 UI 三组 19 键（T1 §4；与 src/index.ts Config schema 一一对应）。 */
export const SETTINGS_GROUPS = {
    connection: ['mode', 'host', 'port', 'url', 'accessToken', 'botQQ'],
    permissions: ['requireMention', 'adminUsers', 'dmPolicy', 'groupPolicy', 'allowAllUsers', 'allowFrom', 'groupAllowFrom'],
    behavior: ['interimMessages', 'interimRecall', 'interimRecallMs', 'sendErrorNotice', 'unknownCommand', 'rateLimitPerMinute'],
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
const BOOLEAN_KEYS = ['requireMention', 'allowAllUsers', 'interimMessages', 'interimRecall', 'sendErrorNotice'];
const STRING_KEYS = ['host', 'url', 'accessToken', 'botQQ'];
const STRING_ARRAY_KEYS = ['adminUsers', 'allowFrom', 'groupAllowFrom'];
/** 全部 19 键（校验与快照的唯一键集；4 枚举 + 3 数字 + 5 布尔 + 4 字符串 + 3 字符串数组）。 */
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
/** 19 键生效值 = schema 默认值 ← 条目 config 覆盖（T1 §3 合并优先级一句话）。 */
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
/** updateSettings 入参校验（T1 §4：19 键的任意子集，扁平 JSON）。未知键整单
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
            issues.push(`未知设置键 "${key}"（仅支持 19 键：${ALL_KEYS.join(', ')}）`);
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
/** updateSettings 实现（descriptor 参数 (patch, expectedRevision)，全 positional）。
 *
 * 流程：定位条目 → 观察当前 revision → 乐观锁校验 → patch 校验 → no-op 短路
 * （合并结果与当前生效 config 全等则不写、不递增）→ configEditor.edit 合并写
 * （next = fresh config ∪ patch，未知原键原样保留；等于继承层时由宿主整行删
 * 除覆盖行，dsh-config-editor/lib/index.js:93-104）→ 成功后返回新快照（指纹
 * 变化 → revision +1）。 */
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
    await editor.edit(entry, (fresh) => ({ ...fresh, ...clean }));
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
