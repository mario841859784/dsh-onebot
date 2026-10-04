# M1 MIT 合规核销表（T7 / W1·W2·W3 批次收口）

> 核查日期：2026-10-04。基线：分支 `m0-hardening` @ `f06e928`，未提交工作树（W1 trace 核心 + W1 四件 + W2 + W3/W6 设置页补齐）原样保留。
> 本仓许可：**BSD-3-Clause**（`LICENSE` / `package.json` `"license"` 字段一致）。
> 借鉴来源：`/tmp/dsh-qq-onebot-bridge`，许可 **MIT**（`LICENSE`：`Copyright (c) 2026 dsh-qq-onebot-bridge contributors`）。
> 核查口径：总计划 `dsh-onebot-w123-PLAN.md` §1 T7（「以参考设计自行实现为主，直接复制的文件须保留 MIT 版权与署名」）与 §4 R3。
> 本文档只做核查与记录，不改动任何源码/测试/配置/README；缺项如实列出，交由后续发版任务处置。

## 一、逐借鉴文件核销表

核销范围以 `git status` 新增 src 文件 + DEVLOG.md 2026-10-04 借鉴清单为准：`src/trace.ts`、`src/record.ts`、`src/inject.ts`、`src/replay.ts`、`src/health.ts`。

| # | 本仓文件 | 借鉴项清单 | 竞品出处（文件:行号，已逐一实证） | 本仓署名位置 | MIT 再分发要求（保留版权与许可声明） |
|---|---------|-----------|--------------------------------|-------------|--------------------------------------|
| 1 | `src/trace.ts` | ① traceId 形态 `t-<base36 秒>-<计数>`（本仓同款实现见 src/trace.ts:115）<br>② 4MiB 文件上限（本仓 `TRACE_MAX_BYTES` src/trace.ts:38）<br>③ 同因 5 分钟限频（本仓 `TRACE_SAME_CAUSE_WINDOW_MS` src/trace.ts:44）<br>④ 序列化防炸 jsonlSafe 思路<br>⑤ data 降级 stub<br>⑥ ok=false+非空 reason 的「静默分支可见化」原则 | ① `lib/trace.js:44-47`（`newTraceId`，`t-${base36 秒}-${counter}`）<br>② `lib/trace.js:116`（`maxBytes = 4 * 1024 * 1024`）<br>③ `CHANGELOG.md:182`（v0.5.9：「同一原因 5 分钟内只记一次」教训）<br>④ `lib/trace.js:92-98`（`jsonlSafe`）<br>⑤ `lib/trace.js:104-113`（`serializable` 降级 stub）<br>⑥ `lib/trace.js:61`（`mark()` 处注释） | `src/trace.ts:12-17` 文件头 MIT attribution 段（含版权行 `Copyright (c) 2026 dsh-qq-onebot-bridge contributors` + 「MIT License」字样），并指向 DEVLOG 2026-10-04 完整借鉴清单 | ✅ 通过 |
| 2 | `src/record.ts` | ① 录制行可回放形状：单行 JSON、业务字段白名单、文本截断 2000<br>② 2MiB 改名轮转<br>③ 录制脱敏（≥6 位数字 QQ 号遮蔽）<br>④ 注入帧不二次录制（防「注入→录制→回放→注入」自激） | ① `lib/inbox.js:28-43`（`serializeFrame`：`{v,ts,kind,frame}` 单行 JSON、业务字段、截断）<br>② `lib/inbox.js:65`（`maxBytes = 2 * 1024 * 1024`）<br>③ `lib/inbox.js:26,45`（`redactFrame`，6+ 位数字遮蔽）<br>④ `CHANGELOG.md:677`（v0.4.0 阶段 3：「注入的帧不会被二次录制」） | `src/record.ts:22-27` 文件头 MIT attribution 段（含出处 `lib/inbox.js` + 版权行 + MIT License 字样） | ✅ 通过 |
| 3 | `src/inject.ts` | ① 注入通道语义：`injectEnabled` 默认关、`injectIntervalMs` 间隔轮询、历史行跳过并说明、`injectDryRun` 默认 true 拦截全部出站并计数<br>② 异步 agent 回合的最终回复同样被拦（v0.5.2 类比的安全边界教训）<br>③ 真实消息解除标记不连坐 | ① `CHANGELOG.md:683-686`（v0.4.0 阶段 3「事件注入」条目：默认关、轮询、历史行跳过、dry-run 默认 true）<br>② `CHANGELOG.md:701`（「注入安全边界（真机测试抓到的漏网）」——**注意：该条目实际位于 v0.4.0 阶段 3 小节内，非 v0.5.2**，见下「勘误」）<br>③ 同上 `CHANGELOG.md:701`（「收到真实消息时立即解除标记，绝不连坐真人」） | `src/inject.ts:23-28` 文件头 MIT attribution 段（含版权行 + MIT License 字样 + CHANGELOG 出处） | ✅ 通过（出处章节引用有一处偏差，见勘误①） |
| 4 | `src/replay.ts` | 「录制 → 经真实管线离线回放 + dry-run 拦截 + 决策归因」概念 | `control/lib/replay.mjs:1-14`（文件头：「真实桥代码 + dry-run on + `start()` 永不调用 + agent 为模拟回复」） | `src/replay.ts:23-28` 文件头 MIT attribution 段（含出处 `control/lib/replay.mjs` + 版权行 + MIT License 字样） | ✅ 通过 |
| 5 | `src/health.ts` | 「健康快照 + 脱敏诊断包」概念（硬约束④可体检/⑤可导出的落位思路） | `CHANGELOG.md:712-719`（v0.4.0 阶段 4 硬约束验收台：④可体检 / ⑤可导出） | `src/health.ts:18-21` 文件头 MIT attribution 段（含版权行 + MIT License 字样 + v0.4.0 出处） | ✅ 通过 |

**核销结论：5/5 文件全部通过。** 每个借鉴文件头部均含 MIT attribution 注释（指明借鉴项、出处文件、MIT License、版权行 `Copyright (c) 2026 dsh-qq-onebot-bridge contributors`），且五个文件均属「以参考设计自行实现为主、借鉴点为语义/常量/原则级」——无整文件复制；DEVLOG.md 2026-10-04 两条借鉴清单（W1 核心 :753、W1 四件 :767）与文件头署名互相印证，逐项与竞品出处比对一致。

### 勘误（不代改，交后续任务处置）

| # | 位置 | 现状 | 应为 | 严重度 |
|---|------|------|------|--------|
| ① | `src/inject.ts:26`（attribution 段）与 `DEVLOG.md:761,763,767` | 引作「CHANGELOG **v0.5.2** 注入安全边界」 | 「注入安全边界（真机测试抓到的漏网）」条目实际位于竞品 CHANGELOG **v0.4.0 阶段 3** 小节内（`CHANGELOG.md:701`，v0.4.0 节起于 :669，v0.5.2 节起于 :546）；v0.5.2 节内仅有「发送被拦（限流或注入回合）都有中文 reason」一句顺带提及（:557），安全边界本体不在该节 | 低（出处引用偏差，不影响署名有效性；源码在红线清单内，本任务不改） |

## 二、清单外借鉴补充核查（如实记录）

DEVLOG 2026-10-04 五个条目中，除上表 5 文件外还记录了以下对竞品的参照。逐项核查均为**设计语义/默认值/话术级借鉴，无逐字代码复制**（ideas 与语义不受版权保护，不触发 MIT 再分发义务），且 DEVLOG 均已如实记录出处与取舍：

| 位置 | 借鉴内容 | 竞品出处（DEVLOG 记载） | 评估 |
|------|---------|------------------------|------|
| `src/inbound.ts:176-177`（注释「aligned with the MIT reference」） | W2-② 去重窗口默认 300s | 竞品 `dedupWindowSeconds` 默认值（CHANGELOG v0.4.0 录制条目语义族） | ✅ 语义级，无需文件头署名 |
| `src/outbound.ts:93-94`（注释「aligned with the MIT reference」） | W2-③ 主动写分钟/日限额默认 20/500 | 竞品默认值（DEVLOG :733「对齐竞品」） | ✅ 语义级，无需文件头署名 |
| `src/connection.ts`（W2-①④，DEVLOG :723） | EADDRINUSE 退避接管 + forward 自愈的入口层语义（15s 固定退避、日志去重） | 竞品两层方案（DEVLOG :723 明确记录「取其入口层语义内联」「服务层方案不取」） | ✅ 语义级，且为明确取舍后的自行实现 |
| `src/settings-remote.ts` / `lib/client.js`（W6，DEVLOG :774） | 「非默认」徽标行话术与白名单拒绝语义；竞品自写 tmp+rename 原子写明确**不采用** | 竞品 CHANGELOG v0.6.0 设置面板节 | ✅ 话术/语义级 |

## 三、遗留建议（交后续发版任务，本任务不执行）

1. **勘误①**：修正 `src/inject.ts` attribution 段与 DEVLOG 三处「v0.5.2 注入安全边界」为「v0.4.0 阶段 3（含 :701 注入安全边界条目）」——随 0.7.0 发版批次的文档同步一并处理。
2. **第三方声明文件（可选加固）**：当前 MIT 义务由 5 个文件头署名 + DEVLOG 借鉴清单履行。若发版包（npm tarball）希望更进一步，可增加 `NOTICE`/`THIRD-PARTY-NOTICE.md` 汇总 MIT 出处与版权行——MIT 许可文本本身建议随附（当前仅文件头写明「MIT License」字样，未附全文）。属可选加固项，非本次核销的阻塞缺项。

## 四、核查方法与证据

- 竞品侧：`/tmp/dsh-qq-onebot-bridge` 的 `LICENSE`（MIT，版权行如上）、`lib/trace.js`、`lib/inbox.js`、`control/lib/replay.mjs`、`CHANGELOG.md`（v0.4.0 :669 起、v0.5.2 :546 起、v0.5.9 :152 起、v0.6.0 :21 起）——上表行号均已用行号精读实证，非凭 DEVLOG 转抄。
- 本仓侧：`git status`（5 个 src 新文件在列）、`src/*.ts` 文件头逐段读取、`package.json`（`license: BSD-3-Clause`、`scripts.replay`）、`LICENSE` 首部。
- 本文档自身为本次任务唯一新增文件（`docs/m1-mit-compliance.md`），工作树其余改动为同批前序任务产物，原样保留，未触碰。
