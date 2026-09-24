# N3 · npm pack 构建与真机实测报告（T3）

- 日期：2026-09-24
- 执行：DevOps 自动化师（任务板 T3，dsh-onebot-npm.json）
- 仓库：dsh-onebot，HEAD=f9291a3，工作树含 N2 未提交改动（package.json/README/cordis.patch.yml，本任务零触碰）
- 宿主：dsh 0.1.7-rc.1；node v24.15.0；pnpm 12.5.1；npm 11.12.1
- **未执行 npm publish**（凭据未提供，范围外）
- 实现契约 = docs/npm-distribution-design.md（N1）；官方通道 = `dsh plugin --profile <p> <pnpm args>`

---

## 1. 全链路验证结论

| # | 环节 | 结论 | 证据（docs/npm-e2e-evidence/） |
|---|------|------|------|
| 1 | npm pack 构建 | ✅ 0.4.4 tarball，56 文件；lib/**（含 client.js、settings-remote.js、types）+ cordis.patch.yml + 双语 README + LICENSE + package.json；scripts/、dsh.plugin.json 未入包 | 01-npm-pack.txt、01-npm-pack-manifest-sha256.txt（sha256 `c6611a88…a99df9`） |
| 2 | 干净安装（npm，file: tarball） | ✅ exit 0，无 ERESOLVE；npm 默认 peer 自动安装拉入 0.1.5-rc.3 系（registry 现版本满足 `>=0.1.5-rc.1`，N1 附录预估的 0.0.1-rc.1 陈旧版已不存在——良性偏差） | 02-npm-install-default.txt、02b-installed-peer-versions.txt |
| 3 | exports 子路径解析（干净安装目录内） | ✅ 与 N1 §3 逐一吻合：`.`/`./client`/`./settings-remote`（N2 新增）可加载；`./package.json` 需 import attributes；裸深路径 `lib/settings-remote.js` 被 `ERR_PACKAGE_PATH_NOT_EXPORTED` 挡死 → patch 行必须用裸包名形态 | 03-exports-resolution.txt |
| 4 | 官方通道安装到独立 profile | ✅ `dsh plugin --profile e2e-npm-test add file:<tarball>` → pnpm 装入 profile node_modules 顶层仅 `@dsh-external/dsh-onebot` | 05-plugin-add.txt、05b-installed-peers.txt |
| 5 | patch 两行 bare-name 寻址 | ✅ `--dump-config` 组合树中 `@dsh-external/dsh-onebot` 与 `@dsh-external/dsh-onebot/settings-remote` 均可寻址、name 保持字面量；config 覆盖挂顶层同 id 行 | 06-dump-config.txt、14-dump-config-final.txt |
| 6 | 真机挂载 | ✅ 独立实例（port 13099）`[dsh-onebot] mounted (mode=reverse…)`；reverse WS 监听 ws://127.0.0.1:18765（与 live 8765 隔离）；bridge ready | 09-boot-final-mount.log |
| 7 | peer 拦截生效（同源取证） | ⚠️→✅ 默认配置下**失败**（§2 偏差 D2），按修正约束（pnpm-workspace.yaml）重装后**通过**：进程内 prototype/类同一性归因，插件 Config schema = 宿主安装树 schemastery 实例；settings-remote 抛出的 RemoteError 即宿主 dsh-typert-protocol 类（FallbackRemoteError 降级未触发） | 10-peer-same-origin-attribution.txt（方法见 12-probe-preload-source.mjs.txt） |
| 8 | 反向验证（拦截为唯一来源） | ✅ 裸 Node（无宿主拦截器）从插件 realpath 解析 `@deepseek-ai/schemastery` → MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND：本地无候选，运行期同源只能来自宿主路由器 | 11-plain-node-no-local-candidate.txt |
| 9 | 清理 | ✅ 官方 `dsh plugin remove` exit 0 → profile 目录删除 → profiles/ 仅剩 web；/tmp 工作区删除；无残留进程 | 17-cleanup.txt |
| 10 | live web profile 零影响 | ✅ pid 2609953 不变；8765 LISTEN + NapCat(172.17.0.3) ESTAB 全程保持；cordis.patch.yml / package.json / cordis.yml sha256 前后一致；web profile node_modules 无变化 | 00-live-web-baseline.txt、16-live-web-after.txt |

## 2. 真实宿主偏差记录（证据优先，未硬凑）

**D1（pnpm 12 项目级配置位置变更）**：profile 内 `.npmrc`（`auto-install-peers=false`）**不被 pnpm 12.5.1 读取**（`pnpm config get auto-install-peers` → undefined；锁文件 settings 仍 `autoInstallPeers: true`），且首次 `dsh plugin` 初始化观察到 .npmrc 被移除一次。项目级配置正确位置是 **`pnpm-workspace.yaml`**（`autoInstallPeers: false` + `hoist: false`），dsh 报错文案（allowBuilds 指向 pnpm-workspace.yaml）与此一致。→ **N1 C3 与 N2 README npm 节的 `.npmrc` 写法需修正**（README 属其他会话未提交改动，本任务不改，仅报告）。
证据：08-reinstall-hoist-false.txt、13-test-profile-pnpm-workspace.yaml.txt

**D2（N1 §2"惰性死重"结论在 pnpm 布局下不成立）**：默认配置（peers 被自动装进 profile）时，`.pnpm` 隐藏 hoist 与 per-pkg node_modules 均位于插件 realpath 的 node_modules 祖先链内；宿主 `dsh-app-boot` `routeScoped`（profile 层）**本地候选优先于拦截**（ESM 分支命中候选即无条件 native）→ 插件实际加载了 `.pnpm` 私有副本（3.18.4），与宿主实例**构成真双包**（进程内归因：pluginConfigProtoIsPrivateCopy=true）。N1 预估的 routeLinked（kind=linked）仅适用于 link-host 式树外符号链接布局；pnpm realpath 在 profile 目录内 → kind=profile。
证据：07-peer-interception-deviation.txt

**D3（修正式约束，npm 通道可用前提）**：profile `pnpm-workspace.yaml` 写 `autoInstallPeers: false` + `hoist: false`（更换 hoist 配置须先清 node_modules+锁文件，否则 `ERR_PNPM_HOIST_PATTERN_DIFF`）→ 本地无任何 peer 候选 → 拦截路由器接手 → 同源验证通过（§1 #7/#8）。安装文档必须按此扩写。

**D4（良性）**：`dsh plugin add` 输出 `declares no dsh.bundle — installed as a plain dependency` 为信息级提示，不影响 patch insert 挂载路径。

## 3. 方法备注

- 同源归因：`--import` 预加载只读探针在真实 ESM 上下文暴露 `globalThis.__peerAttribution()`，以 file URL 直import 宿主树/副本模块，与运行中插件模块（ESM 缓存同实例）做 `Object.getPrototypeOf` / 构造器同一性比对；inspector 仅做普通函数调用（Runtime.evaluate 内 dynamic import 不可用，replMode 版会崩实例——已避开）。静态 import 的 peer（dsh-llm/dsh-session/dsh-agent/dsh-tools）与两处动态 import 的归因共用同一 routeScoped 机制且本地零候选，随挂载成功一并成立。
- 测试 profile 隔离：独立目录、独立端口（13099/18765 loopback），config 覆盖显式指定 host=127.0.0.1 port=18765，绝不触碰 live web profile 既有挂载（live 用绝对路径 name，本测试用 bare name，互不相干）。

---
**DevOps 自动化师** · T3 完成 · npm 通道端到端可用（附 D1–D3 文档修正项）
