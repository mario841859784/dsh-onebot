# 设置页配置打通设计定案（T1 技术验证）

> 任务：dsh-onebot v0.4.3-next / R2 设置页 UI —— 宿主热加载语义考证 + A/B/C 路径定案。
> 方法：只读考证宿主 0.1.7-alpha.2 源码（`/vol2/@appcenter/Harness/server/node_modules/@deepseek-ai/*`），
> 全部结论附文件路径+行号；本任务不改任何插件代码，本文件是唯一新增产物。
> 结论供 T2（README 措辞）、T3（host Remote）、T4（客户端 UI）、T5（双语文档）直接引用。

---

## 1. 宿主「热加载 patch config」真实语义（源码钉死）

### 1.1 运行链路（谁在监视、谁在应用）

1. **hmr 服务由 dsh-base bundle 常驻挂载**：`dsh-base/cordis.patch.yml:28-32` 以
   `- id: hmr / name: '@deepseek-ai/dsh-hmr'` 挂入，`disabled: !!js "!ctx.get('profileContext')"`
   —— profile 形态（`dsh web` 即 profile `web`）恒启用。服务名 `hmr`
   （`dsh-hmr/lib/index.js:314` `super(ctx, "hmr")`）。
2. **被监视的 patch 文件恰好两个**：profile 层 `<DSH_HOME>/profiles/web/cordis.patch.yml`
   与 home 层 `<DSH_HOME>/cordis.patch.yml`（`dsh-hmr/lib/index.js:354`
   `const patchFiles = [profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)]`），
   经 `watchConfig`（同文件 :45-102，chokidar 精确路径监视，:80-82 add/change/unlink 均触发）。
   **bundle 自带的 cordis.patch.yml、仓库内的 patch 模板、部署副本的文件都不在监视范围**。
3. **变更 → 全量重组 + reconcile**：任一被监视文件变化 → `refresh(false)`
   （:366-373）：先做内容指纹比对（`inputs === lastInputs` 时跳过，:367-372——
   **touch 同内容文件是 no-op，什么都不发生**），再 `readProfilePatches("dsh", profile)`
   全量重组（bundle 层 + profile 层 + home 层 + overlays，
   `dsh-app-boot/lib/index.js:1014-1029`），最后 `reconcileProfilePatches`（:370）。
4. **reconcile = 根 Include 条目 config 更新**：`reconcileProfilePatches`
   （`dsh-app-boot/lib/index.js:3451-3484`）取根 Include 条目，把新补丁列表并入其 config
   并 `entry.update({config:{...includeConfig, patches: prepared}})`（:3467-3470）。
5. **Include 收到 config 更新 → 重放补丁**：`ctx.on("internal/update", …)` 处理器
   （`dsh-app-boot/lib/index.js:134-141`，与 `cordis-plugin-include/lib/index.js:129-138` 同源）
   用**缓存的基础配置数据** `this.data` 重新执行 `applyPatches(data, config.patches)`
   —— 即 `applyEntryPatches`（`cordis-plugin-include/lib/index.js:56-113`）：
   对已有 id 做 `target[key] = value` **整体覆盖**（:104-107，config 是整键替换，不是深合并）；
   `insert` 条目追加进目标组并加入索引（:69-91，后到的 patch 可命中先到的 insert）。
6. **按 id 差分落到运行树**：`EntryGroup.update(config)`
   （`cordis-plugin-loader/lib/index.js:78-92`）新旧按 id 差分——
   新 id → `create()`（:58-68，初始化条目并 import 插件模块）；消失的 id → `remove()`
   （:70-76，dispose fiber）；同 id 新 options → `Entry.update(options, true, true)`
   （:365-390）。
7. **Entry.update 的两条生效路径**（`cordis-plugin-loader/lib/index.js:380-388`）：
   - 仅 volatile 字段变化 → `_commitVolatile()`（:393-425）**原位热提交**，
     fiber 不重启，`loader/volatile-update` 事件（:420）更新运行中的引用；
   - 含普通（非 volatile）字段变化 → `loader/partial-dispose`（:384）+
     `fiber.update(config, true)`（:385 经 `_patchContext` :318-322）——
     **插件 fiber 原地重启**（dispose 后按新 config 重新 init），宿主进程不重启。

### 1.2 语义矩阵（结论表）

| # | 变更类型 | 是否热生效 | 生效方式 | 依据（文件:行） |
|---|---|---|---|---|
| 1 | 同 id 条目 **config 覆盖**（改 profile 层 cordis.patch.yml 中已有条目的 config） | ✅ 热生效 | hmr 监视→reconcile→applyPatches 重放→插件 fiber **秒级原地重启**（volatile-only 时原位提交，不重启） | dsh-hmr/lib/index.js:354,366-373,375；dsh-app-boot/lib/index.js:3467-3470；cordis-plugin-include/lib/index.js:104-107；cordis-plugin-loader/lib/index.js:380-388 |
| 2 | **insert 新增**（新增条目行） | ✅ 热生效 | 同一路径；`EntryGroup.update` 对新 id `create()`：初始化条目并 import 插件模块（等价于挂载一个新插件，含失败即报错） | cordis-plugin-loader/lib/index.js:78-92,58-68；dsh-hmr/lib/index.js:366-373 |
| 3 | **insert 删除**（移除条目行） | ✅ 热生效 | 同一路径；消失的 id `remove()` → fiber dispose（插件卸载） | cordis-plugin-loader/lib/index.js:78-92,70-76 |
| 4 | touch / 改写 patch 文件但**内容指纹未变** | ❌ no-op | `inputs === lastInputs` 直接返回，不触发 reconcile | dsh-hmr/lib/index.js:367-372 |
| 5 | 改 **bundle 自带 patch / 仓库模板 / 部署副本** 的 patch 文件 | ❌ 不热 | 不在监视列表；bundle 层补丁只在某个被监视文件触发 refresh 时随 `readProfilePatches` 顺带重读 | dsh-hmr/lib/index.js:354；dsh-app-boot/lib/index.js:1014-1029 |
| 6 | 改 profile 根配置 `cordis.yml` | ❌ 不热 | 根配置文件不在 watchConfig 注册列表；其 `refresh()`（cordis-plugin-include/lib/index.js:196-206）无触发者；文件头注释即「Edit cordis.patch.yml, not this file」 | dsh-hmr/lib/index.js:354,375；dsh-app-boot/lib/index.js:201-215 |
| 7 | 新 insert 的插件**激活失败**（如 peer 缺失） | ⚠️ 热应用但条目失活 | `reconcileProfilePatches` 在激活诊断中发现「新增失活」即 throw（dsh-app-boot/lib/index.js:3472-3482）；补丁变更已应用、条目存在但 inactive，等待重启重试 | dsh-app-boot/lib/index.js:3472-3482 |
| 8 | 同一插件文件被 **insert 两次** | ⚠️ 危险 | 同一模块 URL 二次挂载产生双实例 → 工具/服务注册冲突崩溃循环（生产实测事故） | dsh-expert-orchestrator 同款锚定注释；dsh-onebot DEVLOG.md:70 |

**对「insert 新增不热生效」历史实测记录的解释**（DEVLOG/PM 事实表 #2 vs 上述源码）：
语义 #2 在源码层成立。实测未观察到热生效的三种可复现成因均已被钉死：
(a) 编辑发生在**未被监视的文件**（仓库 patch 模板/部署副本/bundle 自带 patch，见 #5）；
(b) 新插件**激活失败**（peer 缺失等）使条目失活、表现为「没生效」（#7）；
(c) 把新条目指向**已在运行的同一路径**触发双实例冲突（#8）。
三者都不是「宿主不热应用 insert」，措辞结论以本矩阵为准。

### 1.3 宿主 settings 管线的真实现状（推翻任务书前提③）

- 0.1.7-alpha.2 的宿主设置页**不再写 settings.yaml 顶层键**。`settings.yaml` 是遗留物：
  启动时 `importLegacyDocument`（`dsh-settings/lib/index.js:346-365`）把
  `<DSH_HOME>/settings.yaml` **改名**为 `settings.yaml.imported` 并把每个 section
  尝试导入对应条目的 config，然后该文件永久消失。
- 现行持久层就是 **profile patch 中按条目 id 的 config 覆盖行**：
  设置服务经 `dsh-config-editor` 的 `edit()`（`dsh-config-editor/lib/index.js:63-123`）
  把用户改动写成 patch 覆盖行（同 id 行 findLastIndex 就地更新 :86-104；
  `writeFileAtomic` 原子写 :117），随即 `reconcileProfilePatches` 热生效（:118-123），
  激活失败自动**回滚 patch 文件并 reconcile 回旧值**（:119-122）。
  编辑全程在 `hmr.runExclusive` 内串行（:127-128）。
- 设置页 API 本身就是一个现成的 Remote：`settingsController` 挂
  `namespace: "settings"`（`dsh-api-settings-controller/lib/index.js:382`），
  提供 describe/update/replace/mutate（:394-438）+ `expectedRevision` 乐观锁
  （写冲突抛 `SettingsConflictError`，`dsh-settings/lib/index.js:511`）。
  但它只允许写 **volatile 字段**（`dsh-settings/lib/index.js:502-513` 的
  `isVolatilePath` 门禁），且 dsh-onebot 当前 Config 无任何 volatile 字段
  （src/index.ts:171-268 无 `.volatile()`），运行时也以 apply 期快照方式消费 config
  （src/index.ts:319-356，`resolveDeprecatedConfig` 拷贝 + 构造期闭包捕获）。

---

## 2. 路径裁决：A / B / C

### 裁决：**采用 B**（独立 host-plane Typert Remote + 经 configEditor 改 patch 覆盖行，依赖 §1 已钉死的热重载语义）

### A) settings.yaml 独立顶层键 + 插件 mount 读取/热重载回调 —— ❌ 否决

1. **宿主已拆除该扩展点**：settings.yaml 在本版本会被改名吞掉（§1.3，
   dsh-settings/lib/index.js:346-365），顶层键 `onebot-settings` 的下场是
   「被当遗留 section 导入 → 报 `No configurable plugin entry` → 文件被改名」。
   在它上面建持久层等于建在宿主明确废弃的载体上。
2. **双持久层无合并语义**：patch config 与顶层键互不感知，设置页值与 patch 值
   冲突时无任何宿主机制裁决；「谁覆盖谁」要自己发明并永久维护。
3. **无热通道**：settings.yaml 无监视者（§1.1 第 2 条只监视两个 patch 文件），
   插件侧要么自建文件 watcher（插件内嵌 chokidar、与宿主 hmr 抢写竞态），
   要么接受「改完要重启」，两头都劣于 B。
4. 任务书前提③（`ctx.settings.installSection/mutate` 写顶层键）与本宿主版本事实不符
   （§1.3），A 的立论基础已消失。

### B) 独立 host-plane Remote 改 patch 覆盖行，依赖热重载 —— ✅ 采纳

1. **语义已钉死**：config 覆盖 / insert 新增 / insert 删除全部热生效（§1.2 #1-#3），
   B 依赖的正是宿主自身设置页在同版本走的唯一写路径（dsh-config-editor.edit，
   §1.3）——与宿主同构，不发明新机制。
2. **热生效边界清晰**：变更以「插件 fiber 秒级原地重启」落地（§1.2 #1），
   宿主进程不重启；QQ 桥短暂断开由 NapCat ws-reverse 自动重拨补齐
   （dsh-onebot B5 重连实现，DEVLOG.md:144）。
3. **单一代价、明确可见**：每次保存触发一次插件重启（内存态如频控窗口清零、
   在途回合中断）——见 §5 矩阵，写入文档与 UI 提示。
4. **写入自带安全网**：原子写、文件锁、hmr 串行、失败自动回滚 patch 并还原
   （dsh-config-editor/lib/index.js:63-123）。

### C) 插件自身暴露 Remote —— ❌ 否决

1. **致命：写操作杀死自身**。Remote 若挂在 dsh-onebot 条目自己的 fiber 内，
   `updateSettings` → configEditor.edit → reconcile → `Entry.update` 检出 config
   变化 → `loader/partial-dispose`（cordis-plugin-loader/lib/index.js:384）
   **disposal 的正是正在执行本次 RPC 的那个 fiber**——保存请求必然自毁，
   每次保存都在和自己的销毁竞速。
2. 省一个 host-plane 行的收益不抵上述风险；且 Remote 生命周期与连接重启耦合
   （连接参数变更重启插件 = Remote 一并重启），可用性劣于 B。
3. B 的 host-plane 行成本仅 patch 模板一行 + 一个小 JS 模块
   （参考实现 dsh-expert-orchestrator/cordis.patch.yml:46-48 的
   `expert-sources-remote` 行 + lib/remote.js 共 199 行，含降级路径）。

### B 的落地形态（T3 照此实现）

- patch 行（部署到 profile 层 cordis.patch.yml 的 insert 列表内，与 dsh-onebot 同一 insert 块）：

  ```yaml
  - insert:
      - id: dsh-onebot
        name: '/vol2/@appshare/Harness/dsh-plugins/dsh-onebot/lib/index.js'
        config: { …现网连接/权限参数… }
      - id: onebot-settings-remote
        name: '/vol2/@appshare/Harness/dsh-plugins/dsh-onebot/lib/settings-remote.js'
  ```

- **必须用绝对路径 name**：T4 给 package.json 增加 `"./client"` exports 后，包导出表会
  遮蔽 `dsh-onebot/lib/settings-remote.js` 这类裸深路径；宿主只对相对名做
  `anchorInsertedPluginNames` 锚定（dsh-app-boot/lib/index.js:3520-3527，锚到 patch
  文件所在目录=profile 目录，对绝对路径不处理）。现网 dsh-onebot 行已是绝对路径，沿用。
- **两个条目严禁重复 insert 同一文件**（§1.2 #8）；settings-remote 是独立模块文件、独立 id，
  与 dsh-onebot 主条目互不影响。
- Remote 服务骨架照抄 dsh-expert-orchestrator/lib/remote.js:63-199 的契约：
  `@deepseek-ai/dsh-typert-protocol` 不可解析时降级为普通 cordis 服务而非炸掉插件加载。
- 服务声明 `static inject = ["configEditor", "profileContext"]`
  （与 dsh-config-editor/lib/index.js:18-19 同源可解析），从 `configEditor.entries()`
  按 `options.id === 'dsh-onebot'` 定位目标条目；条目不存在时返回明确错误
  （错误码 `onebot-settings/no-entry`），不得静默。

---

## 3. 持久化 schema（B 路径定案）

**没有新的顶层持久键。设置页的唯一持久层 = profile patch 中 `dsh-onebot` 条目
的 config 覆盖行**（与手改 patch、宿主原生设置页三方同源，天然无优先级冲突）。

| 项 | 定案 |
|---|---|
| 文件 | `<DSH_HOME>/profiles/web/cordis.patch.yml`（`DSH_HOME` 解析：`DSH_HOME` 环境变量优先，否则 `~/.dsh`；dsh-home-paths/lib/index.js:73-81。本机实际 `/vol2/@appshare/Harness/.dsh/profiles/web/cordis.patch.yml`） |
| 行形态 | `-{ id: dsh-onebot, name: <绝对路径 file URL/路径>, config: { … } }` |
| 覆盖语义 | config **整键替换**、后层胜前层（applyEntryPatches `target[key]=value`，cordis-plugin-include/lib/index.js:104-107；dsh-base/cordis.patch.yml:4-6 头注释同义）。Remote 写入时按 configEditor.edit 的 `(raw, inherited)` 语义维护**唯一权威覆盖行**：`next = mergeLayers(当前覆盖行快照, 本次改动)`，等价 inherited 时整行删除（dsh-config-editor/lib/index.js:86-104） |
| UI 键集 | 仅 §4 三组 19 键；media/STT/性能等低频键**不设 UI**，仍在同一行 config 手改（README/宿主原生 patch 编辑器），单一来源、无第二优先级 |
| 合并优先级（一句话） | **schema 默认值 ← bundle/底层 patch（继承层） ← profile 覆盖行（设置页写这里）**；同一层内后写的 patch 条目胜出。设置页键与手改 patch 是同一层的同一行，不存在两套优先级 |
| 敏感字段 | `accessToken` 保持 `role('secret')`（src/index.ts:178）：快照返回侧脱敏（值置空 + `secrets` 标记，脱敏算法对齐 dsh-settings `redactSecrets`，dsh-settings/lib/index.js:74-100）；写入侧 patch 文件明文落盘（宿主既有管道默认行为，加密存储范围外） |

**快照结构（Remote 返回值）**：

```
OnebotSettingsSnapshot {
  revision: number              // §3.1 乐观锁
  entryActive: boolean          // dsh-onebot 条目 fiber 是否 active
  config: object                // 19 键生效值；accessToken 脱敏为 ""
  secrets: [{ path: ["accessToken"], set: boolean }]
  groups: {
    connection:  ["mode","host","port","url","accessToken","botQQ"],
    permissions: ["requireMention","adminUsers","dmPolicy","groupPolicy",
                  "allowAllUsers","allowFrom","groupAllowFrom"],
    behavior:    ["interimMessages","interimRecall","interimRecallMs",
                  "sendErrorNotice","unknownCommand","rateLimitPerMinute"]
  }
  effect: "restart"             // 本设计下 19 键统一为插件级热重启（§5）
}
```

### 3.1 乐观锁 revision 语义

对齐宿主设置服务 `SettingsForms.revisions` 的既有语义（dsh-settings/lib/index.js:420-431,455）：

1. **作用域**：每宿主进程、每 `dsh-onebot` 条目一个计数器，host 启动时从 0 开始
   （内存态，不持久化——客户端每回合以 `getSettings()` 重新取值，与原生设置页一致）。
2. **递增条件**：Remote 读侧每次调用时序列化 `entry.options.config` 与上次指纹比较
   （同 ：424-431 的 raw 字符串比对），**任何来源**的已提交变更都 +1——
   本 Remote 写入、宿主原生设置页、HMR reconcile 后的手改 patch，一视同仁。
3. **乐观锁校验**：`updateSettings(patch, expectedRevision)` 的 `expectedRevision`
   ≠ 当前值 → 拒写，抛 `RemoteError("onebot-settings/conflict", {expected, actual})`
   （语义同 `SettingsConflictError`，dsh-settings/lib/index.js:511）；客户端取新快照重放。
4. **不递增的情形**：写入被拒（校验失败/锁冲突/激活失败回滚）、no-op
   （合并结果与当前覆盖行全等）。
5. **失败不落半态**：写入经 configEditor.edit 的文件锁 + 原子写 + 失败回滚
   （dsh-config-editor/lib/index.js:63-123），revision 只在 reconcile 成功后提交。

---

## 4. Typert Remote 方法集 descriptor（全 positional，T3/T4 契约）

命名空间 `onebotSettings`（走 `validateName` 语法校验，dsh-typert-protocol/lib/index.js:274-279；
参考 `settingsController` 的 namespace 挂载方式，dsh-api-settings-controller/lib/index.js:382）。
宿主网关按描述符**位置序**调用，`methodParameterNames` 拒绝解构/默认值/rest
（dsh-api-gateway/lib/index.js:1458-1495）——所有方法一律裸标识符位置参数：

| 方法（descriptor 顺序） | 参数（positional） | 返回 | 语义 |
|---|---|---|---|
| `getSettings()` | — | `OnebotSettingsSnapshot` | 读快照：revision + 脱敏生效配置 + 分组 + 条目活性 |
| `updateSettings(patch, expectedRevision)` | `patch: object`（§3 groups 中 19 键的任意子集，扁平 JSON）；`expectedRevision: number\|undefined` | `OnebotSettingsSnapshot` | 合并写：`next = mergeLayers(当前覆盖行, patch)`；`accessToken` 缺省=不改，`""`=清空；锁冲突抛 `onebot-settings/conflict`；成功后热生效（§5）并返回新快照 |

- 不设 `resetGroup`/`mutate(ops)`：组内重置=UI 以 schema 默认值显式下发
  （默认值表见下），路径级 ops 是宿主原生页的需求，本 UI 用不上（YAGNI）。
- 三组键、类型与 schema 默认值（T4 渲染与重置的唯一来源；摘自 src/index.ts:171-268）：

  | 组 | 键：类型 = 默认 |
  |---|---|
  | connection | `mode: 'reverse'\|'forward' = 'reverse'`；`host: string = '127.0.0.1'`；`port: number = 8643`；`url: string = 'ws://127.0.0.1:3001'`；`accessToken: string(secret) = ''`；`botQQ: string = ''` |
  | permissions | `requireMention: boolean = true`；`adminUsers: string[] = []`；`dmPolicy: 'open'\|'allowlist'\|'disabled' = 'open'`；`groupPolicy: 'open'\|'allowlist'\|'disabled' = 'open'`；`allowAllUsers: boolean = false`；`allowFrom: string[] = []`；`groupAllowFrom: string[] = []` |
  | behavior | `interimMessages: boolean = true`；`interimRecall: boolean = true`；`interimRecallMs: number = 90000`；`sendErrorNotice: boolean = true`；`unknownCommand: 'intercept'\|'passthrough' = 'intercept'`；`rateLimitPerMinute: number = 30` |

- 客户端侧（T4）照抄 dsh-expert-orchestrator/lib/client.js 模式：CJS 包裹
  `window.__ModuleLoader__.load({id, factory:(require)=>{…}})`（:47）、
  `ctx.remote.$mount(TYPERT_REMOTE)`（:1789）后取 `remote.onebotSettings`、
  `ctx.slots.inject('settings.section', …)`（:1793-1795）、externals 仅 react。

---

## 5. 热生效 / 需重启边界矩阵（T5 文档措辞以此为准）

dsh-onebot 当前以 **apply 期快照**方式消费 config（src/index.ts:319-356：
`resolveDeprecatedConfig` 拷贝 + OneBotConnection/Transcriber 构造参数捕获），
无 volatile 字段，运行中不重读引用。因此定案：

| 变更 | 生效方式 | 生效时长 | 依据 |
|---|---|---|---|
| 设置页/手改 patch 改 **19 键中任意键**（含 connection 组） | **插件 fiber 原地热重启**（partial-dispose → 新 config 重新 init），宿主进程与 Web GUI 不重启 | 秒级；reverse 监听端口短暂重开、forward 重拨，NapCat 侧自动重连 | cordis-plugin-loader/lib/index.js:380-388；dsh-onebot B5 重连（DEVLOG.md:144） |
| 同一次写入仅含 schema 默认值无差异（no-op） | 不触发重启，revision 不变 | — | dsh-settings/lib/index.js:455 no-op 不递增；EntryGroup.update 等值不差分 |
| 写入导致插件激活失败（校验拒绝/依赖缺失） | patch 文件自动回滚到写前内容并 reconcile 还原，**旧配置继续运行** | — | dsh-config-editor/lib/index.js:118-123 |
| 19 键之外的键（media/STT/性能/agentPreset 等） | 手改同一覆盖行后同样热重启生效；或宿主原生 patch 编辑器改（同一管道） | 秒级 | §3 持久层同源；dsh-config-editor/lib/index.js:63-123 |
| 改 `lib/index.js`（插件代码） | 不在本设计范围；本设计的 19 键均不需要改代码 | — | 现网实测记录：HMR 只重应用配置快照、不重新 require 插件 JS（DEVLOG.md:94） |
| 改 profile 根配置 `cordis.yml` / bundle 自带 patch | 不热生效（§1.2 #5/#6）——本设计的读写全部绕开这两处 | — | dsh-hmr/lib/index.js:354 |

**给用户的代价说明（写入 T5）**：每次保存设置 = QQ 桥一次秒级重连；在途回合中断、
频控窗口与中间消息缓冲清零；会话映射/历史不受影响（会话持久化已覆盖重启场景）。

**后续演进路径（非本轮，无未决项）**：若要「权限/行为组免重启热生效」，需两步——
① Config schema 对相应字段加 `.volatile()`（schemastery，schemastery/src/index.ts:480-482）；
② 插件改为经 live config 引用读取这些字段（放弃 apply 期快照）。
本轮明确不做（改读取路径属插件重构，超出 R2 范围）；v1 一律「热重启生效」，语义自洽。

---

## 6. 对下游任务的硬约束（引用清单）

- **T3**：`lib/settings-remote.js` 方法集/快照/revision 语义 = §3/§3.1/§4；
  patch 行形态与绝对路径 name = §2；锚定与 exports 遮蔽规避 = §2；降级路径 = §2。
  测试三步（写设置→revision 递增→非法 revision 拒写）直接对 §3.1 断言；
  持久层断言文件 = §3 表中路径。
- **T4**：分组/键集/默认值 = §4 表；快照字段 = §3；accessToken 密码型输入 +
  脱敏回显 = §3 敏感字段行；数据通道 = §4 客户端模式。
- **T5**：README「运维」行改写为 §1.2 矩阵结论（config 覆盖与 insert 新增/删除
  分开表述，删除「touch 即生效」）；「设置页」小节的优先级一句话 = §3；
  生效方式表述 = §5 矩阵，一律采用确定性表述。
- **T2**：热加载兜底记录采纳 §1.2 #5/#6 与 §5「改 lib」行的措辞，不自行发明。
