# 特征化钉底 ①：connection.ts 重连语义完整盘点（T1 · 只读）

> 基准：分支 `m0-hardening` @ `953919b`，工作树干净（已核实）。
> 本文全部行号以该 HEAD 为准。零代码改动，仅证据落盘。
> 用途：T4（EADDRINUSE 接管 + 自愈补缺）任务书的直接引用材料。

---

## 1. forward 模式重连退避梯子（现状完整语义）

### 1.1 常量与配置

| 项 | 值 | 证据（src/connection.ts） |
|---|---|---|
| 退避梯子 | `[2, 5, 10, 30, 60]` 秒，末值封顶重复 | L63（注释）、L64（`RECONNECT_BACKOFF`） |
| 内置放弃上限 | `MAX_RECONNECT_ATTEMPTS = 100` | L65 |
| 心跳间隔 | `HEARTBEAT_MS = 30_000` | L66 |
| 配置覆盖 | `reconnectMaxAttempts`：undefined→内置 100；>0→超过即放弃；≤0→永久重试（延迟仍封顶在梯子末值） | L49-54（注释）、L355-362（执行处） |

### 1.2 触发条件（哪些路径会进入重连）

`scheduleReconnect()`（L352-373）只在 forward 模式被两处调用：

1. **构造 WebSocket 失败**（同步 throw，如 URL 非法）：`connectForwardOnce()` L322-325 —— log error 后 `scheduleReconnect()`。
2. **socket `close` 事件**（含握手失败、心跳 terminate 引发的关闭）：L342-349 —— 仅当 `this.socket === socket`（非陈旧 socket，L343 守卫）时清理状态并重连。
   - socket `error`（L339-341）本身只 log warn，**不**直接调度重连；随后的 close 事件是重连的唯一入口。
3. **不触发重连的路径**：`stopping=true` 时 `connectForwardOnce` 直接 return（L315），`scheduleReconnect` 也有 `stopping` 守卫（L353）。

### 1.3 重连状态机细节

- 不可重入：`reconnectPromise !== undefined` 时跳过（L353）；timer 触发时先清 `reconnectTimer`/`reconnectPromise` 再拨号（L366-370）。
- 延迟计算：`RECONNECT_BACKOFF[min(attempts-1, len-1)] * 1000`（L363-364）；timer `.unref()`（L371）。
- 成功即归零：`socket.on('open')` 里 `this.reconnectAttempts = 0`（L329）。
- **重试不阻塞启动**：`start()` 同步返回（L170-180），`scheduleReconnect` 不被 await —— T4 验收项「启动路径不被重试逻辑阻塞」在现状已成立，属"保持"而非"新建"。

### 1.4 放弃后的终态（缺口 ① 的实证）

放弃分支：L358-362 —— `reconnectAttempts > max` 时 log error（提示重启插件/reload channel），然后 **return**，此后：

- `reconnectTimer`/`reconnectPromise` 均为 undefined、`socket` 为 undefined、`connectedFlag=false`；
- 没有任何定时器/事件源会再次触发拨号（socket 已销毁，close 不会再发）；
- 唯一恢复途径：外部再次调用 `start()`（L174 重入守卫此时放行，因为四个条件全空）或插件重启。
- **结论：放弃 = 进程内永久停机，无长周期恢复语义。PM 缺口 ① 确认成立。**

---

## 2. reverse 服务器 error 路径与 EADDRINUSE 现状（缺口 ② 的实证 + 强化）

### 2.1 现状代码路径

`startReverseServer()`（L258-310）：

- L262 创建 `WebSocketServer({host, port, maxPayload})`，L263 `this.server = server`。
- **error 处理器 L264-271**：`code === 'EADDRINUSE'` 分支（L266-269）仅 log error（给出改端口/停占用者的提示）后 `return`。无重试、无调度、无状态变更。PM 计划 §0.1「L266 附近躺平」**核实无误**。
- `close` 处理器 L307-309：`this.server = undefined`。

### 2.2 比 PM 预判更严重的事实（本次实证）

**EADDRINUSE 后 ws 不会发 `close` 事件** —— 用本仓库 node_modules 的 ws 实测：第二个 `WebSocketServer` 绑同一端口，事件序列只有 `b-error:EADDRINUSE`，**没有 `b-close`**。因此：

1. `this.server` 悬挂在死实例上（L263 赋值后永不清理）；
2. `start()` 重入守卫 L174（`this.server !== undefined` → return）**连手动重启都被挡住**；
3. 唯一出路是 `stop()`（L183-225 会 close server 并等 2s 强制 resolve，L206-223）再 `start()`，但插件运行期没有任何路径会自动走到这里。

**结论：缺口 ② 不只是"无重生路径"，而是"EADDRINUSE = 进程内不可逆死锁（连手动 start() 都进不去）"。T4 除退避重试外，必须处理死实例的清理（error 分支里显式 `server.close()` + 置空 `this.server`，或等价方案）。**

### 2.3 reverse 其余防护（与 W2-④ 无关但盘点在内）

- accessToken 必填：L259-261（空则 throw）。
- 拨入鉴权：timingSafeEqual Bearer 比对，失败 close 4401（L272-279）。
- last-wins + 防抖（churn guard）：60s 窗口内最多 5 次替换健康连接，超出 close 4000（L79-80、L282-298）。
- reverse 客户端断开：`attachSocket` 的 close 处理器 L386-395 只 log warn —— **本地不做任何等待重拨的兜底**，完全依赖 NapCat ws-reverse 自动重拨（settings-page-design.md §5 L253 的既有口径）。

---

## 3. 心跳 / 断链检测

| 项 | 语义 | 证据 |
|---|---|---|
| 机制 | 每 30s ping 一次；`now - lastPongAt >= 2×30s`（60s 无 pong）→ log warn + `socket.terminate()` | L409-427（判定在 L416-419） |
| lastPongAt 更新点 | forward open（L330）、pong（L335-338）、reverse attachSocket（L380） | 陈旧 socket 守卫：L336、L383 |
| terminate 之后 | 触发 close → forward 走 L342-349 重连；reverse 只 log（L386-395） | — |
| 在途调用保护 | close 时 `failAllPending(OneBotNotConnectedError)`；call 超时 L241-244；未连接时 call 直接 reject L235-238 | L347、L391 |
| 状态回调 | `setConnected` → `onStatus`；bridge 侧 onStatus(true) 触发 B6 离线队列 drain | L436-444；src/bridge.ts:293-296、src/outbound.ts:166-181 |

---

## 4. 对照竞品 onebot.js 的退避接管设计（/tmp/dsh-qq-onebot-bridge，MIT，只读）

竞品把端口占用拆成两层：**服务层如实返回失败 + 入口层后台退避重试**。

### 4.1 服务层：`start()` 永不抛、永不挂、幂等（lib/onebot.js）

- 返回 `{ok:true}` 或 `{ok:false, code, reason}`；**永不 throw**——`'error'` 只在有人订阅时才 emit，否则走 `server-error`（L257-262 及注释 L234-238：历史上 EADDRINUSE 未捕获抛错崩过宿主）。
- **幂等**：已监听时重复 `start()` 直接返回 `ok:true, already:true`，绝不关健康实例（L246-247 及 L240-244 注释：旧实现曾把在监听 socket 孤儿化）。
- 并发调用复用同一个 Promise（`#starting`，L248、L295）。
- **超时 ≠ 失败**：timeout 到点先看 `address()`，慢机器刚绑成功也算 ok（L285-290）。
- 失败分支就地 `wss.close()` 没绑上的实例，不留悬挂 Server（L275-277）——**这正是我们 2.2 缺的东西**。

### 4.2 入口层：15s 固定退避 + 日志去重 + 接管（lib/index.js L300-359）

- `RETRY_MS = 15_000` 固定间隔重试（L309），timer `.unref()`（L348），重试回调显式 `.catch`（L344-346，注释：未处理 rejection 在 Node CLI 宿主是致命的）。
- **绑不上时不启动桥**（避免双实例假象，L306 注释）。
- **稳态日志去重**：第 1 次 + 每 10 分钟各一条（`LOG_EVERY = 600s/RETRY_MS`，L315、L340）——竞品 v0.5.9 修的 P2「每 15s 刷一条 error ≈ 5760 条/天」。
- **接管时效**：CHANGELOG v0.5.9（CHANGELOG.md L160-166）真机三实例实测「占用者被杀后，重试方 15 秒内自动接管 6700」。

### 4.3 与本插件现状的差异矩阵

| 维度 | 竞品 | 本插件现状（953919b） |
|---|---|---|
| EADDRINUSE 结果形态 | `ok:false, code, reason`，永不抛 | 只 log，无结果形态（L266-269） |
| 死实例清理 | 失败分支就地 close（onebot.js L275-277） | **无**；`this.server` 悬挂（L263），实测不发 close |
| 重试调度 | 入口层 15s 固定退避，unref + catch | **无** |
| 日志去重 | 第 1 次 + 每 10min | 无（每次 error 都是一条） |
| 幂等 start | 已监听→already:true | 有（L174 守卫），但被死实例悬挂破坏（见 2.2） |
| 接管时效 | ≤15s 实测 | 无此能力 |
| forward 放弃后恢复 | —（竞品 reverse 为主） | 无（L358-362 终态） |

---

## 5. W2-④ 需要补的缺口清单（对 PM 预判的验证与扩充）

PM 预判「仅 ①放弃后长周期恢复 ②reverse 无重生路径」。**验证结论：①② 均确认，且 ② 比预判更严重；另补三个次级缺口。**

| # | 缺口 | 证据 | 严重度 |
|---|---|---|---|
| ① | forward 放弃后（attempts > reconnectMaxAttempts）无长周期恢复，进程内永久停机 | connection.ts:358-362 | 高（PM 已预判） |
| ② | reverse EADDRINUSE 后无重生路径，且 `this.server` 悬挂 → `start()` 重入守卫连手动重启都挡住（实测 ws 不发 close） | connection.ts:263-269、174；本文 §2.2 实测 | 高（比 PM 预判严重：不止"无自动重生"，手动恢复也被锁死） |
| ③ | EADDRINUSE/重试稳态无日志去重，长占端口时会刷屏 | connection.ts:267（每次 error 一条）；竞品对照 index.js:315,340 | 中 |
| ④ | reverse 客户端断开（含心跳 terminate）本地零兜底、零事件（只 log warn），NapCat 不重拨时无观测点 | connection.ts:386-395 | 低-中（依赖 NapCat 重拨是既有定案，可只补 trace 事件不改行为） |
| ⑤ | 重试调度须沿用竞品两条工程护栏：timer unref + 回显 catch（防宿主致命）、绑不上不启动桥语义 | 竞品 index.js:344-348 | 设计约束（非缺陷） |

**给 T4 的边界提醒**（与计划 §0.2/§5 R7 一致）：现有梯子 `[2,5,10,30,60]`、`reconnectMaxAttempts` 三态语义、成功归零（L329）、重入守卫（L174）**全部保留不动**；T4 的新增面 = ② 的死实例清理 + EADDRINUSE 退避重试（建议对齐梯子风格或竞品 15s 固定档 + 小时级上限）、① 的放弃后长冷却恢复、③ 的日志去重。

---

## 6. 对 PM 计划的纠正（本文范围）

1. **§0.2 行号微漂**：`RECONNECT_BACKOFF_LADDER` 实际在 **L64**（L63 是其注释行）；重连状态机入口 `scheduleReconnect` 在 **L352**（L353 是函数体首行守卫）。「L50-63」的 reconnectMaxAttempts 注释区间应为 **L49-54**。
2. **§0.1 核实无误**：error 处理器 L264、EADDRINUSE 分支 L266-269，「仅 log 后 return、无重试无恢复」属实。
3. **§0.2 语义误判（部分）**：「缺口仅在①②」不完整——② 实为"死实例悬挂 + 手动重启被 `start()` 守卫锁死"（本文 §2.2 实测），且存在 ③④⑤ 次级缺口（本文 §5）。
4. **§1 T4 验收项「断言启动路径不被重试逻辑阻塞」**：现状已成立（`start()` 同步返回、重试不被 await，connection.ts:170-180、352-373），T4 属"保持并加测试钉住"，非新增行为。
