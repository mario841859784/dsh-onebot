# tests/ — bridge.ts 五拆迁移地图（M2-T0）

> 目的：M2 把 `src/bridge.ts`（~2200 行）按已批准方案五拆 —— `commands.ts`（命令表）/ `inbound.ts`（入站管线）/ `outbound.ts`（出站管线）/ `interim.ts`（InterimTracker）/ `registry.ts`（会话注册表）+ `card-relay.ts`（卡片中继），五个 PR 顺序固定（顺序以 PM 任务书为准，本表按目标模块组织、与顺序无关）。
> 本文件是 PR1–PR5 的**测试迁移地图**：每个 PR 搬运代码时，按下表把对应用例同步搬到目标 spec，搬运前套件必须全绿，搬运后仍全绿（基线 tag：`pre-refactor-baseline`）。

## 0. 基线与现状

- 基线：vitest **212 passed + 1 todo**（15 文件，其中 bridge.spec.ts 65 用例）+ `tsc --noEmit` 0 错误（tsconfig 仅覆盖 `src/`，tests 依赖 vitest 转译）。
- 用例数单一事实源 = `npx vitest run` 实跑（DEVLOG §R6 惯例）。
- 已知 todo：`ensureChat concurrent first messages create exactly one agent per chat (M2-T0, unblock with B8a)` —— M2-PR3 的 B8a 修复后转正（见 §3 registry 段）。

## 1. 桩设施清单（bridge.spec.ts 内，迁移的第一步是提取共享）

| 设施 | 位置 | 说明 |
|---|---|---|
| `makeFakeAgents(sessionIds, captured, opts?)` | 模块级 | 假 AgentRegistry：create/resume 桩、`captured.followups/createdMeta`、`failCreateFor` 注入 id-collision |
| `makeHarness(opts?)` | 模块级 | 真实反向 WS（NapCat 拟真对端）+ MediaStore + 出站帧录制 `outbound`；opts：`failCreateFor / mediaDir / interimMessages / textImageThreshold` |
| `makeCmdHarness(opts?)` | **describe 闭包内** | 命令测试紧凑桩；opts：`agentPresets / dshHome / ocrResult / interimMessages / interimRecallMs / rateLimitPerMinute / restrictedMemberPrefix / commands / allowAllUsers`；返回 `sendText / sendTextAs / sendGroupTextAs / chats()` |
| `makeEvent(type, data)` | 模块级 | 构造 SessionEvent |
| `disconnect / reconnect / inboundAndDisconnect / sentTexts` | describe 闭包内 | M1-B6 断线/重连桩 |

**迁移前置（建议随 PR1 一并做）**：把桩设施从 spec 内提取到 `tests/helpers/`（如 `tests/harness.ts`），否则各目标 spec 无法共享。注意 `makeCmdHarness` 与 B6 helpers 现在嵌在 `describe('ChatBridge')` 闭包里。

## 2. 五拆边界 → 目标 spec 总览

| 拆出模块（src） | 目标 spec | 覆盖的 src 职责 |
|---|---|---|
| `commands.ts` | `tests/commands.spec.ts` | tryHandleCommand + handle{Model,Workspace,Id,Ver,Status,Mode,Retry,Ocr,Preset,Plan,Goal}Command + /help 表 |
| `inbound.ts` | `tests/inbound.spec.ts` | handleInbound/processInbound、policy/mention 门、媒体解析（buildBody/resolveMediaRef/resolveNasFile）、引用/转发展开、rateLimited、RESTRICTED_PREFIX 拼装 |
| `outbound.ts` | `tests/outbound.spec.ts` | sendToChat/sendMsg/sendForward/enqueue、t2i 卡片路径与分段回退、B6 断线补发队列 |
| `interim.ts` | `tests/interim.spec.ts` | sendInterim/settleLoop/loopBuffer/recallTimers/recalledInterimIds/lastHandledMessageId 去重 |
| `registry.ts` | `tests/registry.spec.ts` | ensureChat/loadMapping/saveMapping(+debounce)/retired 三件套/healSessionCollision/workspace&preset 接线 |
| `card-relay.ts` | `tests/card-relay.spec.ts`（或随 outbound.spec，按 PR 实际拆分定） | relayHostCards/renderPlanCard/renderQuestionCard |
| 留守 bridge.ts（薄层） | `tests/bridge.spec.ts`（残壳） | onSessionEvent/onSessionFlush 分发、canEditFiles/mediaSendRoots 门面、golden 端到端 |

## 3. 迁移地图（现有用例 → 目标 spec）

### 3.1 commands.spec.ts（PR1 目标）

| 现有用例（describe 'ChatBridge' 下 it 名） | 迁移注意事项 |
|---|---|
| routes slash commands before the model: /new opens a fresh session | 独立内联 harness（未用 makeHarness），迁移时改用共享桩；后半 sessionIds 断言依赖 registry.ensureChat/resetChat |
| routes slash commands before the model: /stop cancels, unknown goes to the model | 需手工把 agent.status 置 'running'（chats 内省）；未知命令 fall-through + `/tmp/x` 非命令一并覆盖 |
| blocks slash commands for non-admin users | 非管理员走 **group @-mention** 路径（私聊非管理员在 policy 层就被丢，到不了命令路由） |
| slash /new retires the chat agent and starts a fresh session on the next message | 段 1–2 属命令路由；段 3–4（retired 文件 + 重启跳过）实属 registry round-trip，建议 PR1 时拆段归位 |
| slash /model shows the current model and switches with provider/model | 桩挂宿主 ctx：`ctx.llm.listProviders/listModels` + `ctx.agentDefaultModel`；断言 selectionRef.current 与 saveSelection |
| slash /workspace switches the directory for the next session | 真实第二临时目录 + `realpathSync` 归一（macOS `/var`→`/private/var`）；resetChat 联动属 registry |
| slash /id /ver /status report the session state | /ver 读 package.json + `git rev-parse`（对工作目录敏感，离仓运行会回退 '?'） |
| slash /goal /plan /mode set per-chat state and forward to host plan command | commands.execute 桩必须收 AbortSignal（宿主无条件读 signal.aborted）；/goal 前缀断言属入站 prefixTurn |
| slash /retry re-feeds the last user message; /new clears it | busy 门（B7，interim/会话态）与 /new 清 lastFollowup（registry）联动 |
| slash /preset switches the agent preset for the next session | agentPresets.resolve 桩（未知 id 抛错）；resetChat 联动属 registry |
| slash /ocr recognizes the most recent inbound image | `ocrResult` 桩 = 覆写 connection.call 拦截 ocr_image；chatLastImagePaths 直填为既有捷径 |
| command messages carrying media skip media downloads (M1-C6a) | 包一层 `media.downloadUrl` 计数（桥上覆写实例方法的手法，迁移后照搬） |
| /ocr resolves the image registered from a command message (M1-C6a) | 用 base64 图片使下载计数保持 0，惰性解析才可观测 |
| slash /help lists the full routed command table for an admin（M2-T0） | 14 命令名快照——命令表增删时此测试是最先红的一面墙 |
| rejects every routed slash command for a non-admin with no side effects（M2-T0） | 14 命令 × 逐条拒绝；断言无 followup/无建 chat/宿主 commands.execute 未被调用 |

### 3.2 inbound.spec.ts（PR2 目标）

| 现有用例 | 迁移注意事项 |
|---|---|
| runs the full inbound→agent→outbound pipeline | 全文件首个用例，自带一套**独立内联 harness**；迁移时收敛到共享桩，避免双套设施 |
| sends an error notice on a failed turn | 触发源在 turn/end（session 事件），断言的是出站 ⚠️ 通知；归 inbound 触发侧，出站录制复用 |
| keeps hostile group nicknames from forging prefix lines (M1-A7) | 前缀拼装在 processInbound；正则锚定单行 |
| strips control characters and truncates overlong group nicknames (M1-A7) | 32 码点上限断言（`[...m[1]].length`） |
| rate-limits normal messages with one notice per window and lets commands through (M1-B7) | 注意现状：每 chat 首条消息先于 ChatAgent 存在、不计窗（注释已写明）；命令豁免 |
| rateLimitPerMinute 0 disables the inbound rate limit (M1-B7) | 0=禁用分支 |
| injects RESTRICTED_PREFIX for restricted group members but not for admins（M2-T0） | 注入点在 processInbound 文本拼装（任务书把它列入出站闸门矩阵，但技术上属入站拼装——按实际归属迁入 inbound；管理员不注的反断言一并带走） |
| inbound pipeline order: policy gate → mention gate → command router → media → quote → dispatch（M2-T0） | 用实例方法覆写（tryHandleCommand/buildBody/expandQuote/dispatchFollowup）记录调用序 + 前置门「无调用」反证；顺序即契约，五拆后顺序变了此测试先红 |

### 3.3 outbound.spec.ts（PR4 目标）

| 现有用例 | 迁移注意事项 |
|---|---|
| renders a t2i card for long replies (image segment) | 独立内联 harness（textImageThreshold: 10）；断言 image 段 + base64:// |
| falls back to text chunks when the card exceeds maxImageBytes | maxImageBytes: 500 压出回退路径；断言无 base64 帧 |
| queues interim-mode final flushes while disconnected and resends them in order on reconnect (M1-B6) | 依赖 `disconnect/reconnect/inboundAndDisconnect/sentTexts` 桩（随迁）；「settle 后停 50ms 再发下一轮」的时序注释必须保留 |
| queues instant finals and error notices while disconnected and resends them in order (M1-B6) | instant 模式 + 错误通知均 queuable |
| does not queue interim sends while disconnected (M1-B6) | 非 queuable 维持丢弃（throw 被吞为日志）——B6 白名单语义的反面 |
| caps the per-chat queue at 20 and drops the oldest while disconnected (M1-B6) | 21 条压容量；断言丢最旧 |
| drops queued finals older than the TTL instead of resending them (M1-B6) | fake timers + `shouldAdvanceTime`；「先停 50ms 让 final 入队再跳钟」的注释必须保留 |
| sendToChat while disconnected: queuable final parks and drains on reconnect, non-queuable throws（M2-T0） | 直接闸门特征化：queuable 解析 `[]`、非 queuable reject `OneBotNotConnectedError`；重连后只补发排队者 |

### 3.4 interim.spec.ts（PR5 目标）

| 现有用例 | 迁移注意事项 |
|---|---|
| buffers interim text when interimMessages is off and sends only the final step | interimMessages:false 的 pendingFinal 分支（onSessionEvent 的另一面） |
| merges ≥2 interim messages into one forward and recalls the originals at turn/end | 独立内联 harness；现状语义 = 摘要卡片 + 立即撤回（无合并转发），测试名里的 "forward" 是历史名，迁移时可更名但断言不变 |
| dedupes duplicate assistant/message events for the same message id | lastHandledMessageId 去重（streaming/usage 重发） |
| auto-recalls each interim individually after interimRecallMs even before turn/end | interimRecallMs: 40 压时序 |
| leaves a single interim as-is: no merge, no recall | 单条 = final，无卡片无撤回 |
| clears unmerged loop residue when a new user message arrives | 触发在 processInbound（入站清残留），断言主体是 loopBuffer/loopPending——归 interim，入站侧仅留触发覆盖 |
| sendInterim bookkeeping: buffer + id backfill + recall timer, with message-id dedupe（M2-T0） | 发送完成后 loopBuffer 记账 + recallTimers 挂表 + lastHandledMessageId 回填；同 id 重发不重复记账 |
| settleLoop drains the send chain before snapshotting: an in-flight interim is still summarized and recalled（M2-T0） | send_msg 延迟 120ms + turn/end 立即到 → 排空后才快照（迟到 interim 的 id 仍被摘要+撤回）；promise 依赖 attachment-order，重构链路时此测试最易暴露语义漂移 |

### 3.5 registry.spec.ts（PR3 目标）

| 现有用例 | 迁移注意事项 |
|---|---|
| preserves the chat mapping across stop() | 独立内联 harness；stop() 强制落盘语义（M1-E2 与 debounce 测试互补） |
| recovers from a create id collision with a suffixed session and records the truth | `failCreateFor` 注入；断言映射持久化的是真实 fallback id |
| persists the retired id when a turn/end reports an id collision | turn/end error 消息须匹配 `/persisted log on disk that does not match this live session|id collision/i` 才触发 heal |
| joins the configured agent preset and attaches the session to its workspace | workspaceRegistry.resolveByPath/create 桩 + mountedPresets 记录 |
| records the deployment default preset on the header when the config leaves it unset | 直调 ensureChat（绕过入站）——registry 内部路径直调是本文件惯例 |
| resume rejoins the preset a session recorded, over a conflicting config | 直调 loadMapping；断言 warn 日志含两个 preset id |
| resolveRecordedPreset: newest logged selection wins, else the creation header | 纯函数单测（唯一非 harness 用例） |
| ensureChat avoids a bare id that still owns a persisted log (stale retiring lost) | sessionPersistence.stat 桩：可 stat=有日志 → 立即退休 + 换后缀 id |
| resetChat retires the bare derived id alongside the current session id | 直调 resetChat；裸 id 与当前 id 双退休 |
| loadRetired keeps the current set on a corrupt file and saves atomically | 坏 JSON 不清空集（2026-08-17 回归）；原子写 = tmp+rename、无 .tmp 残留 |
| onSessionFlush debounces the mapping write; stop() forces the final save (M1-E2) | fake timers；覆写 saveMapping 计数（保留透传真写） |
| does not auto-create a workspace for a session whose cwd differs from workspacePath | 直调 attachToWorkspace；create 抛错即未调用 |
| restores the /workspace override from a resumed session cwd (方案 B) | 双 bridge 对照（非默认 cwd 恢复覆盖 / 默认 cwd 不恢复）；resume 桩返回 header.cwd |
| drops queued turn roles on /new so the fresh session cannot inherit them (M1-A2) | 跨界用例：/new（commands）清 pendingTurnRoles（registry 的 ChatAgent 生命周期）——按断言主体归 registry，commands 侧只留触发 |
| mapping round-trip: a stopped chat resumes with the recorded preset and the live default model（M2-T0） | 真 write（bridge1 stop 落盘）→ 真 read（bridge2 loadMapping）；钉死两点现状：**preset 从会话自身记录回填（压过 config）**、**model 无按会话持久化、resume 用当前 defaultModel()** |
| heals a session collision end-to-end: the chat rebuilds on a fresh id for the next message（M2-T0） | 补齐既有 collision 测试缺的「自愈后半段」：映射清空 → 下一条消息在新后缀 id 重建 + 回填映射 + retired 记录 |
| **ensureChat concurrent first messages create exactly one agent per chat（M2-T0，it.todo）** | 实测现状（2026-09-10，带 80ms create 延迟的双并发）：`agents.create` 被调 **2 次**、session id 相同（`onebot-private-10001`）、`chats.size=1`（后者覆盖，前者成孤儿）——已知竞态，B8a（M2-PR3）修复后转正：断言 create 恰 1 次、第二条消息等已建 chat |

### 3.6 card-relay.spec.ts（或随 outbound.spec，按 PR 拆分定）

| 现有用例 | 迁移注意事项 |
|---|---|
| relays host plan books and option cards to the chat (exit_plan_mode / ask_user_question) | 空文本块 + tool-call 载荷；同 id 重发不双重中继（依赖 dedupe 在 relay 之前） |

### 3.7 留守 bridge.spec.ts（残壳）或随 onSessionEvent 归属迁移

| 现有用例 | 迁移注意事项 |
|---|---|
| gates file edits by QQ admin for onebot chats (A1: non-QQ allowed) | canEditFiles 门面（bridge 层），非 QQ 会话默认信任 |
| freezes the edit role per turn in private chats: member turns stay denied and the admin turn is allowed (M1-A2) | turn/start shift FIFO；`allowAllUsers: true` 让成员私聊能过 policy |
| keeps a running member turn member-gated when an admin interjects in a group (M1-A2) | 运行中回合角色冻结（TOCTOU 语义） |
| fails closed to member on turn/start with an empty dispatch queue (M1-A2) | 宿主发起回合 fail-closed |
| golden: private plain-text round produces exactly one text send_msg（M2-T0） | 三条 golden 建议始终留在残壳：跨模块端到端，不随单模块迁移；五拆期间是全链路回归网 |
| golden: group @mention with a tool call yields interim → summary card → recall → final in order（M2-T0） | 顺序断言 interim → 摘要卡 → 撤回 → final；前缀正则锚定 @提及语义 |
| golden: a long final renders exactly one t2i image card segment（M2-T0） | 单帧单 image 段（`textImageThreshold` 选项已进 makeHarness） |

## 4. 迁移执行纪律（给 PR1–PR5）

1. 每个 PR 开始时套件全绿（含 todo）；结束时仍然全绿，用例数只增不减（迁移不改断言；测试名可随模块更名但断言语义不变）。
2. 先搬桩设施（§1），再搬用例；一条用例内跨模块的断言段按「断言主体」归位（跨界清单已在表内标注）。
3. M2-T0 新增的 12 条特征化测试是五拆的安全网核心：`inbound pipeline order`、`sendToChat 闸门`、`settleLoop 排空`、`mapping round-trip`、三条 golden —— 迁移中若它们变红，先当作行为漂移处理（停下核对方案），不是顺手改断言。
4. `it.todo`（ensureChat 并发）在 B8a 落地的同一 PR 内转正为真断言。
