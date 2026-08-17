# dsh-onebot 适配器开发日志

> QQ 机器人（dsh × NapCat / OneBot 11）适配器开发全记录
> 起始：2026-08-14（由 Hermes onebot 插件移植而来，源 DEVLOG 见 onebot-adapter-port/plugin/onebot/DEVLOG.md）

## 0. 开发规范（沿用 Hermes 惯例）

1. **能外置的模块就外置**：纯逻辑拆独立模块（src/cq.ts、src/split.ts、src/t2i/*），bridge.ts 只留调用点
2. **所有改动必须写本日志**：时间线、根因、修复、验证
3. **测量=绘制**（t2i）：换行/列宽统一走 segWidth，像素级验证右缘 ≤790

---

## 1. 项目概述

dsh 的 QQ 渠道通过 **OneBot 11 协议**接入 NapCat，本插件实现完整平台适配器（外部插件形态，与 dsh-vision 同款：纯 TS、零 Python、原生 Cordis、不改核心）：

```
NapCat (QQ) ←— 反向 WS —→ dsh-onebot 插件 ←— dsh Agent（每个会话一个）
                              │
                              ├─ src/cq.ts          CQ 解析/反转义/@检测/表情映射
                              ├─ src/connection.ts   反向服务器+正向客户端、echo、重连
                              ├─ src/media.ts        入站媒体四路解析、6h 清理
                              ├─ src/stt.ts          ffmpeg+whisper 语音转写
                              ├─ src/split.ts        标点分段、Markdown 剥离、敏感审计
                              ├─ src/bridge.ts       chat→Agent、session/event 出站、映射持久化
                              ├─ src/tools.ts        qq_* 模型工具（媒体/合并转发/NapCat API 白名单）
                              └─ src/t2i/*          文字图卡片渲染器（@napi-rs/canvas）
```

- **形态**：外部插件 `~/dsh-plugins/dsh-onebot/`，挂载在 `~/.dsh/profiles/web/cordis.patch.yml`（profile 层）
- **协议**：OneBot 11（兼容 NapCat / Lagrange / LLOneBot / go-cqhttp）
- **连接**：反向 WS（默认 8643），NapCat ws-reverse 拨入
- **会话**：每个 QQ 会话一个持久 Agent（session id 稳定派生），重启自动 resume
- **依赖**：@deepseek-ai/*（宿主符号链接）+ ws + @napi-rs/canvas + fontkit

---

## 2. 开发时间线

### 2026-08-14（移植日，主代码 12 小时）

| 时间 | 工作 |
|---|---|
| 上午 | 读 DSH AGENTS.md；双路调研（Hermes 插件规格子代理 + DSH 插件架构子代理）；确认 dsh 0.1.0-rc.6 npm 包与 dsh-vision 外部插件先例 |
| 上午 | 脚手架：dsh-onebot 包结构、link-host.sh（宿主 @deepseek-ai 符号链接）、build.sh、npm 依赖 |
| 上午 | 协议/桥接/工具/权限/提示词九模块（cq/chat/connection/media/stt/split/bridge/tools/prompt/index） |
| 上午 | 42 个 vitest（真实 WS 对端 + 全管线）全过；真实宿主加载冒烟（dsh web --patch） |
| 上午 | **E2E 四连修**：stop() 擦映射、resume 模型选择引导期默认值、session id collision 自愈、媒体目录 ENOENT（见 §4） |
| 上午 | 入站消息 source 归属改为 plugin（会话日志区分平台消息） |
| 上午 | 线上部署：发现挂载层两个坑（$HOME 字面量不被 loader 插值、config.yaml 不是 patch 层）→ 改挂 profile 层 cordis.patch.yml + 绝对路径；热加载 1 秒生效 |
| 上午 | NapCat 拨入成功（<port> ESTABLISHED）；真实 QQ 链路验证：hello → 模型回复 → turn completed；重启记忆验证（暗号柚子跨重启保留） |
| 上午 | **t2i 里程碑**：按 T2I_DEV_DOC 整理方案获批；canvas 实验（系统字体家族/emoji 彩色/ttc/逐字形回退）；六模块落地（fonts/canvas/measure/parser/elements/index） |
| 上午 | t2i 修三处：fontkit ESM 入口是浏览器构建（改 createRequire 惰性加载）、表格数据结构维度、嵌套 required 不被参数 DSL 支持 |
| 上午 | **emoji 代理对 bug**：JS 字符串索引按 UTF-16 码元拆开 emoji → 高代理位被分类成 CJK 渲染成黑字形（像素扫描发现）→ 全链路改按码点迭代 |
| 上午 | t2i 集成：textImageThreshold=150 卡片路径 + 渲染失败回退分段；76/76 全过；像素右缘扫描 ≤790；view_image 视觉校准通过 |
| 上午 | t2i 确定性 E2E：长消息 → 出站 types=[image] fileLens=[193629]（单图片段 193KB 卡片） |
| 上午 | **split 分段修复**：需要我做什/么直接说 中间截断 → 对齐原版 _split_reply（窗口内向后找标点、标点集去掉 .:;、空格回退、代理对保护）79/79 全过，热加载上线 |
| 下午 | 本日志 |
| 下午 | **loop 中间消息合并转发+撤回**（按 onebot-adapter-port/plugin/onebot/loop-merge-implementation.md 移植）：interimMessages=true 改为「延迟一条」策略（assistant/message 先暂存，下一条到达时上一条才发出并入缓冲；turn/end 结算：缓冲 ≥2 条 → send_forward_msg/private_forward_msg 合并转发 + delete_msg 撤回原消息 → 再发 final 走原路径含 t2i/分段）；新用户消息到达清空缓冲（防跨轮合并）。踩坑：turn/end 结算任务在发送链上 await sendToChat 造成**链上死锁**（sendToChat 排队在自身之后）→ 结算只走链、final 发送放结算完成的 .then 里再入链。旧测试语义更新（send 从 assistant/message 时点移到 turn/end 后）；新增 3 测试（≥2 合并+撤回+final、单条不合并、新消息清残留）；85/85 全过，构建热加载；
| 下午 | **loop 结算顺序调整**（用户要求）：final（含 t2i 卡片）先发，t2i 发送完成后再合并转发+撤回——先给用户看结果卡片，中间评论再收敛。测试断言同步更新（final → forward → delete 顺序），85/85 全过，构建待重启 |
| 下午 | **斜杠命令补齐**：接通从未被调用的 tryHandleCommand 路由（此前仅 processInbound 特判 /new），新增 /model（查看当前模型+可用 provider/model 目录；`/model <provider> <model>` 切换：更新 agent selectionRef.current（下一步生效）+ agentDefaultModel.saveSelection 持久化，未知模型拒绝）与 /workspace（查看当前 cwd+所属 workspace；list 列出全部；`/workspace <目录>` 校验 realpath+isDirectory 后记录 per-chat 覆盖，并 retire 当前 agent——session cwd 创建时冻结，下一条消息以新目录重建会话）；/stop 增强：cancel 后清 loopPending/loopBuffer（被取消回合静默收尾不发残文）；/new 统一走 resetChat（删除重复内联与 parseSlashCommand 孤儿）；/help 更新。类型：BridgeDeps 注入 agentDefaultModel + WorkspaceRegistryLike 扩展 list；fake agent 补 status/cancel；90/90 全过，构建待重启 |
| 下午 | **事故与修复**：往 cordis.patch.yml 错误新增 dsh-onebot-nas 条目（同插件二次加载）→ 双实例工具注册冲突 → 崩溃循环 + chat-sessions.json 被清空。修复：移除重复条目（配置合并进现有 dsh-onebot 条目），恢复映射，重启。**教训：同一插件文件绝不能 insert 两次；给现有插件加配置必须改原条目 config** |
| 下午 | **QQ 文件接收双通道**：NapCat 文档（napneko.github.io/develop/file）确认 get_private_file_url 私聊直链（QQ CDN，实测 200 + MD5 一致）→ resolveNasFile 优先直链下载，失败回退 get_file 的 base64/http-url 载荷（SSH 方案未实现，仅注释残留，后已清理）；get_private_file_url 加入 qq_napcat_api 白名单；file 段解析 name 回退 file 字段 + 保留 file_id。90/90 全过 |
| 下午 | **loop 结算顺序再调整**（用户要求明确顺序）：合并转发 → 发送 t2i/final → 撤回。settleLoopBuffer 拆为 sendLoopForward + recallLoopMessages 两段，turn/end 在发送链上排三步（转发成功才执行撤回，失败保留原消息）；测试断言更新（fwd → final → delete），90/90 全过，构建待重启 |
| 下午 | **入站图片压缩规划**：对齐 Hermes 原版 _shrink_image 梳理决策点，用户拍板——黑底垫色、EXIF 方向校正、GIF 不支持时保持原图；方案见 §3.12，待实现 |
| 下午 | **入站图片压缩实现**：src/image-shrink.ts + media.ts 接线 + imageMaxSize 配置；踩坑：@napi-rs/canvas loadImage 已自动应用 EXIF 方向（手写解析会双重旋转）→ 删手写 EXIF 逻辑；99/99 全过，详见 §3.12 |
| 晚 | **入站媒体解析修复验证（用户实测四类全过）**：语音——转写正常附带（测试语「听到了吗」）；图片——[图片:path] 标注正确、view_image 可读；文件——[文件:path] 标注正确、dsh-onebot-image-compress-plan.md 完整可读；视频——[视频:path] 标注正确、MP4 v2 有效。四类均落盘 dsh 媒体目录，修复生效 |

### 2026-08-16（验证与修复）

| 时间 | 工作 |
|---|---|
| 上午 | 包名改为 `@dsh-external/dsh-onebot`（符合插件生态 scope 约定，登记 awesome-dsh-plugins 前置），推送 GitHub（a27dd2b） |
| 上午 | **长文本分段路径验证**（用户实测）：默认 textImageThreshold=150 时 >150 字符回复全部走 t2i 卡片，文本分段（splitLongText）仅 100~150 区间或卡片渲染失败时触发；100~150 区间实测分段正常（按句号切两段） |
| 上午 | **loop 合并"少撤回一条"（用户截图实测）**：每轮合并卡片都比中间消息少一条（卡片 2 条+撤回 2 条，漏掉最后一条中间文本且不撤回）。根因：interim 消息 id 在 sendToChat 完成后**异步** push 进 loopBuffer，而 turn/end **同步**快照 buffer → 最后一条 pending interim 的 push 晚于快照，落进被替换的旧数组，永不合并/撤回 |
| 上午 | **中间消息"慢一拍"（用户反馈）**：原「延迟一条」策略（上一条文本等下一条 assistant/message 到达才发）让 QQ 收到的中间文本滞后一步。方案：assistant/message 的 content 含 tool-call 块时 100% 不是最终回复（模型调用工具后必继续）→ **立即发送并记账**；仅无工具调用的纯文本保持延迟判定（用于区分最终回复） |
| 上午 | 修复实现：`sendInterim`（发送+记账封装）+ `settleLoop`（turn/end 先 await 发送队列排空再快照 buffer，顺序：合并转发 → final（t2i/分段原路径）→ 撤回，任一步失败安全降级保留原消息）；99/99 全过，推送 GitHub（68f2398），详见 §3.13 |
| 晚 | **上线实测发现重复发送（用户截图+OCR 核对）**：合并卡片 5 条，第一条中间文本出现 3 次（内容完全相同）。根因：同一 assistant 消息会被会话**重发多次 assistant/message 事件**（流式/usage 更新重发），「立即发送」逻辑对每次事件都 sendInterim 一次 → 重复发送+重复入账。修复：按 message.id 去重（`lastHandledMessageId`，同一 id 只处理一次；消息无 id 时跳过不去重，兼容旧事件）；新增去重回归测试（同 id 重发 3 次只出 1 条，合并卡片 2 条+撤回 2 条）；100/100 全过，推送 GitHub |
| 晚 | **修复后复验通过（用户截图确认）**：重启加载新代码后实测——3 轮工具调用 3 条中间文本：合并卡片正好 3 条、撤回提示 3 条、无重复、中间文本即时出现。三连修（排空队列/立即发送/去重）全部生效 |
| 晚 | **/new 后开不了新对话（用户上报）**：`session "onebot-private-841859784" already has a persisted log on disk that does not match this live session (id collision)`。排查：会话 id 按 chat 确定性派生，/new 只把旧 id 记进**内存** brokenSessions 并清空 mapping，重启后裸 id 被复用撞上磁盘旧日志。修复：废弃 id 持久化（retired-sessions.json）+ 兜底记账修复（用真实 session id 收尾）；102/102 全过，详见 §3.14 |

### 2026-08-17（会话字段对齐 Web：preset 记录）

| 时间 | 工作 |
|---|---|
| 晚 | **Web 上不显示 QQ 会话的 preset（用户提问）**：查证 Web 会话标题旁 preset 标签（AgentPresetLabel）只渲染 session summary 里的 agentPreset 值，该值来自会话 header 的 agentPreset 字段；Web 创建路径（api-proxy sessions.create）总是 resolve 默认/指定 preset 写入 header，而 onebot 创建路径只在插件配置 agentPreset 非空时写入（默认空）→ 该会话 header 无记录、Web 无从显示（会话实际仍按默认 router-flash 组装）。诊断详见 §3.15 |
| 晚 | **补齐字段与行为**：`ensureChat` 改为总是 `resolvePresetId()`（配置非空用配置，否则部署默认 defaultId）并写入 `meta.agentPreset`——新会话 header 固定记录有效 preset id，Web 标签可见；`loadMapping` resume 改为先 `sessionPersistence.inspect` 读会话自己记录的 preset（最新 `agent-preset/selected` 事件优先，否则 header），有记录时以记录为准并在与插件配置冲突时 warn（防配置变更致老会话组装漂移）；新增 `resolveRecordedPreset` 纯函数与 `resolvePresetId`/`recordedPresetFor`；Config 文案修正（原写「当前为 standard」，实际部署默认 router-flash）；inject 增加 `sessionPersistence`。存量会话 header 无记录 → resume 回落配置/默认，行为不变（不做迁移）。105/105 全过（新增 3 测试），构建上线，详见 §3.15 |

---

## 3. 关键决策与坑（按价值排序）

### 3.1 emoji 代理对拆分（t2i 渲染黑字形）
- **症状**：卡片里 😀👍🎉 渲染成黑色字形（像素扫描：0 个彩色像素，只有页脚蓝）
- **根因**：JS 字符串索引 `text[i]` 按 UTF-16 码元取字符，`😀`（\uD83D\uDE00）被拆成两个半代理；高代理位 0xD83D ≥ 0x2E80 被 classifyChar 判为 CJK → emoji 并进 CJK run 用 Songti 画出单色字形
- **修复**：drawBodyRuns/drawCodeRuns 全部改 `Array.from(text)` 按码点迭代；splitLongText 边界同样保护（charCodeAt 检测高代理回退一位）
- **验证**：修复后 269 个黄色像素；emoji×12 分段测试每个 chunk 码点数×2 == 码元数

### 3.2 分段从非标点位置截断（split）
- **症状**：回复被切成 需要我做什 / 么直接说就行～（「什么」被劈开）
- **根因**：移植版用**向前越界**找标点（chunk 可超 limit），窗口内无标点就硬切在 limit；且标点集误加 `.` `:` `;`（URL/代码里的点被当断句点）
- **修复**：对齐 Hermes 原版 `_split_reply`：窗口内**向后**找最后一个标点（。！？!?；;\n），chunk 恒 ≤ limit 且结尾是标点；无标点优先回退最后一个空格（单词/URL 完整）；代理对保护
- **验证**：原截断文本现在切为 对话内容。 + 需要我做什么直接说就行～；79/79 全过

### 3.3 stop() 先清 chats 再写映射 → 重启失忆
- **症状**：优雅关停后 chat-sessions.json 变成 {}，重启后 0 resumed，create 撞上磁盘残留日志报 id collision
- **根因**：bridge.stop() 先 `chats.clear()` 再 `saveMapping()`
- **修复**：先存映射再 dispose/clear；顺带加 create 失败（id collision）自愈：换带时间戳后缀的新 session id 并提示重发
- **验证**：重启记忆 E2E：记暗号柚子 → 优雅关停 → 重启 → 1 resumed → 答出柚子

### 3.4 resume 时模型选择读到引导期默认值
- **症状**：重启恢复的 Agent 用 deepseek-official（无 key）而非用户配置的 opencode-go，回合报 no API key
- **根因**：loadMapping 在宿主启动早期执行，settings/provider 还没加载完，currentSelection() 返回内置默认
- **修复**：桥接启动先 `await ctx.get('loader')?.await()`（headless-runner 同款）再读模型选择

### 3.5 挂载层两个坑（部署时踩的）
- **$HOME 字面量**：`name: '$HOME/dsh-plugins/...'` 不被 loader 插值（entry 元数据保持字面量）→ 模块找不到；必须绝对路径
- **config.yaml 不是 patch 层**：写 `~/.dsh/config.yaml` 不生效；正确位置是 `~/.dsh/profiles/web/cordis.patch.yml`（dsh-vision 的挂载点）
- **热加载**：改 patch 文件或 touch 即热替换插件（watchUserPatches），1 秒生效，无需重启 dsh

### 3.6 双连接 last-wins 与发送空窗
- **症状**：线上 E2E 用户没收到回复
- **根因**：测试对端拨入顶掉 NapCat 连接；模型回复完成时对端已退出、NapCat 未重拨 → sendMsg 时无连接 → 回复丢弃（仅控制台日志）
- **修复**：测试方法改为本地草稿实例（对端全程在线）；线上链路用真实 QQ 消息验证。已知限制：断线瞬间的回复会丢（与 Hermes 一致），待增强补发

### 3.7 npm 工具链坑
- **npm install 覆盖宿主符号链接**：npm 重装 peer 依赖会把 link-host.sh 建的符号链接替换成真实副本 → 装完依赖必须重跑 link-host.sh（build.sh 已内置）
- **macOS 无 readlink -f**、受限 shell PATH 无 dsh：脚本改用 npx store 兜底查找（~/.npm/_npx/*/node_modules）
- **fontkit ESM 入口是浏览器构建**（dist/browser-module.mjs 无 Node API）→ 改 createRequire 惰性加载 Node 构建

### 3.8 macOS 字体家族缺失 → 豆腐块
- **症状**：PingFang SC 家族在 macOS 26 不在 /System/Library/Fonts，ctx.font 指定它时 Skia 静默回退成豆腐块（墨水自检 224 像素 vs 真字形 1200+）
- **修复**：FontManager 启动时墨水自检（渲染「中」统计深色像素 <600 即弃用该家族）；可用家族：Hiragino Sans GB / Songti SC / Menlo / Apple Color Emoji / Arial Unicode MS
- **emoji 必须显式 Apple Color Emoji**（混合文本不自动彩色化）

### 3.9 schemastery / defineTool 细节
- schemastery Schema 是**可调用函数**：`Config({...})`，不是 Config.validate()
- 参数 DSL 不支持嵌套 `items.required`（defineTool 直接报错）→ execute 内手检
- 字面量联合用 `z.const('x')`

### 3.10 QQ 会话未加入 agent 预设 + 未挂工作区（2026-08-14）
- **症状**：①QQ 会话在 GUI 显示「未分组」；②QQ 会话只有 qq_* + view_image 8 个工具，没有 bash/fs/read 等（会话日志实证：request header 的 tools 数组恰好 8 个，system prompt 仅 2793 字符，无任何工具指引节）
- **根因**（dsh-agent-presets 源码 lib/index.js:866 实证）：
  1. bridge 用 `ctx.agents.create({ setup: 只装模型选择 })` 直接建会话，**没有 `agentPresets.mount(agentCtx)`** → 该 agent 的 tools/prompt/skills 解析在 **empty global layer**，只剩插件自己全局注册的 qq_*（dsh-onebot）+ view_image（dsh-vision）。bash/fs/subagent 等全部在 standard 预设的 agent-plane 里（config/agent-presets/standard/agent.cordis.yml），不加入预设就看不到
  2. GUI 建会话走 api sessions.create → `composeAgent(preset)` + `workspace.attachSession()`；bridge 两样都没做 → 会话不在任何 workspaceRegistry.sessionIds 里 → GUI「未分组」。attachSession 全仓库只有 dsh-host-apiproxy 调用
- **修复**（src/bridge.ts）：
  - `joinPreset(agentCtx)`：setup 里 `agentPresets.mount(agentCtx, config.agentPreset || undefined)`（默认走部署默认 standard；mount 失败仅 warn 回退旧行为，不炸聊天）
  - `attachToWorkspace(sessionId, headerCwd)`：按会话 header cwd `resolveByPath`，无则 `create`，再 `attachSession`（全 best-effort，失败仅日志）
  - 新增配置：`agentPreset`（留空=默认）、`workspacePath`（留空=宿主 cwd）；inject 加 `agentPresets`、`workspaceRegistry`
  - patch 已配 `agentPreset: standard` + `workspacePath: ~/workspace`
- **防复发（3.10 修订）**：宿主重启 resume 旧会话时，旧会话 header cwd 是旧宿主 cwd（~/.hermes/workspace），与 workspacePath 不同 → 原逻辑会按旧 cwd 自动建工作区（实测踩中：自动创建了 ~/.hermes/workspace 工作区）。修订：**仅当 headerCwd === workspacePath 时才自动创建**；异 cwd 会话只挂到已存在的工作区，否则跳过（保持未分组）。旧会话用脚本迁移（header cwd 改写 + 目录迁移 + workspace/projcache 同步，见 workspace/migrate-qq-session.sh）
- **验证**：81 vitest 全绿（含两条回归：preset mount + 工作区 create/attach；异 cwd 不自动建工作区）；tsc 构建通过。**生效需重启 dsh web**（宿主侧插件无 HMR）

### 3.11 斜杠命令 /new（2026-08-14）
- **需求**：QQ 里发斜杠命令开新对话无效——插件此前没有任何斜杠命令处理，/xxx 被当普通消息丢给模型
- **实现**（src/bridge.ts）：
  - `parseSlashCommand(text, selfId)`：解析入站文本，容忍群聊 `@<bot> /new` 前缀；命令集：`/new` `/model` `/workspace` `/stop` `/help`（/model、/workspace 为下午随命令补齐加入，见 §2 时间线）
  - `resetChat(chatId)`：销毁当前 chat agent、把旧 session id 加入 brokenSessions（下次消息自动生成 `onebot-private-<qq>-<base36>` 新 id）、清映射、直接经出站管线回发「已开启新对话」确认（agent 已销毁，不走模型）
  - 权限：仅 admin（群聊成员/受限用户发 /new 直接忽略）
- **验证**：82 vitest 全绿（新增回归：/new 不进入 agent、收到确认回复、下一条消息落在带后缀的新会话 id）；tsc 构建通过

### 3.12 入站图片压缩（2026-08-14，已实现）
- **目标**：大图先压缩再交给视觉模型（view_image），避免大图拖慢视觉分析（路线图最后一项，已转正；对齐 Hermes 原版 `_shrink_image`）
- **决策拍板**（用户确认）：
  - 触发：长边 > `imageMaxSize`（新配置，默认 2048，`<=0` 禁用）才压缩，等比缩放（长边限制、短边跟随）
  - 算法：@napi-rs/canvas 缩放（`imageSmoothingQuality: 'high'`），**不加新依赖**
  - 输出：RGBA（含透明）→ PNG；否则 → JPEG quality=85；**透明垫黑底**（与 PIL 转 RGB 一致）
  - **EXIF 方向校正**（用户要求，优于原版）：竖拍图不横躺
  - GIF 动图：**保持原图**不压缩（用户确认）
  - 失败/解码失败：保持原图（best-effort）
- **实现**（src/image-shrink.ts + media.ts resolve 包装）：
  - `shrinkImage(src, maxSize)`：GIF 魔数跳过 → loadImage 解码 → 长边 ≤maxSize 不动 → 等比缩放 → PNG/JPEG 导出 → 写 `<原名>-c<maxSize>.png|jpg`（不覆盖原图）
  - MediaStore 构造加 `imageMaxSize`（`<=0` 禁用）；resolve 的 image 分支下载后统一压缩（resolveInner 提取 + 外层包装，全分支单点生效）
  - ⚠️ **踩坑（重要）**：原计划手写 JPEG APP1/EXIF Orientation 解析（零依赖约 40 行），实测 **@napi-rs/canvas 的 loadImage 已自动应用 EXIF 方向**（3000×2000 + Orientation=6 解码即 2000×3000）——再手动旋转会**双重旋转**。修复：删除手写 EXIF 解析与旋转代码，直接以解码尺寸为准（解码尺寸=显示尺寸）
- **验证**：99/99 vitest 全绿（新增 9 例：4000→2048、小图不动、禁用、RGBA→PNG、不透明→JPEG、EXIF=6 输出 1365×2048、GIF 保持、损坏文件不抛、不覆盖原图）；tsc 零错误
- **文档**：README 配置表加 `imageMaxSize`、功能表入站转正、路线图章节移除、兼容性验证更新为 99/99

### 3.13 loop 合并竞态与中间消息慢一拍（2026-08-16，已修复）
- **症状 A（少撤回）**：用户截图实测——每轮合并转发卡片都比实际中间消息少一条：卡片 2 条+撤回 2 条，最后一条中间文本留在聊天里（不合并、不撤回）
- **根因 A**：interim 记账是 `sendToChat(...).then(ids => loopBuffer.push(...))` ——消息真正发出后**异步** push；而 turn/end 处理是**同步** `const buf = chat.loopBuffer; chat.loopBuffer = []` 快照换数组。模型生成完最后一条 assistant/message 后立刻发 turn/end，此时最后一条 interim 的发送还在队列里、push 未发生 → 快照后 push 进被替换的旧数组 → 该消息永久失去合并/撤回跟踪
- **症状 B（慢一拍）**：用户反馈 QQ 收到的中间文本滞后——「延迟一条」策略下每条中间文本都要等下一条 assistant/message 到达才发出
- **根因 B**：延迟一条是**有意设计**（上一条被下一条证明是 interim 才发，防最终回复被当中间消息发出），但代价是每步都慢一拍
- **修复**：
  - **立即发送判定**：assistant/message 的 content 含 `tool-call` 块 → 该消息 100% 不是最终回复（模型调用工具后必继续生成）→ 立即发送并入账（`sendInterim`）；仅无工具调用的纯文本保持延迟判定，turn/end 时作为 final 发送
  - **结算先排空队列**：`settleLoop`（turn/end 分支改为 void 异步调用）先 `await chat.queue` 等发送链全部 settle（最后一条 interim 的 push 必然完成——push 回调注册早于队列 catch 链的恢复），再快照 buffer，顺序执行：合并转发 → final（t2i/分段原路径）→ 撤回；任一步失败安全降级（合并失败保留原消息，内容不丢）
- **验证**：99/99 vitest 全绿（既有 ≥2 合并+撤回、单条不合并、新消息清残留测试全部保持通过）；src 与 lib 入库，推送 GitHub（68f2398）

### 3.14 /new 后 id collision 复现：废弃 id 持久化 + 兜底记账修复（2026-08-16，已修复）
- **症状**：QQ 私聊 `/new` 后下一条消息报 `session "onebot-private-841859784" already has a persisted log on disk that does not match this live session (id collision)`，新对话开不起来
- **现场还原**（磁盘证据）：会话 id 由 chat 确定性派生（`sessionIdForChat` → `onebot-private-<qq>`，永不变）；首次会话的日志持久化在 `~/.dsh/sessions/--Users-mario--/onebot-private-841859784/`（cwd=/Users/mario = DSH 进程启动目录）；`/new`（resetChat）只把旧 id 记进**内存** `brokenSessions`、把 chat-sessions.json 清成 {}；进程重启后 `brokenSessions` 丢失、mapping 空 → 下一条消息 ensureChat 又用回裸 id → dsh-session-persistence 的 onCreated→adoptLivePrefix 发现磁盘旧日志的 seed 覆盖不了 → 抛 id collision。该错误**异步**浮出（create 本身 resolve，persistence 的 live.init 被 .catch 吞掉），回合结束变 turn/end error → 发 ⚠️ 并触发 healSessionCollision（内存拉黑裸 id）→ 再发一条才成功；**只要中间重启过一次，裸 id 又被复用，必复现**
- **修复**：
  - **废弃 id 持久化**：新增 `retired-sessions.json`（mediaDir 下，append-only 数组）。`retireSession(id)` = 内存 brokenSessions + 去重追加 + 立即写盘；调用点：resetChat（/new）、healSessionCollision、loadMapping resume 失败、ensureChat create 碰撞兜底。启动时 `loadRetired()` 读盘回填 brokenSessions。`ensureChat` 选 id 判断改为 `isSessionIdBlocked`（内存 ∪ 磁盘），`freshSessionId()` 生成带时间戳后缀新 id 并 while 去重 —— **重启后裸 id 永不再用**
  - **兜底记账修复**：ensureChat 的 catch 分支兜底成功后，`chat.sessionId`/`bySession`/日志原本仍记**原始裸 id**（真实 session 是后缀 id）→ 会话事件全查不到（不回消息、mapping 写错 id）。改为统一用 `handle.agent.session.id`（真实 id）收尾；loadMapping 同步修正
- **验证**：102/102 vitest 全绿。新增/扩展 3 例：/new 后 retired-sessions.json 落盘 + 同一 mediaDir 新 bridge 模拟重启首条消息直接用后缀 id（不再用裸 id）；create 碰撞兜底 → mapping/事件路由指向真实后缀 id；turn/end 碰撞 → retired 落盘 + mapping 清空。线上：预置 retired-sessions.json 两个已知废弃 id 后重启实测

### 3.15 会话 header 缺 agentPreset → Web 上不显示 preset（2026-08-17，已修复）
- **症状**：Web GUI 打开/列表看 QQ 创建的会话，标题旁没有 preset 标签（Web 创建的会话有）
- **根因**（代码级对照）：Web 会话 header 的 `agentPreset` 由 host api-proxy `sessions.create` 写入——`composeAgent(presetId)` 对缺省请求也 `resolve(undefined)` 出部署默认（router-flash）并写进 `meta.agentPreset`，创建 RPC 再把解析值回给前端存 session summary（AgentPresetLabel 只在该值存在时渲染）。onebot 的 `ensureChat` 只在插件配置 `agentPreset` 非空时写 meta（默认空字符串）→ header 无字段、summary 无值、Web 标签不渲染；**会话实际组装仍是默认 preset**（joinPreset 的 mount(undefined) 回落 defaultId），只是没记录
- **修复**：
  - **创建记录**：`ensureChat` 新增 `resolvePresetId()`——配置非空用配置（先 resolve 校验），否则用 `agentPresets.defaultId`；总是写入 `meta.agentPreset`（resolve 失败 warn + 不写，保持降级语义）。新会话 header 固定记录有效 preset id
  - **resume 按记录重建**：`loadMapping` 新增 `recordedPresetFor()`——经 `sessionPersistence.inspect` 冷读持久 header+log，`resolveRecordedPreset`（最新 `agent-preset/selected` 事件优先，否则 header.agentPreset，与 dsh-agent-presets 的官方解析一致）；有记录时 setup 以记录为准，与插件配置冲突仅 warn（防改配置后老会话组装漂移，违反 model-visible ⟺ logged）；无记录（存量）回落配置/默认，行为不变——**存量不迁移**（用户决策）
  - 依赖：inject 增加 `sessionPersistence`（base bundle 已挂 session-persistence-jsonl，`ctx.sessionPersistence`）
  - Config 文案修正：agentPreset 描述原写「当前为 standard」，实际部署默认 router-flash
- **验证**：105/105 vitest 全绿。新增 3 例：配置留空 → header 记录默认 router-flash 且 mount 走默认；resume 读记录 preset 覆盖冲突配置（mount 收到 router-flash、warn 冲突）；resolveRecordedPreset 纯函数（log 最新优先/header 兜底/无记录 undefined）。更新 1 例：配置 preset 的创建断言 header 记录该 id。构建上线（生产热加载验证中）

---
## 4. 功能清单（当前状态）

### 入站
- [x] 私聊/群聊（群需 @/回复触发，requireMention 默认 true；白名单授权）
- [x] 段数组优先解析（CQ 字符串回退）、CQ 反转义
- [x] 图片 url/base64/file/hash 四路获取；**大图自动压缩（长边 ≤imageMaxSize，GIF 不压，透明 PNG 保留）**；语音 ffmpeg→whisper 转写（失败降级 [语音]）
- [x] 引用消息自动取原文（get_msg）；合并转发自动展开（get_forward_msg）
- [x] 表情 id→emoji、@、回复、卡片、戳一戳段类型；群聊 [HH:MM 昵称(QQ)] 前缀注入

### 出站
- [x] 长消息策略：≤100 单条 / 100–150 标点分段 / >150 t2i 文字图卡片（渲染失败回退分段）
- [x] Markdown 剥离为 QQ 纯文本；[[qq_forward]] 合并转发（群/私聊）
- [x] loop 中间消息自动合并转发+撤回（interimMessages：带 tool-call 的中间文本立即发送、无工具调用延迟一步判定；缓冲 ≥2 条收敛为合并转发卡片并撤回原消息；顺序：合并转发 → t2i/final → 撤回；结算前排空发送队列不漏最后一条）
- [x] 图片（路径/URL，≤9 张）、语音、视频、文件工具；正在输入提示（私聊）
- [x] qq_napcat_api 白名单代理（14 个 action）、qq_group_history

### t2i 渲染（2026-08-14 移植，对照 T2I_DEV_DOC）
- [x] AstrBot 元素化两遍流程（先算高再绘制）；800px/26px/右缘 790
- [x] 标题/粗体双画/斜体变换/删除线/引用/无序有序列表/代码块/表格（表头灰底/网格线/交替行/列宽拉伸/居中）/行内 code 胶囊
- [x] 彩色 emoji（Apple Color Emoji）、中文标点禁则、行内样式整体换行、字面 \n 转换
- [x] 顶栏 To 昵称（#2196F3）+ 页脚 Powered by dsh（#002FA7）
- [x] 像素级右缘验证 ≤790（压力内容全图扫描 0 违规）

### 运维
- [x] 会话映射持久化 + 重启 resume（含引导期模型选择等待）
- [x] 热加载：改 patch 文件/touch 即生效（无需重启 dsh）
- [x] 测试：105 vitest（单元 + 真实 WS 对端 + 全管线 + t2i 像素扫描 + 预设/工作区回归 + loop 合并/斜杠命令回归 + 图片压缩 + 废弃会话 id 持久化/重启回归 + preset 记录/恢复回归）

---

## 5. 已知限制 / 待办

1. **断线瞬间的回复丢失**：无连接时 sendMsg 失败仅记日志（与 Hermes 一致）；待增强：断线重连后补发
2. **ZWJ 组合 emoji / 区域指示符**：按码点拆分绘制（原版一致限制）
3. **t2i 链接/图片语法原样当文本**、无多级列表/任务列表/嵌套引用/合并单元格（原版一致限制）
4. **Linux 部署**：需安装 Noto CJK（ttc 默认面可能是 JP，fontkit 提取 SC 面代码已就位但未在 Linux 实测）；emoji 需注册 NotoColorEmoji
5. 卡片最大高度未限制（超长 markdown 可能生成超高图）

---

## 6. 快速备忘（运维）

```bash
# 插件目录 / 挂载点
~/dsh-plugins/dsh-onebot/            # 源码 + lib（构建产物入库）
~/.dsh/profiles/web/cordis.patch.yml # 挂载配置（改/touch 即热加载）

# 构建与测试
cd ~/dsh-plugins/dsh-onebot && npm install --include=dev && ./scripts/build.sh
./node_modules/.bin/vitest run       # 90 个测试

# 线上状态
netstat -an | grep <port>             # NapCat 反向 WS 连接（ESTABLISHED）
zstd -dc ~/.dsh/sessions/*/onebot-private-*/session.jsonl.zstd   # 会话日志

# NapCat（NAS 管理面板）
网络配置 → ws-reverse → ws://<dsh 机器 IP>:<port>/ws，token 与插件 accessToken 一致
docker restart 会丢登录态（需重新扫码/QCE 登录）
```

---

*本日志由移植过程会话记录整理，随迭代持续更新。*
