# dsh-onebot npm 分发形态设计定案（N1 · go/no-go 先行验证）

- 日期：2026-09-24（验证当日）
- 结论负责人：软件架构师（N1）
- 插件仓库：HEAD=f9291a3，v0.4.4
- 宿主事实基线：本机 `dsh` 实际版本 **0.1.7-rc.1**（`dsh --version` 与
  `/vol2/@appcenter/Harness/server/node_modules/@deepseek-ai/dsh/package.json` 一致）；
  任务上下文所记 0.1.7-alpha.2 与本机不符，以下全部按 0.1.7-rc.1 考证。
- 方法：只读源码考证（宿主包内 lib 反查行号）+ /tmp 干燥实验（见附录 A）。
  本文档是本任务对仓库的唯一写入；工作树其余部分零改动。

---

## 0. 裁决：**有条件可行（conditional GO）**

宿主对 npm 分发形态**存在官方通道**：`dsh plugin --profile <name> <pnpm args>`
（pnpm 装进 profile 的 node_modules），且宿主在模块解析层内置了
**peer 拦截路由器**——插件对 `@deepseek-ai/*` 的 import 只要
**在该插件 package.json 的 peerDependencies 里声明**，就会被重定向到宿主安装树的
同一实例。双包隐患**由宿主路由器消解，而不是由包管理器去重消解**。因此
link-host.sh 头注释所述"npm 副本破坏 instanceof 身份"在 npm 通道下**不再成立**，
成立条件是 peer 声明完整（条件 C1）。

**条件清单（全部为发布 npm 包前必须满足）：**

| # | 条件 | 现状 |
|---|------|------|
| C1 | peerDependencies 必须覆盖插件 lib 的**全部**运行期 `@deepseek-ai/*` import（拦截只认 peer 声明，见 §2）。缺一项 = 该 import 落回裸 Node 解析 = ERR_MODULE_NOT_FOUND 或私有副本双包 | **缺两项**：`@deepseek-ai/schemastery`（lib/index.js:29 动态 import）与 `@deepseek-ai/dsh-typert-protocol`（lib/settings-remote.js:114 动态 import）均未声明。typert-protocol 缺失有 FallbackRemoteError 降级不致崩溃（settings-remote.js:99-118、123），但 schemastery 缺失会让插件**挂载失败**（附录 A 实验实测同型报错） |
| C2 | 用户 profile 的 `package.json` **绝不能**显式声明任何 `@deepseek-ai/*` 依赖：entries 构造是先 installation 后 profile 合入同一 Map（dsh-app-boot/lib/index.js:1177-1179、738-745），profile 副本会**覆盖** installation 副本成为拦截目标，造成"宿主用 0.1.7-rc.1、插件被拦到 0.0.1-rc.1"的版本错位双包 | 文档级约束，写入安装说明 |
| C3 | profile 目录应放 `.npmrc`（`auto-install-peers=false`）：pnpm 对插件 peer 范围在 npm 上无满足版本（独立包停在 dsh-llm=0.0.1-rc.1 等），autoInstallPeers 默认会拉入陈旧副本——虽为惰性死重（见 §2 注），但污染 lockfile 且误导排查 | 文档级约束 |
| C4 | patch 行 `name` 形态按 §3 定案书写；npm 布局下 exports 遮蔽**不会自然消解**，需包内补 exports 子路径或改用文件 URL 形态 name | 需包内小改（N2） |
| C5 | `files` 需补 `cordis.patch.yml`（模板随包分发，见 §5） | 需包内小改（N2） |

> C3 勘误注记（实测，见 docs/npm-e2e-report.md D1）：上表 C3 的 `.npmrc`（`auto-install-peers=false`）写法在 pnpm 12.5.1 上**不生效**（pnpm 12 不读项目级 `.npmrc`）；正确位置是 profile 的 `pnpm-workspace.yaml`（`autoInstallPeers: false` + `hoist: false`）。

---

## 1. 问题一：宿主如何发现与装载外部插件

**官方通道存在，即 `dsh plugin`，无其他"注册表"机制。**

- 命令入口：`dsh plugin --profile <name> <pnpm args>`，把 pnpm 参数原样转发到
  profile 目录执行（`@deepseek-ai/dsh/README.md:18`、`@deepseek-ai/dsh/lib/bin.js:104、114-127`；
  pnpm 缺失时明确报错、peer 豁免提示见 `dsh/lib/plugin-Dr5KNRuz.js:76-79`）。
  Web 侧等价物是 plugin-manager 服务的 installBundle（`@deepseek-ai/dsh-plugin-manager/README.md`
  "Use this package" 节）。另有 `dsh plugin allow-version / revoke-version` 豁免命令。
- 插件解析位置：`dsh.profile.bundles` 里的包先从 dsh 安装树解析，再从
  **profile 自身 node_modules**（pnpm 装外置插件处）解析
  （`@deepseek-ai/dsh/README.md:46`；对应实现 `dsh-app-boot/lib/index.js:886-902`，
  安装树优先是明文契约：外置插件"必须与运行中的 dsh 同一安装树"，:887-889 注释）。
- **patch/config 的 `name` 字段形态**（`dsh-app-boot/lib/index.js:3519-3527`
  `anchorInsertedPluginNames`）：
  1. 绝对路径 → 转 `file://` URL；
  2. `./`、`../` 相对路径 → 以 **patch 文件所在目录**为锚解析为 `file://` URL（profile 层 patch 即 profile 目录）；
  3. **裸包名（npm 包名，含深路径）原样保留**（"keep assertion names literal"），留给装载期路由（见 §2/§3）。
  最终 import 在 `cordis-plugin-loader/lib/index.js` `EntryTree.import`：优先走宿主
  内部 loader（`ctx.loader.internal.import(name, ctx.baseUrl, {})`），无内部 loader 时裸名退化为普通 `import(name)`。
- 非 insert 行的 `name` 仅作断言（不匹配即跳过整行，`cordis-plugin-include/lib/index.js:95-97`）。
- **无独立 `dsh plugin add/install` 子命令语法**——`add <pkg>` 只是转发给 pnpm 的参数
  （`bin.js:119`："plugin needs pnpm arguments to forward (e.g. add <package>)"）。

**结论**：npm 包名形态是被宿主原生支持的 name 形态之一；官方安装路径 = pnpm 进
profile node_modules + patch/user 层写挂载行。

## 2. 问题二：装载后插件对 `@deepseek-ai/*` 从哪个 node_modules 解析

**宿主做了 peer 统一——这是一台真正的解析拦截路由器，不是别名重写。**

机制（`dsh-app-boot/lib/index.js`）：

1. 启动时把 Node 内部 ESM/CJS 解析器打补丁：`installRuntimeInterception`
   替换 `esm.resolveSync`（或 v1 的 `esm.resolve`）与 `cjs.Module._resolveFilename`
   （:1578 起，内部 loader 取用 :1585-1600；释放 :1695、1810 注释）。
2. 拦截范围由"层"决定：模块路径落在 **profiles 树**、活动 profile，或 **linked root**
   （profile node_modules 里指向树外的符号链接，即 pnpm store 里的插件真身，
   `linkedProfileRoots` :611-640）才启用路由（`findInterceptionLayer` :1204-1211）；
   安装树自身路径被显式排除（:1206-1207），宿主自己的 import 永远不绕。
3. linked 层路由（`routeLinked` :1467-1503）：对插件发出的裸 import，
   沿 importer 向上找 `node_modules` 祖先，**当任一祖先包的 package.json
   `peerDependencies` 列有该名字（`readPeerNames` :1215-1223），且该名字在
   resolution.entries（安装树闭包 + profile 层闭包，`collectInstallationScopePackages`
   :667-698）里**，就拦截并重定向到该 entry 的安装树目录（ESM 分支 :1646-1667 换 parent 重解析）。
   **peer 没声明 → 落回裸 Node 解析**（:1471-1492），解析到什么用什么。
4. installation 闭包 = `@deepseek-ai/dsh` 清单的 dependencies+peerDependencies 传递闭包
   （`profileDependencyNames` :662-664；根包自身先入表 :675）。本机核实
   `@deepseek-ai/dsh-typert-protocol`（dsh-agent 等依赖）与 `@deepseek-ai/schemastery`
   （cordis-plugin-loader、dsh-agent 等依赖）均在闭包内。

**因此**：

- `@deepseek-ai/dsh-llm` 等独立 npm 包**是否发布、版本多陈旧，与运行期完全无关**——
  npm 装出来的独立副本根本不会被加载（声明了 peer 的名字被拦到宿主树；没声明的名字
  pnpm 也不会装）。npm registry 上独立包陈旧这一事实**不构成 npm 通道的阻塞项**，
  只影响 C3 的安装期噪音。
- 若不做统一（比如宿主某天移除路由器），npm 布局下独立副本**必然双包**：附录 A
  实验 A4 实测——宿主实例与私有副本的模块命名空间、导出构造器身份均不相等
  （`host === copy` → false）。插件 lib/index.js 自带挂载卫兵（"peer 依赖解析失败…
  link-host.sh 产物"提示，实测 A2 命中），能在缺 peer 时快速失败，算是补救体验。
- **结论：能安全 npm 分发，但"安全"以 peer 声明完整（C1）为前提**；未声明的
  `@deepseek-ai/*` import 在 npm 布局下要么 ENOENT 要么私有副本，二者都不可接受。

注：pnpm auto-install-peers 拉进 profile node_modules 的陈旧 peer 副本是**惰性死重**：
它们既不在 profile 清单（`installedProfilePackageNames` 只认 profile package.json 的
deps/peers，:768-770），也不在 profile 层闭包（`collectProfileScopePackages` 只从
selected bundles 的依赖闭包收集，:812-820），不产生 entries，拦截目标仍是安装树。

## 3. 问题三：client bundle 与 host-plane Remote 行在 npm 形态下的挂载

- **patch `name` 能否写 node_modules 解析路径**：能，但仅限**裸包名主体**。
  `'dsh-onebot-qq'`（走 exports `.`）与 `'dsh-onebot-qq/client'`
  （走 exports `./client`）在 npm 布局下可解析（附录 A 实验 A2/A3：主入口实际加载成功，
  其内部 peer 缺失才报错；./client 加载成功、报 window 未定义属浏览器面预期）。
  **裸深路径 `'dsh-onebot-qq/lib/settings-remote.js'` 会被 exports 表挡死**：
  实测 `ERR_PACKAGE_PATH_NOT_EXPORTED`（A3）——**exports 遮蔽在 npm 布局下不自然消解**，
  只对 file URL 形态失效（A3 对照：以文件 URL 直读 lib/client.js 成功）。
- **定案（按优先序）**：
  1. **包内补 exports 子路径**（N2）：`"./settings-remote": "./lib/settings-remote.js"`，
     patch 行写 `name: 'dsh-onebot-qq/settings-remote'`。语义最干净，
     且与 host-plane 行"config 覆盖须挂 patch 顶层同 id 行"的现行约束兼容。
  2. 退路：patch 行写相对形态
     `name: './node_modules/dsh-onebot-qq/lib/settings-remote.js'`
     （锚点 = patch 文件目录 = profile 目录 → file URL，绕过 exports；与 cordis.patch.yml
     模板头注释的"相对名锚定"考证一致，且实测文件 URL 不受 exports 约束）。
     绝对路径形态照旧可用但与 pnpm store 路径耦合，不推荐。
  3. client bundle（`exports ./client`）无需任何变更：客户端面照旧走 exports
     `./client`，npm 布局下同样成立（A3 实测）。
- 主条目 `dsh-onebot` 的 name 可从绝对路径迁到裸包名 `dsh-onebot-qq`
  （需 profile 清单 deps 含它或文件在 profile node_modules，两条件 pnpm 安装后天然满足）。

## 4. 问题四：peerDependencies 定案

**保持现范围（`>=0.1.5-rc.1`），并补齐缺失项；不改 optional peers，不依赖 npm override。**

- **兼容门（必须过）**：`evaluatePluginCompatibility`（`dsh-app-boot/lib/index.js:286-314`）
  对 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer 范围做
  `semver.satisfies(runtimeVersion, range, {includePrerelease:true})`（:300），不满足即拒绝安装/启动，
  豁免走 `compatibility.json` 精确版本对（`dsh/README.md:39`）。实测本机 semver：
  `0.1.7-rc.1` 满足 `>=0.1.5-rc.1`（true）；`0.0.1-rc.1` 不满足（false）。
  **现 peer 范围在 0.1.7-rc.1 下全数通过，收紧反而会在未来 dsh 升级时多一次不必要的不兼容**；
  收紧到"npm 独立包实际版本"更是南辕北辙——独立包根本不参与运行期解析（§2）。
- **peer 是功能性声明，不是元数据**：拦截只认 `peerDependencies`（§2.3），所以
  **必须新增**（N2 实施边界）：
  - `"@deepseek-ai/schemastery": ">=0.1.5-rc.1"`（lib/index.js:29 的动态 import；
    同时可从 dependencies 移除无用的 unscoped `schemastery`——lib 运行期零 import，
    仅类型层引用，避免 pnpm 装两套）；
  - `"@deepseek-ai/dsh-typert-protocol": ">=0.1.5-rc.1"`（settings-remote.js:114；
    虽有 FallbackRemoteError 降级（:99-118），但缺声明 = npm 通道永远走降级类，
    与 link-host 布局行为不一致）。
  注意 `evaluatePluginCompatibility` 只校验 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`
  前缀（:294-295），`@deepseek-ai/schemastery` 与 `@deepseek-ai/cordis` 声明不参与
  版本门，仅参与拦截。
- **workspace 范围逃生门**：`workspace:^/~/*` 在兼容门中等价于"等于当前运行时版本"
  （:278、296-299）。第一方 workspace 插件可用；npm 第三方发布**不要用**（pnpm 在
  非 workspace 环境无法解析该 spec）。
- **用户侧保证 peer 从宿主树解析——不需要 npm override / --legacy-peer-deps**：
  解析统一由宿主路由器在运行期完成（§2），与包管理器无关。link-host.sh 的 npm
  等价物**就是"什么都不做"**；唯一要做的用户侧动作是 C3 的
  `pnpm config`/`.npmrc`（profile 内 `auto-install-peers=false`）压掉安装期死重。
  link-host.sh 保留为仓库开发者布局（git checkout 直接跑测试）的专用工具，
  与 npm 通道互不干扰。

## 5. 推荐的 files 清单与安装文档要点

**files（N2 调整）**：

```json
"files": ["lib", "cordis.patch.yml"]
```

实测现 `files:["lib"]` 打出的包含 lib/**（含 types）+ LICENSE + 双语 README +
package.json，**不含** cordis.patch.yml、scripts/、dsh.plugin.json（附录 A A1）。
补 `cordis.patch.yml` 让用户拿到可直接合并的模板（头注释已自带用法说明）；
scripts/、dsh.plugin.json 继续不随包分发。package.json 必然随包 →
`readPeerNames` 在 npm 布局下读到的就是声明齐全的 peer 表（拦截前提）。

**安装文档要点（随 README 交付）**：

1. `dsh plugin --profile web add dsh-onebot-qq`（或 Web 侧 Plugins 页安装）；
2. profile 内 `.npmrc` 写 `auto-install-peers=false`（C3）；
3. 把 `cordis.patch.yml` 模板的两行 insert 合并进 profile 层
   `$DSH_HOME/profiles/web/cordis.patch.yml`：主条目 name 用
   `dsh-onebot-qq`，host-plane 行用
   `dsh-onebot-qq/settings-remote`（N2 补 exports 后），
   同一 insert 块内、config 覆盖挂 patch 顶层同 id 行；
4. **不得**在 profile package.json 手写任何 `@deepseek-ai/*`（C2）；
5. 兼容门被拒时按官方口径用 `dsh plugin allow-version ... --accept-risk` 显式豁免
   （`dsh/lib/plugin-Dr5KNRuz.js:77`）。

## 6. 给 N2/N3 的实施边界

**N2（包内改动，最小集）**：
- package.json：peerDependencies 增 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-typert-protocol`
  （两行，范围沿用 `>=0.1.5-rc.1`）；exports 增 `"./settings-remote"`；files 增 `cordis.patch.yml`；
  （可选）dependencies 移除 unscoped `schemastery`（确认 src/tests 无运行期引用后）。
- **不改** lib/ 任何 JS：client.js 的 `require("react")` 仅客户端面执行（浏览器 bundle
  提供运行时），不随 node 端装载路径评估。
- 不得触碰 link-host.sh 现行为（开发者布局仍依赖它）。

**N3（文档/验证）**：
- 安装文档按 §5 要点扩写（双语对称）；
- 回归项：以 pnpm 真装到测试 profile + `dsh --profile <p> --dump-config` 验证两行
  patch 可寻址、configEditor 写回路径不变；npm pack 后从 tarball 布局冒烟挂载。

---

## 附录 A：/tmp 干燥实验记录（全部只写 /tmp，未触仓库）

环境：Node v24.15.0；npm pack 自插件仓库（f9291a3）。

- **A1 pack 内容清单**（`npm pack --dry-run`，对 `/vol2/@appshare/Harness/workspace/project1/dsh-onebot`）：
  57 个文件 = `lib/**`（含 `lib/types/**`、`lib/settings-remote.js`、`lib/client.js`）+
  `LICENSE` + `README.md` + `README.en.md` + `package.json`。
  **cordis.patch.yml、scripts/、dsh.plugin.json 均未入包**——证实 §5 files 结论。
- **A2 npm 布局模拟 + 主入口解析**：tarball 解包到
  `/tmp/npm-exp/sim/node_modules/dsh-onebot-qq`。从该目录内脚本
  `import('@deepseek-ai/dsh-llm')` → `ERR_MODULE_NOT_FOUND`（A/B1：无宿主路由时
  peer 必须物理存在）。裸名 `import('dsh-onebot-qq')` **包本体解析成功**，
  随后命中插件自带挂载卫兵："peer 依赖解析失败或关键模块缺失 … Cannot find package
  '@deepseek-ai/schemastery' imported from …/lib/index.js"——与 C1 缺口完全吻合，
  且证明裸包名 name 形态在 npm 布局下可用。
- **A3 exports 遮蔽对照**（同布局裸名 import）：`./client` → 模块加载成功
  （报 `window is not defined`，浏览器面预期）；`.../lib/settings-remote.js` →
  **`ERR_PACKAGE_PATH_NOT_EXPORTED`**；`.../package.json` → 需 import attributes。
  对照：以 file URL 直读 `lib/client.js` 成功 → exports 只约束裸说明符，
  patch 的路径形态 name 不受其影响（支撑 §3 定案 2）。
- **A4 双包身份实验**：把宿主 `@deepseek-ai/dsh-util-values` 复制为私有副本后
  同时 import 两份：模块命名空间 `host === copy` → **false**；导出构造器同一性 →
  **false**——机械证实"npm 私有副本破坏 instanceof 身份"（link-host.sh 头注释），
  亦即 §2 结论的反面依据：统一必须靠宿主拦截，不能靠版本巧合。
- **A5 peer 范围兼容门实测**（宿主自带 semver，`/vol2/@appcenter/Harness/server/node_modules/semver`）：
  `satisfies('0.1.7-rc.1', '>=0.1.5-rc.1', {includePrerelease:true}) → true`；
  `satisfies('0.0.1-rc.1', …) → false`（支撑 §4"保持现范围"）。
- 仓库工作树核验：`git status` 全程干净，唯一新增即本文档。
