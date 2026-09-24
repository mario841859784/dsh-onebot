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
/** patch insert 中 dsh-onebot 主条目的 id（T1 §2/§3：唯一持久层条目）。 */
export declare const ENTRY_ID = "dsh-onebot";
/** Typert Remote 命名空间 = cordis 服务键（T1 §4）。 */
export declare const NAMESPACE = "onebotSettings";
/** 快照固定值：19 键均为插件级热重启生效（T1 §5）。 */
export declare const REMOTE_EFFECT = "restart";
/** 设置页 UI 三组 19 键（T1 §4；与 src/index.ts Config schema 一一对应）。 */
export declare const SETTINGS_GROUPS: Readonly<Record<string, readonly string[]>>;
/** schema 默认值（T1 §4 表；摘自 src/index.ts:171-245），快照生效值的底层。 */
export declare const SCHEMA_DEFAULTS: Readonly<Record<string, unknown>>;
/** 快照返回侧脱敏的键（T1 §3 敏感字段行；写入侧明文落盘属宿主既有行为）。 */
export declare const SECRET_KEYS: readonly string[];
/** 全部 19 键（校验与快照的唯一键集；4 枚举 + 3 数字 + 5 布尔 + 4 字符串 + 3 字符串数组）。 */
export declare const ALL_KEYS: readonly string[];
/** OnebotSettingsSnapshot（T1 §3 快照结构）。 */
export interface OnebotSettingsSnapshot {
    /** §3.1 乐观锁计数器。 */
    revision: number;
    /** dsh-onebot 条目 fiber 是否 active（fiber.state === 2，同 configEditor.edit 的活性判据）。 */
    entryActive: boolean;
    /** 19 键生效值；accessToken 脱敏为 ''。 */
    config: Record<string, unknown>;
    /** 脱敏键标记：明文是否已配置。 */
    secrets: Array<{
        path: string[];
        set: boolean;
    }>;
    groups: Record<string, string[]>;
    effect: typeof REMOTE_EFFECT;
}
/** §3.1 revision 计数器状态（内存态，随宿主进程/服务实例存续）。 */
export interface RevisionState {
    revision: number;
    /** 上次观察到的 entry.options.config 序列化指纹；null = 尚未建立基线。 */
    fingerprint: string | null;
}
/** configEditor（dsh-config-editor）本模块实际消费的最小面。 */
export interface ConfigEditorEntry {
    options: {
        id?: string;
        name?: string;
        config?: Record<string, unknown>;
    };
    fiber?: {
        state?: number;
    } | undefined;
}
export interface ConfigEditorLike {
    entries(): readonly ConfigEditorEntry[];
    edit(entry: ConfigEditorEntry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>;
}
export declare function createRevisionState(): RevisionState;
/** §3.1 #2：读侧观察——config 指纹相对上次有差异即 +1（任何来源的已提交变更
 *  一视同仁）；首次调用仅建立基线不递增。 */
export declare function observeRevision(state: RevisionState, config: unknown): number;
/** 19 键生效值 = schema 默认值 ← 条目 config 覆盖（T1 §3 合并优先级一句话）。 */
export declare function effectiveConfig(raw: Record<string, unknown>): Record<string, unknown>;
/** updateSettings 入参校验（T1 §4：19 键的任意子集，扁平 JSON）。未知键整单
 *  拒绝（不静默丢弃）；类型/枚举不符拒绝；具体取值合法性交由宿主 schemastery
 *  校验 + reconcile 失败自动回滚兜底（T1 §5）。 */
export declare function validatePatch(patch: unknown): Record<string, unknown>;
/** getSettings 实现（descriptor 方法体共用；descriptor 参数 0 个）。 */
export declare function getSettings(editor: ConfigEditorLike, state: RevisionState): OnebotSettingsSnapshot;
/** updateSettings 实现（descriptor 参数 (patch, expectedRevision)，全 positional）。
 *
 * 流程：定位条目 → 观察当前 revision → 乐观锁校验 → patch 校验 → no-op 短路
 * （合并结果与当前生效 config 全等则不写、不递增）→ configEditor.edit 合并写
 * （next = fresh config ∪ patch，未知原键原样保留；等于继承层时由宿主整行删
 * 除覆盖行，dsh-config-editor/lib/index.js:93-104）→ 成功后返回新快照（指纹
 * 变化 → revision +1）。 */
export declare function updateSettings(editor: ConfigEditorLike, state: RevisionState, patch: unknown, expectedRevision?: number): Promise<OnebotSettingsSnapshot>;
/** 组装 descriptor 方法对象（测试与降级类共用；与类方法同一实现）。 */
export declare function createOnebotSettingsMethods(editor: ConfigEditorLike, state?: RevisionState): {
    getSettings(): Promise<OnebotSettingsSnapshot> | OnebotSettingsSnapshot;
    updateSettings(patch: unknown, expectedRevision?: number): Promise<OnebotSettingsSnapshot>;
};
/** 服务装配：协议在位 → TypertRemoteService 子类（网关按 typertRemote 绑定 +
 *  原型 descriptor 发现）；否则降级为普通 cordis 服务（同名方法面，仅无网关
 *  发现）。两个分支共用上方导出的实现函数与同一 descriptor 形状。 */
declare let OnebotSettingsService: any;
export default OnebotSettingsService;
export { OnebotSettingsService };
