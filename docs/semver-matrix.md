# semver 矩阵：peer 预发布分支验证（0.4.6）

## 背景

node-semver 只允许预发布版本命中「与该版本 major.minor.patch 元组完全一致且自身带
预发布标签」的比较符。旧 peer 范围 `>=0.1.5-rc.1`（无显式预发布分支）会静默排除
harness 预发布版本——实测 `0.1.7-alpha.2` 对旧范围 `semver.satisfies = false`，
即 dsh-market 兼容门会拒绝在 0.1.7 宿主安装本包。

## 新范围

对所有 `@deepseek-ai/*` 带 `>=0.1.5-rc.1` 形态的 peer
（dsh-agent / dsh-llm / dsh-session / dsh-system-prompt / dsh-tools /
dsh-typert-protocol / dsh-util-values / @deepseek-ai/schemastery）改为：

```
>=0.1.5-rc.1 <0.1.6-0 || >=0.1.6-alpha.1 <0.1.7-0 || >=0.1.7-alpha.1 <0.2.0-0
```

三条 `||` 分支分别覆盖 0.1.5 / 0.1.6 / 0.1.7 线，每条分支在其元组上带显式预发布
标签；`<X.Y.Z-0` 上界把未来大版本（0.2.0 及其一切预发布）挡在门外。

`@deepseek-ai/cordis ^4.0.2` 与 `schemastery ^3.18.0` 无预发布问题，未改动。

## 验证矩阵

工具：`server/node_modules/semver`（semver.satisfies）。命令：

```sh
node -e '
const semver = require("<server>/node_modules/semver");
const range = ">=0.1.5-rc.1 <0.1.6-0 || >=0.1.6-alpha.1 <0.1.7-0 || >=0.1.7-alpha.1 <0.2.0-0";
for (const v of ["0.1.5-rc.1","0.1.5-rc.2","0.1.6-alpha.1","0.1.6-alpha.2",
                 "0.1.7-alpha.1","0.1.7-alpha.2","0.1.7-rc.1","0.1.7-rc.2",
                 "0.2.0-0","0.2.0"])
  console.log(v, "=>", semver.satisfies(v, range));
'
```

输出（2026-09-25 实测）：

| 版本          | 期望  | 实测  |
| ------------- | ----- | ----- |
| 0.1.5-rc.1    | true  | true  |
| 0.1.5-rc.2    | true  | true  |
| 0.1.6-alpha.1 | true  | true  |
| 0.1.6-alpha.2 | true  | true  |
| 0.1.7-alpha.1 | true  | true  |
| 0.1.7-alpha.2 | true  | true  |
| 0.1.7-rc.1    | true  | true  |
| 0.1.7-rc.2    | true  | true  |
| 0.2.0-0       | false | false |
| 0.2.0         | false | false |

对照（旧范围 `>=0.1.5-rc.1`）：`0.1.7-alpha.2 => false`（修复前缺陷坐实）。

## 附注（0.4.7 已补齐）

`engines.dsh: ">=0.1.5-rc.1"` 同为无预发布分支形态；engines 为提示性字段（npm 仅
警告不阻断）。0.4.7 起已对齐 peer 三分支形态。

## engines.dsh 矩阵（0.4.7，同法实测）

范围：`>=0.1.5-rc.1 <0.1.6-0 || >=0.1.6-alpha.1 <0.1.7-0 || >=0.1.7-alpha.1 <0.2.0-0`

| 版本          | 期望  | 实测  |
| ------------- | ----- | ----- |
| 0.1.5-rc.1    | true  | true  |
| 0.1.5-rc.5    | true  | true  |
| 0.1.5         | true  | true  |
| 0.1.6-alpha.1 | true  | true  |
| 0.1.6-alpha.9 | true  | true  |
| 0.1.6         | true  | true  |
| 0.1.7-alpha.3 | true  | true  |
| 0.1.7-rc.2    | true  | true  |
| 0.1.7         | true  | true  |
| 0.2.0-alpha.1 | false | false |

对照（旧范围 `>=0.1.5-rc.1`）：`0.1.6-alpha.x / 0.1.7-alpha.x / 0.1.7-rc.x => false`（补前缺陷坐实）。
