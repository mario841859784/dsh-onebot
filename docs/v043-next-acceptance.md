# dsh-onebot v0.4.3-next — T6 端到端验收报告

- 日期：2026-09-24（UTC+8 凌晨）
- 执行：DevOps 自动化师（T6，任务板 `.expert-taskboards/dsh-onebot-settings-page.json`）
- 仓库：`/vol2/@appshare/Harness/workspace/project1/dsh-onebot`
- live 部署副本：`/vol2/@appshare/Harness/dsh-plugins/dsh-onebot`
- live patch：`/vol2/@appshare/Harness/.dsh/profiles/web/cordis.patch.yml`（改动前备份 `cordis.patch.yml.bak-20260924`）
- 证据目录：`docs/acceptance-evidence/`

## 结论总览

| 项 | 结果 |
|---|---|
| live 部署升级 | ✅ 热生效（未重启宿主；`node_modules` 依赖闭包原样保留） |
| 部署副本一致性 | ✅ `diff -rq` 为零（lib 全目录 + package.json） |
| ① 挂载/监听/反向连接 | ✅ 8765 LISTEN + napcat 反向 ESTAB，两次热重启均自动恢复 |
| ② Remote 路由（网关级） | ✅ `onebotSettings/getSettings` 经 live api-gateway 成功返回快照 |
| ③ 设置页写链路 | ✅ updateSettings → revision 递增 → patch 落盘 → 插件热重启 → 8765 恢复 → 已回改原值 |
| ④ 回归 | ✅ `npm test` 376/376 通过，退出码 0 |
| ⑤ 浏览器 UI 层 | ⚠️ **未做浏览器实测**（宿主无 Playwright 条件），降级为装载契约静态核验，通过 |

## R1 逐条核销

### R1① 挂载证据（8765 监听 + napcat 反向连接）

- ✅ live patch 补入 host-plane 行 `onebot-settings-remote`（`name` 为部署副本绝对路径
  `/vol2/@appshare/Harness/dsh-plugins/dsh-onebot/lib/settings-remote.js`，与 `dsh-onebot`
  主条目同一 insert 块；追加前已 `cp` 备份，`python3 yaml.safe_load` 校验通过，两侧文件均校验）。
- ✅ 加行后 8765 全程保持 LISTEN（`ss -tln`），napcat 反向连接保持 ESTAB，无错误循环——
  补行属 insert 新增，未中断既有插件 fiber（与 T1 定案一致）。
- 证据：`docs/acceptance-evidence/02-patch-before-update.txt`、本报告 §结论总览；
  8765 现场快照：
  ```
  LISTEN 0 511 192.168.5.74:8765 0.0.0.0:*  users:(("MainThread",pid=2609953,fd=22))
  ESTAB  0 0   192.168.5.74:8765 172.17.0.3:*  users:(("MainThread",pid=2609953,fd=24))
  ```
  （宿主 stdout 由 app 中心 supervisor 经 pipe 托管、无落盘日志文件，故挂载证据以网关级
  路由实证 + ss 为准，见 R1②。）

### R1② Remote 路由（网关级，非模拟）

- ✅ 用 live web 会话（launch token 换取会话 cookie）向
  `POST http://127.0.0.1:13080/api/onebotSettings/getSettings` 发送网关 RPC envelope，
  返回 `ok:true` 快照：`revision:0`、`entryActive:true`、三组 19 键全量生效值
  （connection 6 + permissions 7 + behavior 6）、`secrets:[{path:["accessToken"],set:true}]`
  （脱敏回显 `""`，明文是否已配置由 secrets 标记）。
- ✅ 这证明 host-plane 行已被宿主装载、`onebotSettings` 命名空间可被 api-gateway 发现并路由。
- 证据：`docs/acceptance-evidence/02-getSettings-gateway.json`（原始响应）。

### R1③ 设置页写链路（updateSettings 全闭环）

第一次经网关调用 `updateSettings` 时暴露一个现网 patch 结构问题并已修复：

- **发现**：`configEditor.edit` 只寻址 patch 文档**顶层**的 `id:` 行（
  `dsh-config-editor/lib/index.js:92` 的 `findLastIndex` 在顶层 items 中按 id 匹配）；
  现网 `dsh-onebot` 的 `config` 原嵌在 `insert:` 块内，写入被 compose 自检拒绝
  （错误：`Configuration for "dsh-onebot" is overridden by a home patch or command-line
  overlay`），写事务原子回滚、patch 文件未产生半写状态。
- **修复**（2026-09-24 01:04，备份已存在）：把 `insert:` 块内的 `config` 摘出，改挂到
  顶层同 id 覆盖行（值逐字不变）；insert 块只保留两行挂载（`dsh-onebot` 主条目 +
  `onebot-settings-remote`）。这与 T1 定案「同 id config 覆盖热生效」及宿主设置页管道
  的持久层假设一致。修复后 8765 保持服务、napcat 自动重连恢复。
- **闭环证据**（全部经 live api-gateway 真实调用）：
  1. `updateSettings {requireMention:false}, expectedRevision:0` → `ok:true`，
     快照 revision 0→1（乐观锁生效）；
  2. live patch 顶层覆盖行出现 `requireMention: false`（宿主 configEditor 原子写入，
     非手工编辑）；
  3. 插件热重启：01:07:25 写入提交，01:07:26–01:07:5x napcat 反向连接断开
     （旧连接本地端口 34422 消失），01:07:56 前后自动重连恢复 ESTAB（新连接 46400），
     8765 持续 LISTEN——秒级热生效，宿主进程未重启（pid 2609953 全程不变）；
  4. 回改 `updateSettings {requireMention:true}, expectedRevision:1` → `ok:true`，
     revision 1→2；patch 落盘 `requireMention: true`；二次热重启，01:08:26 起 ESTAB
     短暂断开后于 01:09:00 前恢复，最终快照 `revision:2, entryActive:true, 19 键,
     secrets accessToken set:true`（`docs/acceptance-evidence/03-getSettings-final.json`）。
- 证据：`03-updateSettings-requireMention-false.json`、`03-patch-while-requireMention-false.yml`
  （当时 patch 现场副本）、`03-updateSettings-requireMention-revert.json`、
  `03-8765-monitor.log`、`03-8765-monitor-revert.log`（1s 分辨率 ESTAB 时序）、
  `03-getSettings-final.json`。

### R1④ 回归

- ✅ `npm test` 退出码 0，30 个测试文件 376 用例全通过（含既有 hotfix-043.spec.ts 基线）。
- 证据：`docs/acceptance-evidence/04-npm-test.log`（两次运行，01:00 与 01:10）。

### R1⑤ / ⑤ 浏览器 UI 层（降级核验，如实标注）

- ⚠️ **未做浏览器实测**：宿主环境无 Playwright 条件（`qa-playwright-capture.sh` 不可用）。
- ✅ 降级为 lib/client.js 装载契约静态核验（对部署副本文件执行，`05-client-static-contract.txt`）：
  - CJS banner `window.__ModuleLoader__.load({id, factory:(require)=>{` 在位；footer
    `return module.exports; } });` 形状在位；
  - 唯一 `require()` 为宿主注入的 `"react"`（browser module loader 提供），无宿主外依赖；
  - 客户端 19 键 schema（configSchema/patchSchema，逐键 vEnum/vString/…）与宿主侧
    `lib/settings-remote.js` 的 SETTINGS_GROUPS/SCHEMA_DEFAULTS/校验键集逐字一致；
  - descriptor（`getSettings` 0 参、`updateSettings(patch, expectedRevision)` 全 positional）
    与宿主网关实测路由行为一致（R1②③ 即 descriptor 生效的运行期实证）；
  - 宿主侧快照 schema（snapshotSchema）与 R1②③ 实际返回结构逐字段吻合。

## R2 全链路核销

| # | 环节 | 结果 | 证据 |
|---|---|---|---|
| 1 | 工作区构建 → 部署副本同步 | ✅ `cp` lib/index.js、lib/settings-remote.js、lib/client.js、lib/types/{index,settings-remote}.d.ts、package.json；`diff -rq` 为零 | `01-deploy-diff-zero.txt` |
| 2 | node_modules 链接集/依赖闭包 | ✅ 原样保留（未触碰） | 部署副本目录清点 |
| 3 | live patch host-plane 行 | ✅ 已插入并 YAML safe_load 校验通过 | 本报告 §R1① |
| 4 | 宿主热装载 settings-remote | ✅ 网关路由实证（无需重启宿主） | `02-getSettings-gateway.json` |
| 5 | getSettings 快照契约 | ✅ 19 键三组 + revision + secrets 脱敏 | 同上 |
| 6 | updateSettings 乐观锁写入 | ✅ expectedRevision 校验 + revision 0→1→2 | `03-updateSettings-*.json` |
| 7 | 持久层落盘 | ✅ 宿主 configEditor 原子写 profile patch | `03-patch-while-requireMention-false.yml` |
| 8 | 插件热重启生效 | ✅ 两次写入均秒级热重启，QQ 桥自动重连 | `03-8765-monitor*.log` |
| 9 | 回归测试 | ✅ 376/376，exit 0 | `04-npm-test.log` |
| 10 | 客户端装载契约 | ✅ 静态核验通过；⚠️ 浏览器实测未做 | `05-client-static-contract.txt` |

## 红线遵守与遗留说明

- 未执行任何 `git checkout --` / `git restore` / 工作树清理；工作树内 T1–T5 未提交改动原样保留。
- root SSH 未使用（热生效全程成立，重启兜底未触发）。
- live patch 顶层覆盖行重构（insert 块 config → 顶层同 id 行）为本次升级的必要结构修正，
  改前备份 `cordis.patch.yml.bak-20260924`，改后值与原值逐字一致；`onebot-settings-remote`
  行与 `dsh-onebot` 行均校验在位。
- 唯一降级项：浏览器 UI 未实测（已如实标注，见 ⑤）。
- 仓库模板 `cordis.patch.yml` 的注释建议同步补一句「config 覆盖须挂顶层行」（后续小改，
  不阻塞本验收）。

---
**DevOps 自动化师** · 2026-09-24
