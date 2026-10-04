# 特征化钉底 ②：宿主 configEditor.edit 全失败路径行为钉死（T1 · 只读）

> 基准：分支 `m0-hardening` @ `953919b`。宿主源码以本机安装版为准：
> `/vol2/@appcenter/Harness/server/node_modules/@deepseek-ai/dsh-config-editor/lib/index.js`（138 行，bundled dist）。
> 辅助证据：`@deepseek-ai/dsh-atomic-write/lib/index.js`（217 行）、`@deepseek-ai/dsh-app-boot/lib/index.js`（reconcileProfilePatches L3468-3496）。
> 用途：T6「失败不破坏 patch 守卫测试」的断言设计依据。

---

## 1. edit() 主流程与行号地图

> **纠正**：计划 §0.5 与 settings-remote.ts:20-21 引用的 `dsh-config-editor/lib/index.js:63-123` 有行号漂移——`edit()` 实际体在 **L69-135**（L63 是 `inherited()` 尾部）。settings-page-design.md:173 引 `86-104`（删除覆盖行路径实际 **L99-104**）、:255 引 `118-123`（回滚实际 **L126-130**）同属漂移。语义判断本身全部属实。

`async edit(entry, change)`（L69-135）按序：

| 步 | 行号 | 行为 | 失败时的文件影响 |
|---|---|---|---|
| 0 | L133-134 | `hmr.runExclusive(run)` 串行化（无 hmr 服务则直接跑） | — |
| 1 | L72 | `withFileLock(<profile>/package.json, …)` —— **锁的是 package.json，不是 patch 文件本身** | 见 §2 |
| 2 | L73 | 活性检查：entry 仍在 `entries()` 且 fiber 存在，否则 throw "Configuration entry is no longer available" | 无写 |
| 3 | L74-76 | 读 patch 快照 `beforePatches` → 预 reconcile（runtime 层 entry.update，不写 patch 文件）→ 复查 entry 仍在，否则 throw "changed during reload" | 无写 |
| 4 | L77-79 | `current = structuredClone(entry.options.config)`；`inherited`；`next = change(current, inherited)` | 无写 |
| 5 | L81 | `fiber.state !== 2` → throw "Configuration plugin is no longer active" | 无写 |
| 6 | L82-83 | **插件侧校验**：`fiber.ctx.waterfall(fiber, "internal/config", next)` + `resolveConfig` —— schema 校验失败在这里抛 | 无写 |
| 7 | L84-90 | 读原文件到 `before`（ENOENT → `"[]\n"`） | 无写 |
| 8 | L91-96 | `parseDocument` + 结构校验（必须 YAML sequence，L96） | 无写 |
| 9 | L98 | `findLastIndex` 定位本条目的 config 覆盖行 | 无写 |
| 10 | L99-104 | `next` 深等于 `inherited` → 删除覆盖行（整行空了连行删） | 未到写 |
| 11 | L105-110 | 无行 → 新增 `{id, name, config}`；有行 → `setIn([index,"config"])` | 未到写 |
| 12 | L111-116 | `!!js` 标签还原 visit | 未到写 |
| 13 | L117-122 | **home-patch 守卫**：重组 patches 后若该条目 config ≠ next → throw "overridden by a home patch or command-line overlay" | 无写 |
| 14 | **L123** | `writeFileAtomic(path, String(document), {mode: 384})` —— 唯一写点，0600 权限 | 成功后进入 15 |
| 15 | L124-130 | `reconcileProfilePatches(root, patches, "dsh", [entry.id])`（热生效）；**失败 → 回滚**：L127 `writeFileAtomic(path, before, {mode:384})` 逐字节还原 + L128 用 `beforePatches` 重 reconcile，再 rethrow | 见 §3 回滚行 |

`writeFileAtomic`（dsh-atomic-write/lib/index.js:61-77）：随机后缀 sibling + `wx` 独占创建 + rename 原子替换；**任一步失败删除 temp 并 rethrow，目标文件不被触碰**。`reconcileProfilePatches`（dsh-app-boot:3468-3496）：root include `entry.update` → 等 fiber → **新增失活条目或既有 fiber 新失败则 throw**（L3491-3493），成功返回诊断数组（edit 丢弃返回值）。

## 2. 锁冲突场景（「文件锁冲突」的精确语义）

- 锁文件：`<profile>/package.json.lock`（wx 独占创建，记录持有者 PID，dsh-atomic-write:188-215）。
- **默认等待上限 `DEFAULT_LOCK_WAIT_MS = 2000`**（:163），20ms 起指数退避至 200ms（:152-153,190-208）；超时 **throw** `"atomic-write: timed out waiting for the writer lock at <path>"`（:206）——不排队不限长等。
- 死持有者（PID 已退出）会被自动接管（:121-146,204）；活着的异地/PID 复用锁会等到超时。
- **结论：锁冲突 = ~2s 后抛错；此时流程在步 1，patch 文件从未被打开写，逐字节不变（连 mtime 都不变）。**
- 注意 `edit` 未传 `waitMs`（dsh-config-editor L72 无第三参），故固定 2s，不可调。

## 3. 全失败路径 × 「原 patch 文件是否逐字节不变」矩阵

| 失败场景 | 抛错点 | patch 文件内容 | patch 文件 inode/mtime | 返回值形态 |
|---|---|---|---|---|
| 文件锁冲突（>2s） | dsh-atomic-write:206 | **逐字节不变** | 不变（从未写） | edit reject 原生 Error |
| 条目失活/编辑中被替换（步 2/3） | dsh-config-editor:73,76 | 逐字节不变 | 不变 | reject |
| 插件非 active（步 5） | :81 | 逐字节不变 | 不变 | reject |
| schema/resolveConfig 校验失败（步 6） | :82-83 | 逐字节不变 | 不变 | reject |
| patch 文件 YAML 坏 / 非 sequence（步 8） | :95,96 | 逐字节不变 | 不变 | reject |
| 被 home patch / 命令行 overlay 覆盖（步 13） | :122 | 逐字节不变 | 不变 | reject |
| 原子写本身失败（磁盘/权限） | dsh-atomic-write:73-76（temp 清理后 rethrow） | 逐字节不变（rename 未发生） | 不变 | reject |
| **激活/reconcile 失败（步 15）** | dsh-config-editor:126→129 rethrow | **逐字节还原**：L127 用 `before`（步 7 读到的原串）写回——**内容与写前完全一致** | **变**（走了一次 rename，新 inode/新 mtime，mode 恒 0600） | reject（若 L128 回滚 reconcile 也抛，则抛的是回滚错误，**原始激活错误被吞**） |
| 成功 | — | `String(document)`：注释大体保留（parseDocument 保注释、`flow=false` L97），但**整体重新序列化**，格式可能与手写版有差异 | 变（新 inode，mode 恒 0600） | resolve（**void**，reconcile 完成后才 fulfill，L67-68 契约注释） |

**给 W6 的两个关键边界**（写测试时必须区分）：

1. **「逐字节不变」只对内容成立，不对 inode/mtime 成立**——激活失败回滚路径（L127）是内容等价的**重写**。守卫测试断言 `Buffer.equals(写前, 写后)`，**不要**断言 mtime/ino。
2. 回滚错误遮蔽：L128 再抛时调用方拿到的是回滚 reconcile 的错误，不是激活错误。测试若 mock「写成功 + reconcile 失败 + 回滚 reconcile 也失败」，应断言"文件内容已还原"而非"错误信息指向激活失败"。

## 4. 热生效与回滚时序（单次 edit 的时间线）

```
await configEditor.edit(entry, change)          ← hmr.runExclusive 串行（L133-134）
  ├─ 锁 package.json（≤2s，失败即抛，未写任何文件）
  ├─ 预 reconcile（runtime 层，不写 patch 文件）        L75
  ├─ change → 校验（waterfall/resolveConfig）          L79-83   ← 失败：什么都没发生
  ├─ YAML 渲染 + home-patch 守卫                       L91-122  ← 失败：什么都没发生
  ├─ writeFileAtomic（原子替换 patch 文件，0600）        L123     ← 此后文件已是新内容
  ├─ reconcile 热生效（root include update → loader
  │   partial 重载 → dsh-onebot fiber 秒级原地重启）     L125
  │     ├─ 成功 → resolve(void)；revision 语义由调用方观察
  │     └─ 失败 → 写回 before（内容逐字节还原）L127
  │              + 用 beforePatches 重 reconcile L128 → rethrow
  └─ 释放锁（finally，dsh-atomic-write:213）
```

与 settings-page-design.md §5 矩阵（L251-258）核对一致：激活失败 → patch 自动回滚 + 旧配置继续运行（该处引行号 118-123 应为 126-130，见 §1 纠正）。另注意 **19 键任意键的保存 = 插件 fiber 原地重启**（同文档 §5 第一行），这是 T6 徽标「待重启/非默认」区分的事实基础：本插件的"热生效"粒度是整个条目 fiber，不存在键级热/冷差异。

## 5. 对照 src/settings-remote.ts 现有调用方式（T1 定案 B 路径）

- 调用点：`updateSettings`（src/settings-remote.ts:301-322）：findEntry(307) → revision 乐观锁(308-315，`expectedRevision!==actual` 抛 `onebot-settings/conflict`) → `validatePatch`(316，未知键/类型错整单拒绝) → no-op 短路(317-319，深相等不调 edit、不递增) → `editor.edit(entry, fresh => ({...fresh, ...clean}))`(320) → 重建快照(321)。
- 合并语义与宿主契约吻合：next = 当前覆盖行 ∪ patch（未知原键保留）；等于 inherited 时由宿主整行删除（dsh-config-editor:99-104，settings-remote.ts:298-299 注释一致）。
- **观测缺口（供 T6 决策，非必改）**：L320 的 `editor.edit` **没有 try/catch**——锁超时/激活失败回滚等宿主原生 Error 会**裸抛给网关**，错误码不是 `onebot-settings/*` 体系。T6 若做错误码归一（包成 `onebot-settings/edit-failed` 并保留 cause），守卫测试需同步断言；若维持现状，测试则断言"reject 且消息含宿主原文"。
- revision 侧：写失败路径不递增（settings-remote.ts:31-32 注释 + 实现一致：只有成功后 `buildSnapshot`→`observeRevision` 观察到指纹变化才 +1，L216-219）。

## 6. W6 守卫测试断言设计建议

### 6.1 分层：插件层 mock 测试（必做）+ 可选的宿主真件集成测试

「原 patch 逐字节不变」的**保证者**是宿主 configEditor + dsh-atomic-write，不是本插件代码。因此：

- **必做（tests/settings-remote.spec.ts 扩展）**：mock `ConfigEditorLike`（settings-remote.ts:134-137 的最小面），对 `updateSettings` 做失败注入，断言插件侧契约（下表）。
- **可选（单独 describe，宿主包可解析才跑）**：临时 profile 沙箱 + 真实 `dsh-config-editor` 实例 + 真实 patch 文件，验证回滚内容等价。若成本过高，可降级为"对宿主源码行号钉死的契约注释 + 上述 mock 层"，因宿主行为已由本文 §3 钉死。

### 6.2 mock 什么、断言什么（清单）

| mock 场景（editor.edit 行为） | 断言 |
|---|---|
| 抛普通 Error（模拟活性/校验失败） | updateSettings reject；**不抛 RemoteError 码则按 §5 决策**；再次 `getSettings()`：config 与写前逐键相等、revision 与写前相等（指纹未变不递增，settings-remote.ts:216-219） |
| 抛 `atomic-write: timed out waiting for the writer lock…`（模拟锁冲突） | 同上；并断言 edit 被调用过一次（失败不重试——插件侧无重试逻辑） |
| 「写成功后 reject」（模拟激活失败回滚）：mock 内先让 entries 的 config 变了再抛 | 快照恢复旧值、revision 不递增；**不得出现"半态"**（部分新键残留） |
| resolve 成功 | edit 以 `(entry, fn)` 调用；`fn(fresh)` 返回 `{...fresh, ...patch}` 且**未知原键保留**；之后快照 revision **恰好 +1** |
| no-op patch（patch 值 = 当前生效值） | **edit 零调用**（settings-remote.ts:319 短路）、revision 不变 |
| expectedRevision 过期 | 抛 `onebot-settings/conflict` 且 `details {expected, actual}` 正确（L309-315）；edit 零调用 |
| 白名单外键 / 类型错 | `onebot-settings/bad-request`（validatePatch L283-286）；edit 零调用 |

### 6.3 若做真实文件级沙箱测试（可选路径的断言要点）

- 写前 `readFile` 存 Buffer → 触发失败路径 → 写后 `readFile` → `Buffer.equals` 断言**内容等价**（禁止断言 mtime/ino，见 §3 边界 1）；
- 成功路径断言 mode 0600（writeFileAtomic mode:384，dsh-config-editor:123）；
- 回滚后再断言一次 `getSettings` 等价快照（模拟宿主原生设置页/手改同源读侧）。
