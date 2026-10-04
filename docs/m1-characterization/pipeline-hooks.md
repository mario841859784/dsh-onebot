# 特征化钉底 ③：inbound → bridge → outbound 全链路决策点盘点（T1 · 只读）

> 基准：分支 `m0-hardening` @ `953919b`。竞品参照：/tmp/dsh-qq-onebot-bridge/lib/trace.js（MIT，只读）。
> 用途：T2（traceId 贯穿 + 决策事件 jsonl + 中文 reason 矩阵）任务书的挂点清单与 schema 依据。

## 0. 链路骨架（调用序）

```
OneBotConnection.onFrame (connection.ts:455-504)
  └─ onMessage(event) → ChatBridge.handleInbound (bridge.ts:406-415)
       └─ normalizeOneBot11 (inbound.ts:73-103)        ← null = 不可处理
       └─ InboundPipeline.processInbound (inbound.ts:174-269)
            政策门 → @门 → 命令路由 → 媒体/引用/转发展开 → 限流 → dispatchFollowup (bridge.ts:424-447)
                 └─ agent.followup → 宿主 agent-loop → session 事件
                      └─ ChatBridge.onSessionEvent (bridge.ts:612-653)
                           turn/start·assistant/message·turn/end
                           └─ InterimTracker / OutboundPipeline.sendToChat (outbound.ts:93-147)
```

traceId 的天然锚点：`bridge.handleInbound`（bridge.ts:406，入站侧唯一入口，能拿到原始 event）+ `onSessionEvent`（bridge.ts:612，出站侧唯一入口，经 `bySession` 映射回 chatId，bridge.ts:614）。

---

## 1. 入站决策点清单（现状 + 行号 + 现有日志）

| # | 分支 | 位置 | 现状日志 | 是否需要中文 reason |
|---|---|---|---|---|
| 1 | 非聊天事件 / 缺 message_type / 缺 user_id → normalize 返回 null，handleInbound 静默 return | inbound.ts:73-77；bridge.ts:410 | **无** | ✅（notice/meta/未知类型各给一条：如「非聊天消息事件，不处理」） |
| 2 | 非法 WS 帧（非 JSON） | connection.ts:458-461 | warn `dropping non-JSON WS frame` | ✅（复用现有文案） |
| 3 | notice/request 事件刻意忽略 | connection.ts:502-503（注释） | **无** | ⚠️ 可选（量大，建议只记 debug 或不记，见 §6 轮转护栏） |
| 4 | stopping 中入站丢弃 | bridge.ts:407 | **无** | ✅（「插件停止中，消息丢弃」） |
| 5 | ignoreSelf 命中 | inbound.ts:176-178 | **无**（纯静默） | ✅（「机器人自己的消息已忽略」） |
| 6 | 私聊白名单外 | inbound.ts:181-184 | debug `ignoring DM from non-allowed user` | ✅ |
| 7 | 群白名单外 | inbound.ts:186-189 | debug `ignoring group message from non-allowed group` | ✅ |
| 8 | 群聊未 @（requireMention） | inbound.ts:192-196 | debug `ignoring unmentioned group message` | ✅（竞品教训：文本 @ 误判也在此分支，v0.5.9 CHANGELOG「@ 了不回」一节） |
| 9 | 命令被路由消费 | inbound.ts:226-228 | 命令内部各有日志 | ✅ ok=true（「已由命令 X 消费」） |
| 10 | 媒体解析失败：resolve 返回 undefined | inbound.ts:319-330 | **无**（占位符静默丢失） | ✅（「媒体解析失败/超时」） |
| 11 | 引用展开失败（get_msg throw / 空文本） | inbound.ts:369-386（catch L382-385） | debug `quote expansion failed` | ✅（失败降级为空引用，消息仍继续——ok=false 但不拦截） |
| 12 | 合并转发展开失败/空 | inbound.ts:508-516 | info `forward expansion failed`（catch L514） | ✅ 已有自描述文本 `[合并转发 id=… 未展开: api-error/empty-response/no-text-nodes]`（L509-510,515），reason 可直接引用 |
| 13 | NAS 文件获取失败链（直链失败→get_file 失败→超限→全失败） | inbound.ts:406-457（终态 warn L456；超限 L433-435） | warn×3 + debug×2 | ✅（超限/无可用来源各一条） |
| 14 | 媒体落盘失败 | inbound.ts:461-474（catch L470-473） | warn `media write failed` | ✅ |
| 15 | STT：空转写 / 失败 | inbound.ts:358-366（L361 静默、L363-365 warn `STT failed`） | warn（仅失败） | ✅（失败；空转写给 info） |
| 16 | **限流丢弃**（B7 滑动窗口） | inbound.ts:252→274-290 | 通知文案已有中文（L287 `⏳ 消息太频繁…`），**决策本身无日志** | ✅（「消息频率超限，已丢弃」；通知 sendToChat 失败被 `.catch(()=>undefined)` 吞掉，L287——也该记） |
| 17 | 展开后空内容丢弃 | inbound.ts:259-260 | **无** | ✅（「无有效文本内容」） |
| 18 | dispatch 链路异常（ensureChat/followup 抛错） | bridge.ts:412-414 | error `inbound handling failed`（含堆栈） | ✅（复用 describeError） |
| 19 | 语音转写投递时无活跃会话 | bridge.ts:581-591（L583-586 debug） | debug | ✅（「转写结果无处投递」） |

## 2. 会话事件 / 出站侧决策点清单

| # | 分支 | 位置 | 现状日志 | 中文 reason |
|---|---|---|---|---|
| 20 | session 事件早退：stopping / 无 chatId 映射 / chat 不匹配 | bridge.ts:613-617 | **无** | ⚠️ 前两者记 debug；不匹配属竞态可忽略 |
| 21 | turn/end 错误通知发送失败 | bridge.ts:636-641（catch 吞掉 L638） | **无**（发送失败静默） | ✅（「错误通知发送失败」） |
| 22 | session flush 失败 | bridge.ts:648-650 | warn | ✅ |
| 23 | 断连时入队（queuable）/ 断连直接抛 | outbound.ts:95-100 | **无**（入队静默） | ✅（「连接断开，回复已排队等待重连补发」/「连接断开，发送失败」） |
| 24 | 入队满丢弃最旧 | outbound.ts:151-159（L155 warn） | warn `pending send queue full … dropped oldest` | ✅ |
| 25 | drain 时 TTL 过期丢弃 | outbound.ts:172-174 | **无**（静默丢） | ✅（「排队回复超时(5min)丢弃」） |
| 26 | 补发失败 | outbound.ts:177-179 | warn `queued resend failed` | ✅ |
| 27 | 敏感词审计命中 | outbound.ts:102-105 | warn `sensitive outbound audit` | ✅ ok=true 审计事件（不拦截） |
| 28 | t2i 卡片超 maxImageBytes 降级文本 | outbound.ts:131-133 | warn | ✅ |
| 29 | t2i 渲染失败降级文本 | outbound.ts:134-136 | warn | ✅ |
| 30 | strip 后空文本不发送 | outbound.ts:139-143 | **无** | ✅（「纯文本为空，未发送」） |
| 31 | sendMsg 目标非法 | outbound.ts:222-227 | 抛 OneBotActionError | ✅ |
| 32 | sendForward 目标非法 | outbound.ts:240-242 | 抛 | ✅ |
| 33 | OneBot action 超时 / 失败 / 未连接 reject | connection.ts:236-238、241-252（retcode+wording L474-477） | 上游各自捕获 | ✅（retcode/wording 进 reason） |
| 34 | interim 各失败分支（final/interim send 失败、recall 失败、summary t2i 降级） | interim.ts:220,249,260,277,304,372,377,386 | warn/debug 已有 | ✅（挂同一 trace 通道即可） |
| 35 | 打字指示器 pulse 静默失败 | bridge.ts:731-740、743-754（catch 吞） | **无** | ⚪ 不需要（低价值高频） |

现状日志调用总计：inbound.ts 14 处、outbound.ts 8 处、bridge.ts 12 处、interim.ts 8 处、connection.ts 15 处（grep `log(` 实测）。**其中"纯静默、零日志"的丢弃分支共 6 处（#1、#4、#5、#16 决策本体、#17、#23、#25、#30）——这正是竞品硬约束①「无静默分支」的靶子。**

---

## 3. 竞品 trace.js 的词表与事件结构（参照）

- **stage 词表**（trace.js:16-39，22 个，中英对照）：inbound/whitelist/quiet/dedup/filter/verify/keyword/game/command/mention/quote/media/transcribe/agent/reply/ratelimit/notice/request/timer/action/inject/replay。
- **事件结构**（trace.js:148-163）：`{ v:1, ts, id(traceId), level, module, stage, ok, reason?(≤300字符), ms?, chatKey?, data? }`；`ok=false + reason 非空` 是「静默分支可见化」的载体（:61 注释）。
- **traceId 形态**：`t-<base36 秒>-<base36 计数>`（:44-47），短且可排序。
- **内存环 + 落盘**：ring 500 条（:116,120,178-179）；文件写 `appendCappedLine`，maxBytes 4MiB / keepBytes 512KiB 尾部保留（:116,180-183）；序列化防炸 `jsonlSafe`（:92-98，不可序列化时降级为 error 事件）；写失败计数 `dropped`（:182）。
- **限频教训**（CHANGELOG v0.5.9「修掉 4 条静默分支」节）：**同一原因 5 分钟只记一次**，防 TTS 未启动之类场景刷屏。
- **`step()` 包装**（:67-84,191-201）：异步外部调用（OneBot action/STT/模型回合）计时 + 失败记 error 再 rethrow。

## 4. 本插件 traceId 事件 schema 建议

```jsonc
// 每行一个 JSON 对象，jsonl 落盘
{
  "v": 1,
  "ts": 1760000000000,          // ms 时间戳
  "traceId": "t-<base36s>-<n>", // 沿竞品形态；入站在 bridge.handleInbound 生成（bridge.ts:406）
  "stage": "mention",           // 见下方词表
  "ok": false,                  // false = 被拒/失败/丢弃，reason 必须非空中文
  "reason": "群聊未 @ 机器人",   // ≤300 字符
  "chatId": "group:123",        // 对齐 buildChatId（inbound.ts:80）
  "messageId": "10001",         // OneBot message_id（有则带，T5 去重的键）
  "ms": 12,                     // 距上一事件/步骤耗时（可选）
  "data": {}                    // 白名单小对象（禁止 token/QQ 明文外泄，与 T3 脱敏联动）
}
```

**stage 词表建议**（覆盖 §1/§2 全部分支，竞品词表裁剪 + 本插件特有）：

| stage | 覆盖分支 | 中文标签 |
|---|---|---|
| `inbound` | 收到消息（每消息首事件，竞品 :143 同构） | 收到消息 |
| `normalize` | #1 | 消息归一化 |
| `self` | #5 | 自身消息过滤 |
| `whitelist` | #6 #7 | 白名单 |
| `mention` | #8 | 群聊 @ 门 |
| `command` | #9 | 命令 |
| `media` | #10 #13 #14 | 媒体处理 |
| `quote` | #11 | 引用解析 |
| `forward` | #12 | 合并转发 |
| `transcribe` | #15 | 语音转文字 |
| `ratelimit` | #16 | 入站限流 |
| `dispatch` | #17 #18 #19 | 交给模型 |
| `outbound` | #23 #27 #28 #29 #30 #31 #32 #33 | 出站发送 |
| `queue` | #23 #24 #25 #26 | 离线队列 |
| `interim` | #34 | 中间消息 |
| `agent` | turn/start·turn/end（bridge.ts:618,634，关联用） | 模型回合 |
| `notice` | #21 #22 | 通知 |

**落盘与异步护栏（T2 验收对齐）**：

1. **异步队列写**：管线内只 `queue.push`，单一 writer 定时 flush（appendFile 追加）；队列上限（如 1000 条）+ 满时丢最旧并计数——管线永不 await 写盘（计划 T2「P95 附加延迟 <5ms 量级」的可测代理即此）。
2. **轮转**：按大小阈值（建议 maxBytes 4MiB 对齐竞品）触发 `trace.jsonl → trace-<ts>.jsonl` 改名轮转，**旧文件保留、保留 N 份**（计划 T2 验收「轮转在阈值处触发且旧文件保留」——故用改名轮转而非竞品的截断保留尾部；若沿用竞品 appendCappedLine 截断式，需先与验收措辞对齐）。
3. **同因限频**：`stage+reason` 归一后 5 分钟内只落盘一条（竞品教训，R4 防刷屏）；计数在内存环里保留真实次数。
4. **序列化防炸**：写前 `JSON.stringify` try/catch，坏对象降级为 error 事件（竞品 jsonlSafe :92-98）。
5. **默认关闭**：`traceEnabled=false`（默认）→ 生成 traceId 的开销也省掉（或仅生成不记录），零文件写入、零行为差异；`traceDir` 独立于 mediaDir。

## 5. traceId 贯穿的挂点设计（最小侵入）

- **入站生成**：`bridge.handleInbound`（bridge.ts:406）入口处 `traceId = newTraceId()`；因 `processInbound` 全程 async 同链，可用 `AsyncLocalStorage` 隐式传递，**或**在 `NormalizedInbound` 旁以显式参数/包装对象传递（inbound.ts:125-160 的 `InboundContext` 加一个可选 `trace?` 钩子），后者对测试更友好、对现有 383 用例零破坏（全部可选参数）。
- **跨流关联（入站 ↔ 回合出站）**：session 事件与入站不在同一 async 链，需 chat 级关联表 `Map<ChatId, traceId>`：dispatch 时登记（bridge.ts:424-447），`onSessionEvent`（bridge.ts:612-653）按 `chatId` 取回并打 `agent`/`outbound`/`interim` 事件；turn/end 后清除。竞品用 `chatKey` 字段贯穿（trace.js:55,161）即同一思想。
- **出站动作级**：`OutboundPipeline.enqueue`（outbound.ts:200-209）与 `connection.call`（connection.ts:234-254）可包 `step()` 式计时包装（竞品 trace.js:191-201）。
- **connection 层**（不依赖 trace 启用）：onFrame 的 #2、call 超时 #33 已有 log；trace 挂点放在 bridge/pipeline 层即可，transport 层不引 trace 依赖（保持 connection.ts 可独立使用，L153-168 注释的约束）。

## 6. 中文 reason 覆盖矩阵（汇总：哪些分支必须给 reason）

**必须（ok=false 丢弃/失败，12+ 处）**：#1 #4 #5 #6 #7 #8 #10 #13 #14 #15 #16 #17 #18 #21 #23 #24 #25 #26 #28 #29 #30 #31 #32 #33 #34。
**必须（ok=true 关键决策，便于回放链路）**：#9（命令消费）#27（敏感词审计）#12（转发展开结果）以及 `dispatch` 成功事件。
**可选/debug 级**：#3（notice/request 量大，建议限频或不记）#11（降级不拦截）#19 #20 #22。
**不需要**：#35（打字指示器）。

每条 reason 均为**非空中文字符串**（计划 T2 验收口径），实现时以常量表集中维护（对齐竞品 `STAGES` 中文标签 :16-39 的做法），便于测试枚举穷举。
