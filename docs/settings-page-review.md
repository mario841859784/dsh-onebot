# 独立评审报告：dsh-onebot「部署加固 + 设置页」特性批次（T1–T6）

- 评审人：代码审查员（独立只读评审）
- 日期：2026-09-24
- 对象：分支 m0-hardening 未提交改动中属于本批次的文件域（src/index.ts 挂载段、scripts/build.sh、scripts/link-host.sh、src/settings-remote.ts + lib/settings-remote.js、lib/client.js、cordis.patch.yml、package.json exports ./client、README 双语设置页节、tests/settings-remote.spec.ts + tests/client-settings.spec.ts、docs/settings-page-design.md、docs/v043-next-acceptance.md + docs/acceptance-evidence/）
- 方法：git diff 区分基线 v0.4.2 与本批次；三方（T1 文档 ↔ src/settings-remote.ts ↔ lib/client.js）逐字对照；与参考实现 dsh-expert-orchestrator/{lib/remote.js,lib/client.js} 对照；两份新 spec 实跑（vitest 36/36 通过）；acceptance-evidence 全文扫描。

## 总体裁决：**部分同意**

实现质量高：三方契约逐字对齐（19 键分组/默认值/枚举与 src/index.ts schema 实测一致）、脱敏链路完整、乐观锁语义与 no-op/conflict 路径正确、fail-loud 挂载与 DSH_ROOT 逃生门均「设错即报错而非静默回退」、客户端 descriptor 形态与宿主先例同构。但有 **1 个安全阻塞项**（验收证据文件泄漏现网 accessToken 明文）与 5 个建议项，修复后可同意。

---

## 逐维度结论

### ① 契约一致性 —— 通过
- T1 §4 三组 19 键 ↔ `src/settings-remote.ts:55-100` ↔ `lib/client.js:67-140`：分组、键集、枚举、默认值三方逐字一致，且与 `src/index.ts:172-212` Config schema 默认值逐一核对无误（port 8643、interimRecallMs 90000、rateLimitPerMinute 30 等）。`tests/client-settings.spec.ts:156-194` 以常量断言防漂移，机制有效。
- descriptor 全 positional：`tests/settings-remote.spec.ts:219-234` 对服务类方法与 `createOnebotSettingsMethods` 双面断言参数名单；客户端 descriptor 形态（strictCodec 双形态 create()+schema、invocation direct、jsonParameter）与 dsh-expert-orchestrator/lib/client.js:313-354 先例同构。
- patch 模板与 live 用法一致：cordis.patch.yml:28-34 两行均绝对路径 name，与 live patch（acceptance-evidence/03-*.yml:91-98）一致；「exports 遮蔽 + 绝对路径」注释与 T1 §2 定案相符。
- 唯一缺口见建议项 B1：模板未沉淀 T6 发现的「config 覆盖须挂顶层行」约束。

### ② 安全 —— 1 个阻塞项，其余通过
- ✅ 脱敏全链路：host 侧 `buildSnapshot`（src/settings-remote.ts:229-233）恒置 `config.accessToken=''`、明文只进持久层；conflict/no-op 错误信息只含 revision 数字；客户端 `snapshotValueToDraft`（lib/client.js:425）密码框恒空、渲染树断言不含明文（tests/client-settings.spec.ts:232-244）；4 份网关 JSON 证据中 accessToken 均为 `""`。测试还有 `JSON.stringify(written)` 不含明文的整包断言（tests/settings-remote.spec.ts:209）。
- 🔴 **阻塞**：acceptance-evidence 里 live patch 现场副本 `docs/acceptance-evidence/03-patch-while-requireMention-false.yml:108` 含现网 accessToken 明文（`649ea109…`），并携带内网 IP 与 adminUsers QQ 号。该目录目前未跟踪（??），一旦照原样 `git add` 提交即泄漏进版本库。详见必改项 A1。
- ✅ updateSettings 可达面：Remote 无独立鉴权，依赖宿主网关会话（验收用 launch token 换 cookie 后才可路由，evidence 02）；与 dsh-expert-orchestrator 同一信任模型（Web 会话 = 管理员），属宿主既有权限模型内的合理取舍——但建议在 README 设置页节加一句「设置页等同管理员权限」。
- ✅ CJS externals 仅 react：tests/client-settings.spec.ts:84-100 静态断言（require 只指向 react、无 node:/@deepseek-ai 引用、无 import），与先例一致。

### ③ 正确性 —— 通过
- 乐观锁：`observeRevision`（src/settings-remote.ts:208-213）指纹比对 +1、首次建基线不递增；`updateSettings` 观察→校验→no-op 短路（:312，deep-equal 不写不递增）→edit 用 `(fresh)=>({...fresh,...clean})` 合并（:313，在宿主文件锁内取新鲜值，避免丢更新）；拒写不落盘不递增均有测试（spec:126-147、151-161）。与 T1 §3.1 逐条吻合。
- 热生效矩阵：README.md:37 运维行、lib/client.js effect.hint 词条与 T1 §5 矩阵一致（config 覆盖热重启、touch no-op、回滚还原）。验收证据（写→断开→秒级重连→pid 不变）实证了 config 覆盖路径。
- ⚠️ 一处批次内记录自相矛盾见建议项 B2：DEVLOG.md:337（本批次新增条目）断言「新增 insert 条目也需重启」，与 T1 §1.2 #2、README.md:37「insert 新增/删除均热生效」直接冲突，且与本次验收实证（补 host-plane 行未重启宿主即被网关路由，v043-next-acceptance.md R1①②）矛盾。
- 边界：条目失活如实标记 entryActive=false（spec:252-256）；no-entry 显式报错（spec:244-250）。

### ④ 双语文档一致性 —— 通过（含一处记录矛盾）
- README.md / README.en.md 设置页节、部署段（node_modules 链接集 + DSH_ROOT 逃生门）、排障表三行（挂载失败 / build.sh 定位失败 / 改设置页不生效四步排查）双语对称，且与 scripts/build.sh:19-29、scripts/link-host.sh:19-29 实现行为一致（DSH_ROOT 有效即短路、无效报错退出）。
- 客户端 zh/en 词条 key 集运行时自检（lib/client.js:359-366）。
- 矛盾项即 B2（DEVLOG vs T1/README）。
- 归属存疑（未计入本批次结论，仅列出）：README.en.md Commands/Tools 行改动（/plan `<text>`、/permission 英文同步）与 README.md 命令行未同步改动，疑似更早批次（09-17 缺陷修复）遗留的英文补齐，非 T5 内容；src/bridge.ts、src/registry.ts、src/dsh-llm.d.ts、tests/{registry,session-preview,hotfix-043}*、lib/registry.js 等按 DEVLOG.md 09-17/09-23 条目归属前两个未提交批次，本次未深审。

### ⑤ 测试覆盖 —— 基本充分，2 处缺口
- 已覆盖：三步主链路、no-op、edit 失败传播、外部来源 revision 递增、校验拒绝矩阵、脱敏三态、descriptor 位置序、渲染树形态、保存 patch 构造。两文件实跑 36/36 通过。
- 缺口见 B3、B4。

---

## 必改项清单

### 阻塞

- **A1 🔴 安全：验收证据泄漏现网 accessToken 明文**
  `docs/acceptance-evidence/03-patch-while-requireMention-false.yml:108`（`accessToken: 649ea109…`）；同文件 :106-110 还有内网 IP 与 adminUsers QQ 号。
  原因：该文件是 live patch 的逐字快照，patch 侧明文落盘是宿主既有行为，但**复制进仓库文档目录**越出了「写入侧明文只在 `<DSH_HOME>` 下」的边界，与快照返回侧的脱敏努力自相矛盾；提交后即永久入库。
  必改：① 将该文件中 accessToken 替换为 `<redacted>`（保留其余证据价值）；② 扫描 docs/ 其余文件确认无二次泄漏（本次已扫：仅此一处）；③ 建议轮换现网 accessToken（该值已出现在工作树文档中）。

### 建议

- **B1 🟡 patch 模板缺「config 覆盖须挂顶层行」关键约束**
  `cordis.patch.yml:11-14、29-32`：模板注释让部署者「保持 dsh-onebot 的 name 与 config 原样」合入 insert 块，但 T6 实测发现 `configEditor.edit` 只寻址 patch 文档顶层 id 行（dsh-config-editor findLastIndex），config 留在 insert 块内时设置页写入会被 compose 自检拒绝（v043-next-acceptance.md「R1③ 发现」）。验收报告自己也列了此遗留。必改：模板加一行显式约束（config 覆盖写顶层同 id 行、insert 块只管挂载），否则新部署会复现同一写失败。

- **B2 🟡 批次内热生效记录自相矛盾**
  `DEVLOG.md:337`（「新增 insert 条目也需重启……只有既有条目的 config 快照改动才热生效」）vs `docs/settings-page-design.md:54`（§1.2 #2 insert 新增 ✅ 热生效，EntryGroup.update create() 会 import 插件模块）与 `README.md:37`。本次验收实证支持 T1（补 insert 行未重启即被网关路由）。必改：在 DEVLOG:337 条目补一条按 0.1.7-alpha.2 源码/实测的勘误（或注明该结论仅适用于旧宿主版本），避免后续任务再引用过时结论。

- **B3 🟡 编译产物 lib/settings-remote.js 无防漂移测试**
  `tests/client-settings.spec.ts:25-32`、`tests/settings-remote.spec.ts:22-33` 均直接 import `src/`，部署物是 `lib/settings-remote.js`；两者常量漂移（改 src 忘构建）无测试拦截。本次评审已用 node 实载 lib 产物核对常量一致。建议：加一个读 `lib/settings-remote.js` 断言 SETTINGS_GROUPS/SCHEMA_DEFAULTS/ALL_KEYS 与 src 导出全等的轻量用例。

- **B4 🟡 数字键缺取值范围校验，完全依赖宿主回滚兜底**
  `src/settings-remote.ts:260-262`（NUMBER_KEYS 只查 `Number.isFinite`，port:-5、interimRecallMs:1e308 可过 Remote 层）、`lib/client.js:258-278`（patchSchema vNumber 无下界）。设计上由宿主 schemastery + reconcile 失败回滚兜底，链路安全但用户体验差（报错来自宿主深处且触发一次无谓写事务）。建议：Remote 层对 port 加 1–65535、对时长/频控加 ≥0 下界，客户端同步。

- **B5 💥（小改进）客户端冲突判定正则过宽**
  `lib/client.js:417`：`CONFLICT_RE = /onebot-settings\/conflict|expectedRevision|revision/i` —— 任何 message 含 "revision" 的无关错误都会被当冲突处理（静默 refetch，掩盖真实错误）。建议：优先按 `error.code` 判定，正则只留 `onebot-settings\/conflict` 作 message 兜底。

## 值得肯定

- revision/no-op/conflict 的测试写得非常扎实（拒写不落盘、无半态、外部来源递增三个反直觉路径都有确定性用例）。
- 降级路径（typert-protocol 不可解析 → 普通 cordis 服务 + FallbackRemoteError 结构对齐）照抄先例且补齐了错误语义，不是简单 try/catch 吞掉。
- fail-loud 挂载注释把「为什么不能用静态 import」讲清楚了，是有教育意义的代码。
- 验收报告对降级项（浏览器未实测）如实标注而非粉饰。

—— 代码审查员 · 2026-09-24
