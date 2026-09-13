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


### 2026-09-10（M1 收尾：v0.2.1 发布）

| 时间 | 工作 |
|---|---|
| 全天 | **M1 里程碑完成**——11/11 工作包（Wave1 A2/A6/B4/B5、Wave2 C3/A5/A3a+A3b、Wave3 A7/B6/B7/E2/C6a/A8×3），测试 99→200（+101），tsc 0 错误；安全回归清单随各包验收在库（鉴权 3 路径/路径围栏/SSRF 矩阵/覆盖状态文件防护/解码炸弹/门禁 TOCTOU）；遗留：R5 NapCat 4401 重试行为 24h 观察（生产 v0.2.0 运行中）、真机检查待 trim-cli 登录后执行、file:// 分支与 DNS rebinding 与正文伪前缀（D5）为已知边界 |
| 全天 | **发布 v0.2.1**——版本号 0.2.0→0.2.1；tag v0.2.1；生产升级待用户执行（git pull + ./scripts/build.sh + 重启 dsh，注意生产 accessToken 已配置无需再动） |
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

### 2026-08-18（safe-edit 拆分为独立插件 dsh-safe-edit）
| 时间 | 工作 |
|---|---|
| 午 | **code_safe_edit / code_safe_rollback / code_list_backups 拆分出本插件**（用户要求）：新建独立插件 `~/dsh-plugins/dsh-safe-edit/`，安全编辑工具改为对所有通道（QQ/Web/其他）全局注册；可编辑根跟随会话 sandbox 策略——`danger-full-access` 无限制、`workspace-write` 限会话工作区、`read-only` 拒绝、无策略服务回落 `safeEditRoot`。本插件（onebot）删除 src/safe-edit.ts、tests/safe-edit.spec.ts 及 tools.ts 中相关注册块、index.ts 的 safeEditRoot/backupDir 配置项；相关测试并入 dsh-safe-edit（7/7 全过）。挂载配置：`~/.dsh/profiles/web/cordis.patch.yml` 移除 onebot 的 safeEditRoot，新增 dsh-safe-edit 条目。详见 §3.21 |
| 午 | **真机排查 + 修复 sandbox policy bug + 重启上线**：首次给 `SandboxPolicyService.resolve()` 传 `{id}` stub 导致 `session.events` undefined → `Cannot read ... (reading 'length')`；按 dsh-tool-bash 改为传完整 `exec.agent.session` 对象。KEY 认知：**HMR 只重应用配置快照、不重新 require 插件 JS**，改 lib 必须重启 dsh（launchd 拉起）。重启后实测全链路：编辑→备份→回滚 通过；full-access 会话跨 /tmp 编辑成功。onebot 118/118、dsh-safe-edit 7/7 全绿。详见 §3.21 |

### 2026-08-19（/plan 上线后真机修复）

| 时间 | 工作 |
|---|---|
| 下午 | **/plan 转发补传必填 signal**：§3.22 转发上线后 /plan 调用报 `Cannot read properties of undefined (reading 'aborted')`——宿主 `commands.execute` **无条件**读 `signal.aborted`，而转发时未传 signal（声明为可选）。修复：调用处补传 `new AbortController().signal`（QQ 用户发起的 /plan 不被本插件取消逻辑中断）；BridgeDeps/Context 类型把 signal 改为必填；测试同步；构建入库。详见 §3.25 |

### 2026-09-01（文档：架构图三连）

| 时间 | 工作 |
|---|---|
| 下午 | **架构图三连（纯文档，无代码改动）**：① Archify 导出自包含 SVG（宿主样式变量与类内联、裸属性规范化为 SVG/XML 合法值）嵌入 README「## 架构」+ 保留交互式 HTML；② SVG 在 GitHub 管线不渲染 → README 改用 2x 高清 PNG 嵌入，SVG 补 xmlns 保留矢量版；③ README.en.md 新增英文版架构图（EN SVG 全文翻译 + 按英文宽度重排标签遮罩 + EN PNG）。详见 §3.25 |

### 2026-08-17（会话字段对齐 Web：preset 记录）

| 时间 | 工作 |
|---|---|
| 晚 | **Web 上不显示 QQ 会话的 preset（用户提问）**：查证 Web 会话标题旁 preset 标签（AgentPresetLabel）只渲染 session summary 里的 agentPreset 值，该值来自会话 header 的 agentPreset 字段；Web 创建路径（api-proxy sessions.create）总是 resolve 默认/指定 preset 写入 header，而 onebot 创建路径只在插件配置 agentPreset 非空时写入（默认空）→ 该会话 header 无记录、Web 无从显示（会话实际仍按默认 router-flash 组装）。诊断详见 §3.15 |
| 晚 | **补齐字段与行为**：`ensureChat` 改为总是 `resolvePresetId()`（配置非空用配置，否则部署默认 defaultId）并写入 `meta.agentPreset`——新会话 header 固定记录有效 preset id，Web 标签可见；`loadMapping` resume 改为先 `sessionPersistence.inspect` 读会话自己记录的 preset（最新 `agent-preset/selected` 事件优先，否则 header），有记录时以记录为准并在与插件配置冲突时 warn（防配置变更致老会话组装漂移）；新增 `resolveRecordedPreset` 纯函数与 `resolvePresetId`/`recordedPresetFor`；Config 文案修正（原写「当前为 standard」，实际部署默认 router-flash）；inject 增加 `sessionPersistence`。存量会话 header 无记录 → resume 回落配置/默认，行为不变（不做迁移）。105/105 全过（新增 3 测试），构建上线，详见 §3.15 |
| 晚 | **宿主升级 dsh rc.6→rc.7（用户要求先做冲突检测）**：逐行对比 rc.6/rc.7 的 12 个运行时包 + bundle 组成 + 存储格式，结论：依赖无增删、8 个核心包零差异、base/web-app 组合逐行一致、SESSION_FORMAT_VERSION 仍 0、preset 相关 API 全兼容 → 无冲突。升级执行中发现 **link-host.sh 解析 bug**：`resolve_dsh_root` 在 nvm 全局布局（bin 在 <node>/bin、包在 @deepseek-ai/dsh/node_modules 内嵌）下先命中 `~/.npm/_npx/*/node_modules` 残留 store，把插件链到 npx store 副本（dual-package 隐患）→ 修复：bin 祖先循环增加 `lib/node_modules/@deepseek-ai/dsh/node_modules` 检测优先于 npx store。升级 + 重链 + launchd 重启（kill 主进程 → ai.dsh.web KeepAlive 自动拉起）后验证：bridge ready (1 resumed)、agent joined preset router-flash、heartbeat 恢复、bin --version = 0.1.0-rc.7，详见 §3.16 |

### 2026-09-10（M0 安全与稳定性加固，v0.2.0）

| 时间 | 工作 |
|---|---|
| 全天 | **A1 反向 WS 鉴权加固（BREAKING）**：`token !== '' &&` 使空 token 整体跳过校验（fail-open），叠加默认 `host: '0.0.0.0'` + `accessToken: ''` = 默认全网卡无鉴权，局域网任意主机可伪造管理员事件（等效未认证 RCE）→ reverse 空 token 抛错拒启（fail-closed）、默认绑定 `127.0.0.1`、比较改 `crypto.timingSafeEqual`（先比长度）；forward 模式不受影响（token 是外发 Authorization 头）。connection.spec +6（fail-closed / 错误 token / 缺失 auth / 默认 host / B1 守卫 / 无 dbg 输出） |
| 全天 | **B1 socket close 归属守卫**：attachSocket 与 forward 的 close 处理器无条件 `stopHeartbeat()+setConnected(false)+failAllPending()`，last-wins 替换后旧 socket 的 close 异步晚到 → 杀死新连接心跳并永久断标 → 机器人「活着但失语」。两处首行加 `if (this.socket !== socket) return`（对称）；单测模拟旧 close 晚到：connected 不翻转、心跳存活、pending 正常 |
| 全天 | **C4 删热路径调试日志**：onFrame message 分支残留 `[dsh-onebot:dbg]` 无条件全量 JSON console.log（群成员昵称/QQ 号/原文进宿主日志，隐私+性能）→ 删除，src/tests 零残留 |
| 全天 | **B2+B3 mediaDir 清理修复**：cleanupExpired 无文件名过滤会删同目录的 chat-sessions.json / retired-sessions.json（空闲超 6h TTL 后任意入站触发 → 重启全部会话失忆）；STT `stt_<uuid>` 工作目录从不清理（每条语音泄漏 ~2MB）→ 清理改前缀白名单（仅 media_* 文件 + stt_* 目录递归）；transcribeNow try/finally 清工作目录（best-effort 不吞转写结果）。边界：升级前旧命名历史媒体文件不再自动清理 |
| 全天 | **A4 入站文件改名落盘**：safeName 保留 `.` 且直写 `mediaDir/<原始名>`，发名为 chat-sessions.json 的文件即可覆盖状态文件（配合确定性 session id 可在重启后劫持管理员会话）→ 一律 `MediaStore.freshPath` 生成 `media_<ts>_<uuid><ext>` 不可预测名，新增 `extForInboundName`（扩展名白名单，规则同 extForUrl）。新增 media-cleanup.spec 5 例（恶意文件名落盘 / 状态文件哨兵逐字节不变 / 清理矩阵） |
| 全天 | **E1 元数据 + 发布收尾**：bridge/plugin.spec 28 处 fixture 补 `accessToken: 'test-token'`、bridge.spec 19 处真实 WS 拨入补 Authorization 头，适配 fail-closed 语义；dsh.plugin.json 移除已拆走 dsh-safe-edit 的 code_safe_edit 三件（对齐 package.json）；engines.dsh `>=0.0.1` 收紧为 `>=0.1.0-rc.6`；README / README.en 标注 BREAKING；130/130 vitest 全绿，**发布 v0.2.0**。e2e-peer 真机冒烟当日补跑通过（见下） |
| 全天 | **适配当前宿主 dsh 0.1.5-rc.1（过时声明更正）**：盘点发现宿主全套 @deepseek-ai/* 已升至 0.1.5-rc.1、cordis 4.0.2，且 dsh-tools 公开导出中 JsonValue 类型已迁至 dsh-util-values（tsc TS2614 实证）→ tools.ts 改导入源、link-host.sh LINK_PKGS 与 peerDependencies 增补 @deepseek-ai/dsh-util-values；peer 依赖 0.1.0-rc.6 → ≥0.1.5-rc.1、cordis 4.0.1 → ^4.0.2、engines.dsh 同步 ≥0.1.5-rc.1（package.json + dsh.plugin.json）；README/README.en 兼容表、安装前置、最后验证日期一并更正；验证：对 0.1.5-rc.1 实链宿主 `tsc --noEmit` 0 错误、vitest 130/130 全绿 |
| 全天 | **e2e-peer 真机冒烟（M0 DoD 收口）**：隔离第二实例（独立 DSH_HOME，profiles/web/cordis.patch.yml 挂载工作区新 lib：mode=reverse、127.0.0.1:18643、accessToken 'e2etest'；生产 8765/NapCat 实例全程不动），`tests/e2e-peer.mjs` 假 NapCat 拨入实测：正确 Bearer token 全链路通（入站私聊 → set_input_status → agent 真实 LLM 回复 → 出站 send_msg text 段）；错误 token / 缺失 auth 头均被拒 WS close 4401 unauthorized；默认绑定 127.0.0.1 在真实宿主进程复核。注意：生产 ~/dsh-plugins 仍是旧构建，上线新 lib 前必须先在 cordis.patch.yml 给 dsh-onebot 补 accessToken（否则空 token fail-closed 拒启、QQ 通道中断） |

### 2026-09-10（M0 里程碑复盘与 M1 启动）

| 时间 | 工作 |
|---|---|
| 全天 | **DoD 9/9 核销通过，重排信号未触发**：A1/B1/B2+B3/A4/C4/E1 全部合入且每包有专测；vitest 130/130（基线实为 119，README 曾写 99/99 属滞后声明）；tsc 对 0.1.5-rc.1 实链宿主 0 错误；e2e-peer 真机冒烟通过（全链路 + 4401 拒绝实测，commit 9c65b40）；tag v0.2.0 已推远端 |
| 全天 | **估算偏差**：A1 +50%（BREAKING 测试半径 47 处——28 fixture 补 token + 19 WS 拨入补 Authorization 头——未估入工作包，后置到整合）；E1 成为整合回收站（+100~200%）；日历 1 天 vs 计划 3-4 天（双专家按文件所有权并行的结构优势）；范围内超支 +15% 在缓冲内。**范围审计**：23 变更文件 0 触碰范围外清单；计划外「宿主 0.1.5-rc.1 兼容适配」补录为常备预备包 **C7**（0.5 人日；触发条件：宿主升级 → 盘点 @deepseek-ai/* 与 cordis 版本 → 实链 tsc → 兼容声明与 link-host.sh 更正）；测试适配 47 处追溯并入 A1 口径（变更方负责适配原则） |
| 全天 | **协议偏差与 3 条流程改进**：E1/测试适配/发布整理由编排者亲自实施（违规，产出已验收有效）→ M1 起：①任务书强制「影响面自评 + 测试自含」，tests/ 所有权跟随变更方；②无主 diff 四步处置（冻结→考古定意图→补任务书重委派或显式 revert→禁止编排者改写合入）；③实施一律委派，豁免须先过 PM 检查点并记录；恢复逐包独立 commit（M0 曾两包合一 commit 致 revert 粒度变粗） |
| 全天 | **M1 启动**：范围不变（9.25 人日，A2→A3、C3→A5 硬前置）；Wave 1 三组并行（G-CON：B4+B5 ∥ G-MED：A6 ∥ G-BRG：A2）；A3 拆 A3a/A3b 两单。**遗留风险**：R1 生产未切换新 lib（须先两端配 accessToken 再挂新 lib，否则 fail-closed 拒启）；R5 NapCat 真客户端 4401 重试行为观察 24h；R6 测试数单一事实源 = vitest 实跑 |


### 2026-09-10（M1 Wave1：B4/B5/A6/A2）

| 时间 | 工作 |
|---|---|
| 全天 | **B4 心跳 pong 校验 + 超时 terminate + meta 心跳日志静音（commit 9bd2596）**：reverse/forward 两条 socket 路径挂 pong 监听（带归属守卫 `this.socket !== socket`——晚到旧 socket 的 pong 不污染新连接的 lastPongAt，与 B1 close 守卫同型）；心跳 tick 判定 `now - lastPongAt ≥ 2×HEARTBEAT_MS`（HEARTBEAT_MS=30s）→ terminate 走既有 close 链路（failAllPending + 状态翻转 + 重连调度），半开连接不再永久假在线；meta heartbeat 事件静默（logMetaEvent 对 heartbeat 直接 return，life_cycle 等其余 meta 照常出日志）。**取舍**：keepalive 仅依赖应用层 pong——ws 公开类型面无底层 socket 通道（`_socket` 为私有字段，升级无保证），且 30s ping 帧本身即 keepalive 流量。connection.spec +3 |
| 全天 | **B5 重连策略与状态上报（commit 627bcdf）**：新增配置 `reconnectMaxAttempts`（默认 100；`0`=无限重连，退避封顶 60s）；forward 重连放弃时日志含上限值与恢复指引（查 NapCat 地址与网络后重启插件/重载通道恢复）；reverse 监听 EADDRINUSE 日志含 host:port 与处置建议（停掉占端口进程或改 config.port）；stop() 清理重连定时器 + start() 防重入——stop→start 连续 50 次切换无幽灵定时器（单测覆盖）。connection.spec +5 |
| 全天 | **A6 入站图片解码炸弹预检（commit 4a4ac96）**：loadImage 前轻量头解析（PNG IHDR / JPEG SOF），声明尺寸超 `MAX_DECODE_EDGE`（8192，image-shrink.ts 命名导出常量）→ 解码前中止（return undefined，调用方保留原图），杜绝 30000×30000 声明 PNG 的 ~3.6GB Skia 分配 OOM；畸形/截断头回落原解码路径。**边界**：WebP/AVIF/HEIF 未预检（QQ 入站主体为 PNG/JPEG）；假阴性=放行（与改前行为一致，不新增失败面）。image-shrink.spec +7 |
| 全天 | **A2 canEditFiles 回合级角色固化（TOCTOU 修复，commit 23c0523）**：`chat.lastUserId`（最近入站用户）已删，改 `pendingTurnRoles` FIFO + `activeTurnRole`——**在宿主 `turn/start` 事件点 shift 固化**（静态证据链查证 dsh-session 暴露 turn/start 且与 turn/end 同 feed），canEditFiles 只读当前运行回合自己的角色；队列空/未知路径 fail-closed 为 member；/retry 传 admin（命令门禁已在 tryHandleCommand）；/new 与 healSessionCollision 随 ChatAgent 对象消亡结构性清队。**机制否决推演（给未来维护者的重要上下文）**：否决「turn/end 时 shift」方案——交错场景推演证明存在双向错位（管理员回合被误拒、成员后续回合被误放行）；turn/start-shift 的 FIFO 头严格对应当前运行回合，无此错位。**遗留**：turn/start 送达依赖静态证据链，真机冒烟建议加 debug 观测；若宿主不送 turn/start，后果为全员 fail-closed member（安全方向）。bridge.spec +4 |

### 2026-09-10（R1 生产切换收口 + trim-cli 真机验证能力接入）

| 时间 | 工作 |
|---|---|
| 全天 | **R1 生产切换完成（用户执行）**：NapCat ws-reverse 与插件 accessToken 两端配齐、新 lib 部署、dsh 重启——M0 的安全价值（封死未认证 RCE 口子）正式在生产兑现；R5 随之进入 24h 观察窗（NapCat 真实客户端对 4401 拒绝的重试行为，此前仅 e2e 一次实测）；生产 lib 对应 v0.2.0（M1 Wave1 的 4 个 commit 尚未构建进生产 lib，属正常迭代节奏，Wave1 本就属 M1 迭代） |
| 全天 | **trim-cli 技能接入编排环境**：TRIM NAS（fnOS）命令行客户端——WebSocket 连本机 ws://localhost:5666，登录后可查应用中心/Docker 容器/日志中心/文件/存储/系统监控，支持真机验证 workflow；来源为飞牛论坛附件（club.fnnas.com 附件需论坛登录，无法匿名抓取，技能本体已预装就位，无需再下载）；意义：后续 M1 回归包的「生产部署检查单」「24h 磁盘观察」等真机验证项可由编排方经 trim-cli 直接执行，不再依赖用户手工回报 |

### 2026-09-10（M1 Wave2：C3/A5/A3a/A3b）

| 时间 | 工作 |
|---|---|
| 全天 | **C3 统一下载路径（commit c3b52e0，refactor）**：删除 bridge 私有 downloadToMedia——裸 fetch 后 arrayBuffer() 全量缓冲、maxBytes 限长在缓冲完成之后才生效，大文件先吃满内存再被拒；resolveNasFile 两个 URL 分支改走 MediaStore.downloadUrl(url, ext, maxBytes) 流式边下边限长；grep 零残留；writeMediaFile（base64 分支）保留。C3→A5 硬前置兑现：A5 的下载围栏收口在这条唯一下载路径上 |
| 全天 | **A5 下载 SSRF/协议/限长加固（commit 0e1807e，security）**：downloadUrl 协议白名单仅 http/https；私网判定——IPv4 字面量 0/8、10/8、127/8、169.254/16、172.16/12、192.168/16，IPv6 ::1/::、fc00::/7、fe80::/10（IPv4-mapped `::ffff:x.x.x.x` 双写法归一后再判），域名经 dns.lookup 解析任一命中即拒；redirect: manual 手动跟随 ≤3 跳，每一跳在 fetch 发起前复检协议与私网；整次下载 30s 硬墙钟（AbortSignal.timeout）；新增配置 allowPrivateHosts（默认 false，true 时仅跳过私网检查——本机反代等可信场景逃生门，协议白名单与限长不豁免）；resolveInner 两处调用补传 maxBytes。**取舍**：30s 取整次下载总墙钟而非逐跳计时（重定向拉长全程仍统一封顶）；重定向前置拒绝——每一跳 fetch 前即拒，中间跳不产生出站请求，而非跟随后再补救；IPv4-mapped 归一防 `::ffff:` 写法绕过私网判定。media-guard.spec +16（SSRF 矩阵/重定向/流式中止） |
| 全天 | **A3a 媒体外发路径围栏机制（commit 52655f6，security）**：新增导出 resolveContainedPath(allowedRoots, target)——realpath 归一后前缀匹配且带分隔符边界（`/root/abc` 不误放行 `/root-abc`），symlink 解析后落在根外即拒绝（逃逸封死）；目标不存在 → 返回 null fail-closed；fileToBase64 增可选第三参 allowedRoots。**取舍**：不存在即拒——媒体外发是出站动作，宁可误拒也不给路径探测留口子 |
| 全天 | **A3b 门禁接线（commit b187b03，security）**：bridge 新增 mediaSendRoots(sessionId) 访问器——isTurnAdmin 复用 A2 回合级角色语义（不另起第二套角色判定）；roots 口径：member/未知 → 仅 mediaDir，admin → mediaDir + 会话工作区（两支均 realpath 归一）；qq_send_image/voice/video/file 本地路径分支全部过围栏，围栏拒绝转译为中文可行动提示（而非裸抛校验错误）；URL 分支保持原样（NapCat 侧抓取，见边界行）。过渡窗口关闭：tools 恒传 allowedRoots，无兜底放行。tools-gate.spec 新建 +9（门禁逐条）；vitest 149 → 174 |
| 全天 | **已知边界（后续清理候选）**：①file:// copyFile 分支（NapCat 本地路径场景）未围栏；②qq_send_* 的 URL 出站分支由 NapCat 侧抓取，插件不代理不围栏；③DNS rebinding TOCTOU 未彻底修复——dns.lookup 判定与实际建连之间仍存在时间窗，彻底修需 pinned IP dispatcher（超出本 wave 范围）；④两项清理建议：/ocr 的 fileToBase64 仍为两参调用（未接围栏）、imageSegment 死代码可删 |

### 2026-09-10（M1 Wave3：A8×3/A7/B6/B7/E2/C6a）

| 时间 | 工作 |
|---|---|
| 全天 | **A8-conn WS 帧上限 + reverse 拨入抖动防护（commit 4d32112，security）**：WS 帧上限 `MAX_FRAME_BYTES`=64MiB——取值兼容 get_file base64 大响应（大响应不被误杀）；reverse 拨入抖动防护：60s 滑动窗口限 5 次连接替换，超限拒绝，NapCat 掉线重拨不计入、不受限。**取舍**：抖动防护仅 reverse 侧，forward 行为不变 |
| 全天 | **A8-stt STT 命令探测去 shell（commit 978e3da，security）**：findCommand 由 `sh -c 'command -v …'` 拼接改为 PATH 逐目录扫描（access X_OK），全仓唯一一处 shell 拼接消除。**取舍**：`command -v` 与 PATH 扫描在 builtin/alias 解析上有差异，但探测对象 ffmpeg/whisper 均为二进制文件，语义等价 |
| 全天 | **A7 昵称消毒（临时方案）（commit f0a19da，security）**：sanitizeNickname 剥除 CR/LF/控制字符、空白折叠、按码点截断 32（代理对安全，不拆 emoji）；单一收口点接入全部下游（消息前缀/lastNickname/t2i 卡片标题/retry）。**取舍**：正文内伪造前缀行属对话结构注入，归 D5 体系化处理，本包不动 |
| 全天 | **B6 断线补发队列（commit 00a091c，reliability）**：SendOptions.queuable 白名单仅三个模型最终回复调用点置 true（settleLoop final flush / instant pendingFinal / turn 错误通知），interim/撤回/命令回复不入队；断线入 per-chat FIFO（TTL 5min、上限 20 超限丢最旧），onStatus(true) 按序 drain，drain 中再断线自动重新入队。**取舍**：仅模型最终回复可入队——interim/撤回/命令回复补发无意义（易过期或不该重发） |
| 全天 | **B7 busy 生命周期 + 入站频控（commit 0a618bc，reliability）**：turn/start 置 busy=true——/retry 防重入首次真正生效、/status 失真修复；新增配置 `rateLimitPerMinute`（默认 30，`0`=禁用）：每 chat 60s 滑动窗口，普通消息超限跳过 dispatch、每窗口至多一条限流提示，命令豁免（配置已进双语 README 配置表） |
| 全天 | **E2 flush 去抖（commit 0c6121c，reliability）**：onSessionFlush 改走 saveMappingDebounced——映射文件不再每次 flush 全量重写；stop() 强制落盘语义保留 |
| 全天 | **C6a 清理 + 命令路由前置（commit 4ba73a2，refactor）**：死代码三件删除（imageSegment/cqEscape/恒 false 的 mentioned 字段）；tryHandleCommand 前移到媒体解析/引用展开之前（带图命令不再白付图片下载 I/O）；/ocr 最近图片改惰性两级登记——命令消息中的图片仅在 /ocr 真正执行时才下载，三种场景行为等价核对；retiredSessionIds 数组→Set（磁盘格式不变） |
| 全天 | **A8-cq 提及门禁收紧（commit da81b7e，security）**：reply 段可判定被回复者时仅回复 bot 自身才算提及（回复群友不再唤醒），不可判定回落现状计为提及。**取舍**：fail-open 有意保留——被回复消息取不到时漏唤醒代价高于误唤醒；requireMention 行为语义变化，双语 README 描述已同步。vitest 174 → 200（+26），tsc 0 错误 |
| 全天 | **已知边界（后续清理候选）**：①qq_send_* 的 URL 出站分支仍由 NapCat 侧抓取，插件不代理不围栏（承 Wave2）；②DNS rebinding TOCTOU 时间窗仍在，彻底修需 pinned IP dispatcher；③正文内伪造前缀行归 D5；④B6 补发队列为 bridge 层内存态、按 chatId 组织，重启即丢；⑤B7 滑动窗口为内存态（重启清零），每 chat 首条消息不计窗 |

### 2026-09-10（M2 启动：T0 测试加固）

| 时间 | 工作 |
|---|---|
| 全天 | **M2-T0 启动（bridge.ts 五拆的测试安全网）**：用户确认生产已升 v0.2.1（90129d2 全量在产）；R5 NapCat 4401 重试 24h 观察由用户豁免收口；trim-cli 会话已建立，真机验证能力就位。T0 范围：①特征化测试补齐（命令路由全表/出站闸门矩阵/registry 持久化 round-trip/入站管线顺序/interim 时序/golden 快照/ensureChat 并发现状）；②tests/README.md 五拆迁移地图（现有用例 → commands/inbound/outbound/interim/registry/card-relay 目标 spec）；③打 pre-refactor-baseline tag。铁律：src/ 零改动，纯特征化钉现状 |
| 全天 | **T0 记录（commit 见 git log）**：vitest **212 passed + 1 todo（213）**（基线 200 → +12 特征化 +1 todo）、tsc 0 错误。新增 12 用例：/help 全表快照、14 命令非管理员拒绝矩阵（无副作用断言）、RESTRICTED_PREFIX 注入（成员注/管理员不注）、断线闸门直测（queuable 入队重连补发/非 queuable 抛 OneBotNotConnectedError）、mapping 真 round-trip（钉死：preset 从会话记录回填压过 config、model 无按会话持久化用当前 defaultModel）、collision 自愈端到端（映射清空→新后缀 id 重建+回填）、入站管线顺序 spy（policy→mention→command→media→quote→dispatch）、sendInterim 记账+回填+去重、settleLoop 先排空发送链再快照、golden×3（私聊纯文本/群聊@+工具调用 interim→摘要卡→撤回→final/长文本单 t2i 卡片）。桩设施增量：makeHarness +textImageThreshold、makeCmdHarness +restrictedMemberPrefix。**疑似已知竞态（实证）**：同 chatId 并发首条消息时 ensureChat 双过空表检查——agents.create 被调 2 次、同一裸 session id、chats 仅存后者（80ms create 延迟双并发实测）→ 按 PM 指示 it.todo 留待 M2-PR3 B8a 修复后转正，不固化绿断言；tests/README.md 已载实测证据。src/ 零改动 |
### 2026-09-11（M2 五拆进行中：T0/C2/PR1/PR2/PR3）

| 时间 | 工作 |
|---|---|
| 全天 | **M2-T0 特征化加固收口（commit 238ba61，src 零改动）**：+12 特征化用例钉现状——14 命令×非管理员拒绝矩阵（无副作用断言）、出站闸门直测（queuable 入队重连补发/非 queuable 抛 OneBotNotConnectedError）、mapping 真 round-trip（preset 从会话记录回填压过 config、model 无按会话持久化）、入站管线顺序 spy（policy→mention→command→media→quote→dispatch）、interim 时序（sendInterim 记账+settleLoop 排空）、golden×3（私聊纯文本/群聊@+工具调用 interim→摘要卡→撤回→final/长文本单 t2i 卡片）；ensureChat 并发竞态实证（80ms 双并发 agents.create×2、后者覆盖前者成孤儿）按 PM 指示 it.todo 留位不固化绿断言；tests/README.md 五拆迁移地图（65 条用例→五拆目标 spec；共享桩提取随 9b5701e 为 PR1 前置）；打基线 tag pre-refactor-baseline。**取舍**：纯钉现状——已知竞态进 todo 不进基线，红线留给 B8a 转正 |
| 全天 | **M2-C2 createChatAgent 工厂（commit fd3f33c）**：19 字段字面量 + buildSetup + modelWiring 三件套统一 ensureChat/loadMapping 双份装配（行为零变化）；lastNickname 分歧按现状保留并特征化钉死；字段快照测试钉装配面。**取舍**：分歧不趁 refactor 顺手改——改行为走独立评审，五拆期间断言语义不动 |
| 全天 | **M2-PR1 命令表化（commit da7b549）**：新建 src/commands.ts（568 行）——14 命令一行一注册；窄接口 CommandContext（30 成员，按处理器实际触达面收敛）；/help 由表生成（与原硬编码逐字一致）；adminOnly 从分支判断改声明性元数据；15 条命令用例迁 tests/commands.spec.ts；bridge.ts 2249→1814；tools.ts diff=0。**取舍**：门禁仍守路由入口单点，不随 adminOnly 元数据散落各处理器 |
| 全天 | **M2-PR2 出站管线（commit 4243625）**：新建 src/outbound.ts（249 行，OutboundPipeline 类，B6 pendingSends 随迁）+ src/card-relay.ts（83 行，计划书/提问卡渲染近乎纯函数）；bridge 保留同名 facade（sendToChat 等调用面不变）；interim 五件套零触碰走 facade；bridge.ts →1624；golden 三条留守 bridge.spec。**取舍**：facade 防涟漪——tools.ts 零改动优先于一次性搬净 |
| 全天 | **M2-PR3a 会话注册表（commit 66b2dbe）**：新建 src/registry.ts（786 行，ChatRegistry）——chats/bySession/ensureChat/loadMapping/createChatAgent/mapping/retired 全域搬入；ChatSettings 值对象收拢 5 Map+pendingImageRef（/new survive 语义逐字保持）。**取舍**：行为零变化为唯一验收——持久化格式逐字节不变 |
| 全天 | **M2-PR3b B8 四子项（commit 278006f）**：a) ensureChat in-flight 缓存——T0 it.todo 转正（并发 10 条 create 恰 1 次）；b) 孤儿 agent dispose（create/resume 双路径）；c) 空闲淘汰 `chatIdleEvictDays`（默认 7，`0`=禁用；flush 成功才 dispose、不 retire、映射保留可 resume；双语 README 配置表已加行）；d) 发送链解耦——outbound 自有 sendChains，未注册 chat 也串行；bridge.ts →1116，持久化 JSON 格式逐字节不变。合并树 vitest **221/221** 全绿（200→221，+21）、tsc 0 错误。**取舍**：淘汰只清内存态——先 flush 后 dispose 且映射保留，宁多一次 resume 不丢会话 |
| 全天 | **已知边界（后续清理候选）**：①outbound 自有 pendingSends 后，bridge.ts 残留同名死字段/死代码路径，PR4 清理；②B8c 空闲淘汰连 ChatSettings 一并清空——/workspace /preset /mode 等 per-chat override 随之重置，与 /new survive 语义不一致，是否保留属产品决策待定；③commands 命令表冻结、CommandChatView 结构子型——扩命令/触达面须同步 CommandContext 窄接口；④qq_send_* URL 出站分支 NapCat 侧抓取、DNS rebinding TOCTOU 时间窗——承 M1 Wave2/Wave3 已知边界未变 |

补记：生产 v0.2.1 运行由用户确认、R5 NapCat 4401 重试 24h 观察由用户豁免收口、trim-cli 会话就位（真机验证能力可用）——此前仅口头确认、只在 2026-09-10「M2 启动」T0 行随 T0 前置带过，本行集中补记存档。

### 2026-09-12（M2 收官：五拆完成，v0.3.0）

| 时间 | 工作 |
|---|---|
| 全天 | **M2 收官核对 + 发布 v0.3.0**：五拆完成——bridge.ts 2249→681（-70%），七模块 bridge/registry/commands/inbound/outbound/interim/card-relay 合计 3168 行；测试 200→234（vitest 234/234、tsc 0 错误）；行为零变化（唯一有意变更 = C5a /model 会话级语义）；全程 tools.ts diff=0；基线 tag pre-refactor-baseline →五个 PR 逐个独立 commit 可 revert。B8 收尾核对五项全部测试落位：B8a ensureChat in-flight 缓存（tests/registry.spec.ts:967，并发首条 create 恰 1 次）；B8b 孤儿 agent dispose（tests/registry.spec.ts:978，whenIdle 抛错路径 dispose×1+零残留）；B8c 空闲淘汰 chatIdleEvictDays（tests/registry.spec.ts:1001，dispose+映射保留+resume 同会话恢复）；B8d 发送链解耦（tests/bridge.spec.ts:533，未注册 chat 亦串行）；recalledInterimIds turn/start 修剪（tests/interim.spec.ts:490，同 id 复用不复发）。**已知边界承前**：file:// 分支、DNS rebinding TOCTOU、URL 出站（NapCat 侧抓取）、正文伪前缀属 D5；B8c 淘汰即重置 per-chat override 待产品决策；commands 直写 ChatAgent interim 字段待 D2 收口 |
| 全天 | **发布完整性修复（v0.3.0 重打 tag）**：v0.3.0 tag 的 lib/ 缺五拆六模块产物（用户核查发现）——card-relay/commands/inbound/interim/outbound/registry 六模块 JS 及 lib/types 对应 .d.ts 从未 git add，直接 checkout v0.3.0 不构建的环境会因缺模块挂掉；build.sh resolve_dsh_root 自 link-host.sh 原样移植 npm/nvm 全局布局分支（bin 祖先内探测 `lib/node_modules/@deepseek-ai/dsh/node_modules`），重建产物后 v0.3.0 tag 重打为 4d90469 之后的修复提交。提醒：v0.2.x tag 的 lib 为 M0 时代内容（功能完整但滞后，不回补） |

### 2026-09-12（M3 收官：D2/D4/D5/E3，v0.4.0）

| 时间 | 工作 |
|---|---|
| 全天 | **M3-D2 interim 显式状态机**（8ba1c77/be53abe）：InterimTracker 显式转移表 idle/accumulating/settling（stateOf 诊断缝；双 turn/end 跳过、迟到 assistant 宽容语义保留）；sendInterim 同步记账——placeholder 入队即占位、发送完成按 id 回填、失败丢占位，消除 push 回调微任务顺序依赖；结算 drain 以 inFlight 集合等待在途发送全部落定；`interimRecall` 降级开关（false=只发不撤：无撤回无小结卡）；tests/interim-machine.spec.ts 全转移表覆盖，settle 用例固定 120ms 预算与 60ms 撤回间隔的时序竞态改为 vi.waitFor 终态谓词（idle 在排水最后置位），连续 10 次全绿 |
| 全天 | **M3-D4 配置与持久化**：D4a（5a7f26b）配置改名三件——`imageMaxSize`→`inboundImageMaxPx`、`maxImageBytes`→`outboundImageMaxBytes`、`maxInboundFileBytes`→`inboundFileMaxBytes`（旧名 deprecated 别名等价兼容一版，config-alias 测试钉住）；D4b（529a49c）`/mode` `/goal` per-chat 状态持久化进 chat-sessions.json（加法格式：旧文件裸 session id 照常解析；淘汰快照携带持久化设置，修复空闲淘汰丢 per-chat override）；D4c（ff7eafb）STT 非阻塞——[语音] 占位先行不阻塞回合，转写完成后以（语音转写：…）steer 进当前回合（agent 空闲则开新回合，失败保留占位），默认超时 300s→60s |
| 全天 | **M3-D5 提示注入隔离**（82c10ed）：QQ 消息正文进 user_message 边界；群成员昵称白名单化；平台声明替换 M1-A7 临时方案（正文可打出字面闭标签依赖平台声明向 agent 说明真边界） |
| 全天 | **M3-E3 日志统一**（b79994c/43ac50c）：E3a errors.ts describeError 替换全仓错误样板（error 日志带堆栈）；E3b connection 日志端口化——裸 console 退出，统一注入式日志 |
| 全天 | **已知边界（后续清理候选）**：①正文可打出字面闭标签依赖平台声明（D5）；②t2i/fonts.ts 豁免（字体探测 fs 直读不在注入边界内）；③steer 跨回合污染有标注（转写补递可能落进下一回合）；④llmCatalog 缺省目录为空 |
| 全天 | **发布 v0.4.0**：测试 200→283 全程（vitest 283/283、tsc 0 错误），v0.3.0→v0.4.0；lib 产物完整性校验（v0.3.0 缺六模块事故教训：commit 前 git ls-files 数量与 src 模块数核对、六拆模块 js+d.ts 齐全，commit 后 ls-tree 复核） |

### 2026-09-12（M4 交互与持久化：未知命令拦截 / 序号选择 / workspace 持久化）

| 时间 | 工作 |
|---|---|
| 全天 | **M4 启动与基线**：基于 v0.4.0（HEAD fac751a，工作树未提交改动），测试基线 283；三个工作包 T1（R1 未知命令拦截）、T2（R2 序号选择）、T3（R3 workspace 持久化+默认目录）串行实施，T4 独立评审门禁收口，T5 文档回写（本条目+双语 README） |
| 全天 | **R1 未知命令拦截（新配置 `unknownCommand`，`intercept`（默认）/`passthrough`）**：动机——斜杠命令手滑打错（如 /hel）会整条透传给模型，模型不了解命令语义、回复易误导。行为——未知 /纯单词 命令先模糊匹配已知命令：前缀匹配优先，编辑距离 ≤2 兜底（仅输入长度 ≥4 时启用，防 /id /ver 等短命令被误匹配），至多列 3 个候选，命中回复「未知命令 /xxx，你是想用 /yyy 吗？」并拦截（不进模型）；无候选时 intercept（默认）回复「未知命令 /xxx。发 /help 查看命令列表；要让模型处理请去掉开头的 / 重发。」并拦截，passthrough 维持旧行为透传给模型；/help 尾行同步改为「未知命令默认拦截并提示相近命令；配置 unknownCommand: passthrough 可改为透传给模型。」；非 /纯单词 开头的文本（如 /tmp/x）不受影响仍交模型，非管理员斜杠消息仍被管理员门禁拦截（不进建议路径）。接线三段：index.ts schema（默认 intercept）、bridge→commands config 注入、commands.ts 路由 suggestCommands+editDistanceWithin2；commands.spec +5 |
| 全天 | **R2 序号选择（/workspace /model /preset）**：动机——QQ 端手打长路径/provider/model 全名易错且费事。行为——三命令无参时输出编号列表（/workspace 标「← 当前」），回复 `/workspace 2` 这类序号即可选择；选择基于命令输出时的列表快照（PendingSelection：per-chat 单槽、内存态、不持久化），TTL 5 分钟 lazy 判定（无定时器，下次序号回复时判定，过期提示重新查看；越界保留快照可原地重试）；纯数字参数仅在有同 kind 有效快照时按序号解释，否则维持原语义（/workspace <路径>、/model <provider> <model>、/preset <id>）；/model 为两级——先列 provider 序号，选中后列该 provider 模型序号，选中走原切换路径改当前会话模型（`--default` 直用形式不变，非纯数字不受影响）。registry.ts 新增 PendingSelection 类型与 ChatSettings.pendingSelection 字段，bridge 注入 pendingSelection/setPendingSelection 访问器 |
| 全天 | **R3 workspace 持久化 + 默认目录（T3，方案 C→B）**：workspacePath 加入 PersistedChatSettings（加法格式：旧文件裸 session id 照常解析；无持久化设置时条目逐字节不变）；loadMapping 在 resume 尝试之前恢复覆盖（洞 B：resume 失败 retire→fresh 也不丢）；/workspace 切换路径 flush 映射（洞 C：设置即时落盘）；对 /new 同样保持（settings 载体，T4 回炉固化）。**默认目录方案 C→B 决策**：方案 C（主选）=向宿主可编程查询默认工作区——证据链：WorkspaceRegistry 无 default getter（仅 resolveByPath/list 已有工作区），session controller 的 defaultCwd 属组装内部态不外露（index.ts T3 注释存证）→ 宿主拿不到，降级方案 B = 未配置 workspacePath 时默认仍为宿主进程 cwd + 插件启动 warn 一次（index.ts：workspacePath === '' 时 warn，建议显式配置、避免会话工作区落在宿主启动目录）；README 配置表 workspacePath 行同步。映射往返/旧格式兼容/洞 B 闭合/淘汰周期保持均有用例 |
| 全天 | **T3 超任务书追加 4 项**（任务书仅要求 workspacePath 入映射 + loadMapping 恢复 + C/B 决策；实现中为闭合持久化链路追加，已标记待 T4 重点核查）：①洞 C noteWorkspaceOverride——非活跃 chat（未建会话/resume 失败）执行 /workspace 切换时快照进 evictedChats，否则 settings-only chat 会被任一次 saveMapping 从文件抹掉；②createChat 已退役快照跳过——evicted 快照记录 retired session（/new、/workspace 后的设置载体）时跳过 resume 直接重建，防复活已退役历史；③restoreEvictedSettings 抽取共用——in-run 淘汰→再激活路径把 workspacePath 连同 mode/goal 一并回填（原 D4b 只回 mode/goal）；④loadMapping retired-session 快速路径——retired id 的对象条目不 resume、只取设置 |
| 全天 | **T4 独立评审门禁：同意、无阻塞项；2 条建议改进回炉闭环（+3 用例）**：①loadMapping 将 retired 对象条目重登记进 evictedChats——settings-only chat 不在 chats/evictedChats，一次 mid-flight saveMapping（stop() 或他 chat createChat）就会把 workspacePath/goal/mode 从文件抹掉、下个重启全丢；②snapshotRetainedSettings 共用载体——resetChat 与 healSessionCollision 在有持久化设置时把条目快照进 evictedChats（retired id 之下，永不 resume），无持久化设置保持 pre-T3 丢弃行为（正反两分支均钉用例）。PM 检查点放行 T5 |
| 全天 | **测试 283→306 全绿**（T1 +5→288、T2 +6→294、T3 +9→303、T4 回炉 +3→306），npm test 全绿、build 退出 0；T5 文档回写：DEVLOG 本条目 + 双语 README（命令行为段/unknownCommand 配置行/workspacePath 说明/透传说明改写/最后验证与测试数更新） |
| 全天 | **遗留清单（M4 评审记录，M5 候选）**：①**saveMapping 的 `??` 字段并集**——触发：chat 被空闲淘汰后执行 /goal clear，之后任一次 saveMapping；影响：live.goal 为 undefined 时 `??` 回退 evictedChats 快照旧值，已清除的 goal 复活并每轮重新提醒；建议方向：哨兵值区分「未设/已清」（或 clear 时同步清快照）。②**PendingSelection 单槽跨 kind**——触发：/model 列表在场时误回其他命令旧列表的序号（如 /workspace 1）；影响：无同 kind 快照 → 走原参数路径报错（如「目录无效：1」），提示略费解；建议方向：跨 kind 的序号回复给明确提示（当前不消费、行为安全但反直觉）。③**pendingSelection 随 ChatSettings 在 /new 后保留**——触发：列列表后执行 /new、TTL（5 分钟）内回序号；影响：序号仍可用（不持久化、到期自然失效，无害但语义略怪）；建议方向：/new 时顺手清 pendingSelection。④**幻影 bare id 累积（优先级最高）**——触发：每次重启 resume 失败的 session id 都会 retireSession 永久追加进 retired-sessions.json（append-only、无清理路径）；影响：文件只增不减、缓慢膨胀，有累积效应；建议方向：「同 id 已 retired 不重复追加」+ 定期清理，M5 候选首项 |

### 2026-09-13（M5：/session 历史会话切换）

| 时间 | 工作 |
|---|---|
| 全天 | **M5 启动：/session 命令**——动机：/new、/workspace、/preset 每次切换都把旧会话退休在磁盘，但用户无法回去；任务书要求按序号切回历史会话并恢复其历史上下文，支持来回切。基线 306 测试全绿（m0-hardening @9841167，工作树干净） |
| 全天 | **关键取舍：resume 放行例外 → 切换成功后 unRetire（与任务书设计建议偏离，已报告）**——任务书建议 createChat evicted 分支与 loadMapping 的 retired 跳过分支改为「retired 且在该 chat 可切回列表且未 broken → 允许 resume」。分析发现该例外无法与 T3 设置载体共存：/new（含持久化设置时）恰好会留下「retired + 在列表」的载体条目，基于列表成员的例外会让 /new 后的下一条消息（或一次重启）复活刚被 /new 掉的会话，直接违背 /new 契约与本任务自己钉死的端到端用例（/new → 下一条必须 create 新会话，除非显式 /session）。改为：switchSession 成功 resume 目标后调用 unRetireSession（brokenSessions/retiredSessionIds 双删 + saveRetired 落盘），目标回到「未退休」状态，重启 loadMapping、空闲淘汰后再激活全部走**常规路径**找回；create 路径的 isSessionIdBlocked 一字未动，T3 载体语义逐字节保留。un-retire 后 create 路径仍安全：hasPersistedLog 预检兜住目标自身日志、agents.create 碰撞回退兜底 |
| 全天 | **软/硬退休拆分**——retireSession（broken+retired 双集+落盘）仅保留给真实损坏路径（heal、create 碰撞、stale log、resume 失败）；resetChat 改为软退休（仅 retiredSessionIds+落盘+记入可切回列表），并当 bare 派生 id 就是当前会话（初代 /new）时跳过原有的 bare id 硬退休（软退休已覆盖重启防碰撞，硬退休会把初代会话标记为 broken 导致永不可切回）；loadRetired 不再把文件 id 回填 brokenSessions（文件无法区分来源，blocked 并集对 create 路径行为不变） |
| 全天 | **实现三件套**——registry.ts：SWITCHABLE_FILE（switchable-sessions.json，纪律照抄 loadRetired/saveRetired：ENOENT=全新、读失败/损坏保留内存并 warn、tmp+rename 原子写；每 chat 上限 20 条、去重、最新在前）、switchableSessions()/switchSession()（校验目标在该 chat 列表内且未 broken，busy 拒绝；在线走 resetChat 退休半段+resumeChat，离线走 noteWorkspaceOverride 式 evictedChats 载体；resume 失败→硬退休目标+移出列表+落盘映射，下一条消息全新会话，不卡死）、PendingSelection kind 加 'session'；commands.ts：/session 入命令表（/help 自动收录）、无参渲染编号列表（含 YYYY-MM-DD HH:mm 退休时间）+ 设 kind 'session' 快照、序号走 resolveNumericSelection、busy 先拒（提示 /stop）且不消费快照、/status 追加「可切回」计数行；bridge.ts：commandCtx 透传两方法 + start() 装载 loadSwitchable |
| 全天 | **测试 306→321 全绿**（新增 tests/session-switch.spec.ts 15 用例：列表持久化/上限去重/损坏文件纪律、resetChat 软退休、broken 拒绝与跨 chat 隔离、在线来回切、resume 失败回退、碰撞 heal 与 create 碰撞绝不入列表、**e2e 钉死 /new→/session 1→下一条普通消息 agents.resume 收到原 session id 且 create 仅 1 次**、重启 loadMapping 恢复切换后目标、越界保留快照/非数字用法行、busy 拒绝、/status 计数）；commands.spec 命令表用例同步 14→15（含 /help 全文快照行）；npm test 321/321、npm run build 退出 0 |
| 全天 | **文档回写**——README 能力表命令单元格、斜杠命令速查表（/session 行+/status 行更新）、模型平台说明「14 个→15 个」、/session 持久化与回退语义说明段；DEVLOG 本条目。遗留：src/prompt.ts 的模型平台提示词命令清单未列 /session（任务书范围外，建议后续同步，避免模型不知该命令）；M4 遗留清单 ④（幻影 bare id）可借 unRetire 机制一并治理，M5 后续候选 |

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

### 3.16 link-host 在 nvm 全局布局下链到 npx store 副本（2026-08-17，已修复）
- **症状**：dsh 升级到 rc.7 后重跑 link-host.sh，插件 node_modules/@deepseek-ai/* 被链到 `~/.npm/_npx/dsh-onebot/node_modules/@deepseek-ai/*`（一个历史 npx store 残留），而非宿主进程实际加载的全局安装（`<nvm>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`）
- **根因**：`resolve_dsh_root` 第一路按 bin 祖先找 `node_modules/@deepseek-ai`——nvm 全局布局下 bin 在 `<node>/bin`、包在 `lib/node_modules/@deepseek-ai/dsh/node_modules` 内嵌，祖先循环命中不了；于是落入第二路 npx store 扫描，先到先得（store 是旧的都可能）。**宿主进程用全局副本、插件用 npx store 副本 = 同一版本号的物理两份实例**（dual-package hazard：brand Symbol/instanceof 可能断裂）
- **修复**：bin 祖先循环增加 `$dir/lib/node_modules/@deepseek-ai/dsh/node_modules` 检测（存在即优先返回，脚本调用处再拼 `/@deepseek-ai/<pkg>`），npx store 仅作最后回退。幂等重跑验证：链接目标变为 `<nvm>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent`，tsc 零错误、23/23 bridge 测试过（rc.7 类型）
- **升级联动**：npm 全局装 rc.7 → link-host 修复重链 → kill 主进程由 launchd ai.dsh.web KeepAlive 自动拉起 → 日志确认 bridge ready (1 resumed)、agent joined preset router-flash、heartbeat 恢复、bin --version = 0.1.0-rc.7

### 3.17 /new 后 id collision 复发：裸 id 永久退休 + retired 三条防线加固（2026-08-18，已修复）
- **症状**：§3.14 修复上线后仍复发——`/new` 后新会话创建在**裸 id**（`onebot-private-841859784`）上，下一条消息 `turn/end: error`（`session flush failed: ... id collision`），heal 后需再补发一条才恢复，跟 §3.14 一模一样
- **现场还原**（日志 3239-3421 行 + 磁盘证据链）：
  1. 裸 id 的磁盘日志 `~/.dsh/sessions/--Users-mario--/onebot-private-841859784/session.jsonl.zstd` 从 8/16 起就是**存量残留**，这个 id 必须永久退休
  2. **防线①(loadRetired) 失效**：8/17 22:40 重启段（日志 `mounted` 到 `bridge ready` 之间）**没有** `retired-sessions file has N id(s)` debug 行（更早启动有「4 id(s)」）→ `loadRetired()` 读取 retired-sessions.json 失败被 `catch{}` 静默吞掉（把一切错误当「首次启动」）→ 内存 `retiredSessionIds` 变空
  3. **防线②(saveRetired) 非原子 + 覆盖丢史**：22:54 用户 `/new` → `resetChat` 只用内存数组 retire 当前会话 id（`-msx93frw`）并 `saveRetired()` **用空数组覆盖文件** → 4 个历史 retired id 全部丢失（文件 4→1）
  4. 22:56 用户发消息 → `ensureChat` 用回裸 id → 持久层抛 id collision → turn/end error → 报错 + `healSessionCollision` 补 retire 裸 id（文件 1→2，mtime 22:56:22 与报错同刻）
- **缺陷本质**：三条防线各自都不可靠——load 静默吞错 / save 非原子会以空数组覆盖历史 / `/new` 与自愈都不 retire 裸 id；§3.14 只堵了「重启后裸 id 被复用」却没堵「本次运行内 /new 就用裸 id」
- **修复**（src/bridge.ts）：
  - **`/new` 与自愈 retire 裸 id**：`resetChat()`、`healSessionCollision()` 在 retire 当前会话 id 之外追加 `retireSession(sessionIdForChat(chatId))` —— 裸 id 一旦要被替换，其磁盘日志永远与新会话冲突，必须永久禁（本次 bug 的直接根治）
  - **`loadRetired()` 区分真·首次 vs 真·错误**：仅 `ENOENT` 静默（真·fresh start）；文件读出失败/JSON 损坏/非数组一律 `log('warn', ...)` 并**保持内存+磁盘数组不动**——绝不静默后由下一次 `saveRetired` 用空数组覆盖
  - **`saveRetired()` 原子写**：写 `retired-sessions.json.tmp` 后 `rename` 覆盖，防半截文件/并发写坏（配合上一条：文件要么完整要么不存在）
  - **`ensureChat()` 创建前探测残余日志（最终兜底）**：新增 `hasPersistedLog(id)`（用注入的 `sessionPersistence.inspect(id)` 试读：成功=true、抛错=false）；裸 id 未被 blocked 时先探测，有残留日志 → `retireSession(bareId)` 再走 `freshSessionId` —— 即使 retired 文件被清空也绝不再撞盘
- **验证**：tsc 零错误；vitest 108/108 全绿（26 例 bridge）。新增 3 例：mapping 空 + 裸 id 磁盘有日志 → ensureChat 用带时间戳后缀新 id 且裸 id 落入 retired 集；resetChat 后 retiredSessionIds 同时含裸 id 与当前会话 id；loadRetired 遇损坏 JSON → warn 且不覆盖既有内存数组 + save 原子落盘（无 .tmp 残留）。另修测试自身一个 ASI 陷阱（`await vi.waitFor(...)` 后接 `(bridge...)` 行被吞进前一表达式报 `vi.waitFor(...) is not a function`，加前置 `;`）
- **不做**：存量裸 id 磁盘日志不迁移/清理（用户此前决策「存量不迁移」；裸 id 靠 continue 退休永久避开）；不动宿主 dsh（本次为 onebot 插件缺陷）

### 3.18 新增 9 个斜杠命令：/preset /status /retry /id /ver /ocr /mode /plan /goal（2026-08-18，已实现待上线）
- **动机**：用户 `/plan` 会话里要求「onebot 支持更多斜杠命令」，确认新增 7 个后又追加 /plan 与 /goal（/plan=per-chat 计划模式开关+计划指令；/goal=per-chat 目标记录提醒。宿主 bundle 无 plan/goal 服务暴露，不做真宿主 goal 创建）
- **实现**（src/bridge.ts）：
  - 新增 bridge 级 per-chat map：`chatPresetOverrides` / `chatInterimOverrides` / `chatPlanModes` / `chatGoals` / `chatLastImagePaths`（均跨 /new 保留，进程内态，重启回退配置/默认——与 /workspace 覆盖同语义）；`ChatAgent` 加 `lastFollowup`（/retry 用）
  - 入站收拢到 `dispatchFollowup(chatId, text, nickname)`：统一记录 lastFollowup + `prefixTurn`（goal 提醒→plan 指令前置）+ followup。`resolveMediaRef` 传入 chatId 并在图片解析成功时记录 `chatLastImagePaths`（/ocr 取最近图）
  - `/preset`：无参列出可用（扫描 `<dsh-home>/.agent-presets/*/preset.yml` 的 name）+当前（覆盖→resolvePresetId）；`/preset <id>` 用 `agentPresets.resolve` 校验，写覆盖 + resetChat 重建（下一条消息 resolvePresetId 以覆盖优先，header 记录新 preset）
  - `/status`：chat/session（无活跃会话读 chat-sessions.json）/preset/model/cwd/出站模式（含 /mode 覆盖标注）/agent 忙闲；`/id` 与 `/ver`（package.json version + git short hash，各读一次缓存）为纯读
  - `/mode [interim|instant]`：`chatInterimOverrides` 覆盖；`effectiveInterim(chatId)` 替换原 `config.interimMessages` 两处分支（assistant/message 与 turn/end）
  - `/retry`：无 chat/无 lastFollowup → 提示；busy 拒绝；否则清 loop 残留后重放 lastFollowup（prefixTurn 现算，/plan 状态改变后可影响重试结果）
  - `/ocr`：取 `chatLastImagePaths` → `fileToBase64` → `connection.call('ocr_image', { image: 'base64://'+b64 })` → `data.texts` 拼行回复；无图/读取失败/识别失败各有提示
  - `/plan`：on/off 开关 + `/plan <内容>` 置 on 并以计划指令处理；`/goal`：显示/设置/`clear` 清除，每轮自动附「【当前目标】」提醒
  - index.ts 增 `dshHome()` 注入；BridgeDeps 增可选 `dshHome`（供 /preset 枚举）；/help 文案与 README 同步
- **验证**：tsc 零错误；vitest 113/113 全绿（31 例 bridge，+5：/id /ver /status 信息、/goal /plan /mode per-chat 状态与前缀、/retry 重放与 /new 后清除、/preset 切换重建（mock resolve）与无效拒绝、/ocr 无图提示 + mock ocr_image 成功）
- **待上线**：构建 lib → kill 主进程由 launchd ai.dsh.web 拉起 → `/ver` `/status` `/id` 真机看输出；`/ocr` 需用户发图实测（NapCat ocr_image 对 base64 的接受度以真机为准，失败则退 file/直链）
- **上线状态（§3.25 补记）**：随 8/18~8/19 构建与 8/26 重启在线上；8/28 会话系统提示已含 §3.24 校准后的完整 14 命令表（线上 prompt 实证）；各命令真机实测细节未单独记录，日志核查无报错痕迹

### 3.19 /workspace 跨重启持久化（方案 B）+ 宿主计划书/提问卡中继到 QQ（2026-08-18，已实现待上线）
- **需求**：① `/workspace` 指定工作区后重启应默认继续使用；② 宿主弹「计划书/选项卡」时 QQ 端静默、对话停住——exit_plan_mode 的 plan-review 卡与 ask_user_question 走宿主平面 ctx.userQuestions，不经 session 事件流；模型调用时文本块为空，原 `text === ''` 早返回让 QQ 静默
- **实现**（src/bridge.ts）：
  - **方案 B（workspace 回填）**：`loadMapping` resume 成功后，若 `handle.agent.session.header?.cwd` 非空且 != `effectiveCwd()` 默认，回填 `chatWorkspacePaths.set(chatId, header.cwd)`。重启后该 chat 的 /workspace 显示原目录、/new 新会话也用回原目录；cwd==默认的旧 chat 不产生多余覆盖。不动 mapping 结构、无迁移
  - **计划/提问中继**：`onSessionEvent` 的 assistant/message 分支，dedupe 之后、`text === ''` 早返回之前调用 `relayHostCards`——扫描 content 的 tool-call 块：`exit_plan_mode` → renderPlanCard（「【📋 计划书】…plan 全文」）、`ask_user_question` → renderQuestionCard（编号问题 + 选项 + 多选标注），走 sendToChat 出站管线（自动分段/t2i）。independent of interim 模式；沿用 lastHandledMessageId 去重；arguments 解析失败降级静默。边界：QQ 回复暂不能操作宿主 plan-review/option 确认（宿主平面，不动宿主），只保证用户能获知内容
- **验证**：tsc 零错误；vitest 115/115 全绿（33 例 bridge，+2：resume 非默认 cwd → 覆盖回填 + cwd==默认 → 无覆盖；计划书/提问中继内容 + 同 id 连续重发去重）。测试注意：dedupe 只记「最近一次」message id，重发必须紧跟原发、中间不能插新 id
- **真机（已上线验证）**：中继生效——ask_user_question 提问以 **t2i 卡片**到达 QQ、可 QQ 直接作答，且 QQ 作答能解析上游 ask_user_question（工具调用返回了 QQ 文本答案，对话不卡死）。**已知限制**：Web 端提问/计划卡视觉上不自动清除——宿主平面 UI（ctx.userQuestions），onebot 不动宿主无法处理，仅保证 QQ 端可获知+可作答。`/workspace` 跨重启真机：当前 chat 为默认 cwd 不触发回填（符合设计），需用户 /workspace 切非默认目录后重启实测

### 3.20 受守卫文件编辑 code_safe_edit/rollback/list_backups + code-safe-edit skill（2026-08-18，已上线后拆至 dsh-safe-edit）
- **需求**：用户问可否借鉴 irmia_devkit 的 safe_edit（AGPL-3.0）→ 定方案 A1：全渠道可用 + QQ 管理员门控 + skill 引导模型默认优先
- **实现**（src/safe-edit.ts + src/tools.ts + src/bridge.ts + src/index.ts + src/prompt.ts + skill）：
  - `safe-edit.ts`：`checkPathAllowed`（根内 + .. 穿越 + 符号链接逃逸）→ read（CRLF 归一）→ `backupFor`（时间戳 .bak + 惰性剪枝 50 份）→ 匹配链（精确 → `stripLineNumberPrefixes` 剥读输出行号前缀 → `alignWhitespace` Aider 式缩进增量对齐）→ 多匹配返回 `{matches:[{line,col,preview}]}` + occurrence=N/replace_all → replace/insert_at_line/delete_lines → 原子写（tmp+rename）→ 语法检查（js/cjs/mjs `node --check`，可注入桩）→ 失败 `finishEdit` 自动回滚 + 结构化错误；`safeRollback`（回滚前再备份当前状态，可撤销）；`listBackups`（≤50）
  - `tools.ts`：注册三工具（仅当 `safeEditRoot` 非空）；门控走 `bridge.canEditFiles(sessionId)`（A1：onebot chat 需最近入站用户是管理员，非 QQ 会话默认放行；chat 存在但无入站者 → 拒绝）
  - `bridge.ts`：ChatAgent 加 `lastUserId`（processInbound 写回），新增公共 `canEditFiles`
  - `index.ts`：Config 加 `safeEditRoot`/`backupDir`（schema 默认 ''=禁）
  - `prompt.ts`：QQ 平台说明加「改文件优先 code_safe_edit」
  - skill：`code-safe-edit`（全渠道：优先 tool、流程、回滚、坑）
  - 部署配置 `~/dsh/profiles/web/cordis.patch.yml` 设 `safeEditRoot: /Users/mario/workspace`
- **验证**：tsc 0 错误；vitest 128/128 全绿（12 文件，+safe-edit 10 例 + 门控 1 例）。测试注意：align 后须回写对齐后的 newText（否则替换丢缩进）；insert_at_line 的 insert 不能自带尾 \n（join 会再补一个）
- **待上线**：构建 → kill 由 launchd 拉起 → 真机：QQ 让 bot 用 code_safe_edit 改 workspace 下文件测一次（含一次改坏语法看自动回滚）
- **后续**：2026-08-18 已上线，随后按用户要求拆分为独立插件 dsh-safe-edit（见 §3.21），本段保留为拆分前 A1 实现的历史记录

### 3.21 安全编辑从 onebot 拆分为独立插件 dsh-safe-edit（2026-08-18，已完成上线）
- **需求**：用户问"全局生效"——code_safe_edit 原只随 onebot 在 QQ 通道注册，规则也只在 QQ 平台提示词注入；想把安全编辑拆成独立插件，让 Web 等其他通道也能用；同时要"全局规则注入"（~/.dsh/AGENTS.md）
- **三个决策（用户拍板）**：① 权限策略**默认允许所有会话编辑**（去掉原 A1 的 QQ 管理员门控）；② 可编辑根**跟随会话 sandbox 策略**：`danger-full-access` 无限制、`workspace-write` 限会话工作区、`read-only` 拒绝；③ 仅本机落地（不做 git/npm 发布）
- **实现**（独立插件 `~/dsh-plugins/dsh-safe-edit/`，Cordis 直挂 patch）：
  - `src/safe-edit.ts`：从 onebot 原样搬运（零 onebot 依赖，只 import node:*）；`checkPathAllowed` 语义改为 `root===''`=无限制（原为禁）
  - `src/policy.ts`：`resolveRoot(policy, configRoot, configBackupDir)`——policy 三档映射 + 无策略服务回落 config、空根拒绝
  - `src/tools.ts`：注册三工具，`rootFor(exec)` 每次按 `ctx.get('sandboxPolicy').resolve({session})` 解析边界；`inject: ['tools']`
  - `src/index.ts`：Config `safeEditRoot`（默认 `/Users/mario/workspace`）/`backupDir`
  - 挂载：`~/dsh/profiles/web/cordis.patch.yml` 移除 onebot 的 safeEditRoot 条目、新增 `dsh-safe-edit` 条目
  - onebot 侧删除：src/safe-edit.ts、tests/safe-edit.spec.ts、tools.ts 注册块（含 assertEditingAllowed/bridge.canEditFiles 依赖）、index.ts 的 safeEditRoot/backupDir 配置；prompt.ts 的「优先 code_safe_edit」提示保留（工具已全局，指引仍有效）；README/DEVLOG 同步
  - 测试迁到 dsh-safe-edit（7/7 全绿：原 6 例 + 新增 resolveRoot 三档映射 1 例；空 root 语义断言更新为"unrestricted"）
- **坑（真机排查出根因）**：首次实现 `resolvePolicy` 只给 sandbox-policy 的 `resolve()` 传 `{id}` stub——但 dsh 的 `SandboxPolicyService.resolve` 会读 `session.events`/`session.header.cwd`，stub 无 events → `Cannot read properties of undefined (reading 'length')`。**修复**：按 dsh-tool-bash 的做法直接传完整 `exec.agent.session` 对象。另外 HMR 只重应用配置快照、**不重新 require 插件 JS**，改完 `lib/*.js` 必须重启 dsh（launchd `ai.dsh.web` kill 自动拉起）才生效
- **验证**：onebot tsc 0 错误 + 118/118 全绿（safe-edit 相关 10 例移除后无回归）；dsh-safe-edit 7/7 全绿；真机（重启后）code_safe_edit 编辑 /Users/mario/workspace 文件成功、自动生成 .bak、code_safe_rollback 恢复；~/.dsh/AGENTS.md 已注入生效

### 3.22 /plan 转发宿主命令：修复 QQ 无法退出宿主计划模式（2026-08-18，已实现待上线）
- **症状（用户报告并确认）**：QQ 无法退出 plan 模式。根因双重锁死：① 插件 `/plan`（3.18 版自建「前缀计划模式」）劫持了宿主同名命令，QQ 发 `/plan off` 只关前缀 flag，宿主 plan-mode 的 `/plan off` 命令收不到；② 3.17(方案 A) 的 prompt 明令禁用 `exit_plan_mode` → 宿主 plan-mode 唯一工具退路被堵 → 只剩 Web 切换 session 模式
- **关键事实（源码核实 dsh-plan-mode）**：宿主 `/plan` 命令 `handler` 里 `/plan off` 走 `set(agent,false)` **纯文本直退、无 userQuestions/审批卡**；`/plan <内容>` 会 `agent.steer` 自动把内容当用户消息注入。所以 QQ 退出宿主 plan 完全可走 `/plan off`，不依赖 Web
- **修法（收敛到宿主语义）**：
  - `bridge.ts`：删除 `chatPlanModes` map 与 `prefixTurn` 的【计划模式】前缀注入；`handlePlanCommand` 改为**转发** `ctx.commands.execute(chat.agent, '/plan [off|内容]')` 并把宿主返回文本（Plan mode on/off…）中继到 QQ（off 时附提示）；`BridgeDeps` 增可选 `commands`
  - `index.ts`：inject 增加 `commands`；Context 类型化；deps 传入 `ctx.commands`
  - `prompt.ts`：仍禁 `ask_user_question` 与 `exit_plan_mode`（审批卡仅 Web）；新增「处于宿主计划模式时输出纯文本计划并提示 /plan off 退出」→ **不会**重引入「Web 计划书手机 QQ 无法审批」问题
  - 测试改写：/plan 断言改为「转发到 commands.execute(路径/内容)+中继宿主文本」；prompt 断言 /plan off 引导；删除 chatPlanModes 断言
- **并发合流**：期间另一次会话把 safe_edit 拆为独立插件 dsh-safe-edit（§3.21，用户拍板），onebot 移除 code_* 注册与源码；本改动在其上叠加（commands 注入与拆分移除共存），onebot 内 safe-edit 死拷贝已清理，118/118 仍绿
- **验证**：tsc 0；vitest 118/118；待上线：kill 由 launchd 拉起 → QQ 实测 /plan 进宿主模式→文本计划→/plan off 直退→继续执行（全程无 Web 审批卡）
- **上线与修复（§3.25 补记）**：上线后 /plan 调用报 `Cannot read properties of undefined (reading 'aborted')`（宿主 execute 无条件读 signal.aborted）→ 8/19 补传必填 signal 修复（3a42743）；此后无相关报错记录

### 3.23 实时中间消息 + 各自的 90s 单独撤回 + 回合末整轮 t2i 小结卡（2026-08-18，已实现待上线）
- **症状（用户报 + 截图确认）**：推送回复那轮「少撤回文本 + 合并转发里有重复内容」。根因：回合 29 从首个中间消息到 turn/end 耗时 **280s**，最早中间消息已 4.7 分钟；QQ 撤回时限约 2 分钟 → NapCat `recallMsg retcode 1200 Timeout`，日志大量 `loop recall delete_msg failed`；回合末合并转发把 4 条已撤不回的原文收进卡里 → 原文残留 + 卡片重复（截图：4 条原文 +「群聊的聊天记录」卡 4 个同名节点 + 仅 2 条「对方撤回了一条消息」）
- **需求（用户拍板 4 点）**：① 中间消息实时可见；② 每条到 90 秒单独撤回（各自独立定时器）；③ 回合结束先把**整轮所有中间消息**渲染一张 t2i 小结卡、再发 final（final 保持现状阈值：>150 转图、短文文本）；④ 发小结卡时残留原文**立即撤回**（无重叠）
- **实现**（src/bridge.ts + index.ts）：弃用回合末合并转发（sendLoopForward 删除）；`loopBuffer` 条目加 `sentAt`；新增 `ChatAgent.recallTimers: Map<id,timer>` 与 `recalledInterimIds: Set<id>`；`sendInterim` 记 sentAt + 每条设 `interimRecallMs`（默认 90_000，新配置项，可调）定时器 → `revokeInterim` 单独撤回并标记；`settleLoop` 改为：排空队列 → `sendInterimSummary`（renderTextImage 出「📋 本轮中间记录」图卡，超 maxImageBytes 回退文本）→ `recallLoopMessages`（跳过已被 90s 撤过的，clearTimeout 残留定时器，delete_msg 间 60ms 间隔）→ 发送 final；`clearInterimTimers` 在 stop()/resetChat 清理
- **验证**：tsc 0；vitest 119/119（重写合并测试为「小结图卡→立即撤回→final」、去重测试断言无 send_private_forward_msg、新增「40ms interimRecallMs 回合中自动单独撤回」用例）；测试注意：echo 必须给增序 message_id，否则两条 interim 同 id 被「已撤回」集合误跳过
- **上线状态（§3.25 补记）**：随 8/18~8/19 构建与 8/26 重启在线上；小结卡为 t2i 图片、撤回为插件侧动作，会话文本日志无直接痕迹；全量日志核查无 recall 超时/error 残留
- **待上线**：构建 → kill 由 launchd 拉起 → 真机：长回合看中间消息实时出现、90s 后各自消失、回合末出整轮小结卡 + final

### 3.24 平台说明下沉到 agent 自身作用域 + 三条校准（2026-08-26，已上线）
- **背景**：QQ 平台说明与 qq_* 工具原本注册在插件上下文（index.ts），平台规则对 Web 会话也可见；提示词残留两条失效指引——`view_image`（全仓无此工具）与 `code_safe_edit`（§3.21 已从 onebot 移除、dsh-safe-edit 未安装），会让模型调用不存在的工具
- **改动**：
  - `bridge.ts` 新增 `installChannelScope(agentCtx)`：平台说明（`systemPrompt.section` channel:dsh-onebot）与 qq_* 工具注册到**每个 agent 自身作用域**——`agents.create` 新建、`agents.resume` 恢复两处 setup 都执行，Web/local 会话不可见；`session/event`、`session/flush` 监听器改存 dispose 句柄并在 stop() 释放，防 HMR/重载重复累积
  - `prompt.ts` 三条校准：① 删 `view_image` 幻影指令——入站实际标注为 `[图片]`/`[语音]`/`[视频]` 占位（路径不进文本，cq.ts appendImage 核实），无可用看图工具时如实告知用户；② `code_safe_edit` 指引改为内置 read/edit（行级 hash 锚点 + dsh-better-edit 自动 undo，禁 write 整文件覆盖）——原指引与全局 AGENTS.md 惯例相反且工具不存在；③ 斜杠命令示例补全为 14 个（仅管理员，`/help` 查看说明），非管理员 `/` 命令被消费并提示「仅管理员可用」
- **验证**：tsc 0 错；vitest 全绿；lib 重建；真机重启（`launchctl kickstart -k gui/501/ai.dsh.web`）后生效；逐条对照代码核实：tools.ts 工具清单（无 view_image）、cq.ts 标注格式、chat.ts 群前缀、tryHandleCommand 命令表；测试同步：bridge.spec 假 agentCtx 补 systemPrompt/tools 桩并断言通道工具注册到 agent 作用域、plugin.spec 改为断言插件作用域不再注册通道面

### 3.25 补记：/plan signal 修复 + 架构图文档 + 待上线项状态收口（2026-08-19 / 2026-09-01）
- **/plan 转发真机 bug（2026-08-19，已修复）**：§3.22 转发上线后 /plan 调用报 `Cannot read properties of undefined (reading 'aborted')`。根因：宿主 `commands.execute` 实现**无条件**读 `signal.aborted`（signal 实为必填契约），§3.22 转发时未传（类型声明为可选，掩盖了该契约）。修复：`handlePlanCommand` 调用处补传 `new AbortController().signal`（QQ 用户发起的 /plan 不受本插件取消逻辑中断）；`BridgeDeps`/`Context` 的 commands.execute 签名 signal 改必填并补 `result` 字段类型；测试同步（转发用例断言补 signal）。验证：tsc 0；vitest 全绿；构建入库（3a42743）
- **架构图文档三连（2026-09-01，纯文档）**：88ad77c（Archify SVG 自包含化嵌入 README「## 架构」+ 交互式 HTML）→ 9cf1931（SVG 在 GitHub 管线不渲染 → 2x PNG 嵌入，SVG 补 xmlns 保留矢量版）→ 4a86a1a（README.en 英文版 EN SVG 全文翻译 + 重算标签遮罩 + EN PNG）。无代码改动
- **待上线项状态收口**：§3.18 斜杠命令、§3.22 /plan 转发、§3.23 小结卡均随 8/18~8/19 构建与 8/26 重启在线上（§3.24 上线时 lib 即含全部）；对全部 onebot-private-* 会话日志解压核查：无 aborted 报错、无 recall delete_msg failed、无 turn/end error 残留；小结卡为 t2i 图片（文本不进会话日志）、撤回为插件侧动作，日志无直接痕迹，实测细节未单独记录
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
- [x] loop 中间消息**实时发送 + 90s 独立撤回 + 回合末整轮 t2i 小结卡**（带 tool-call 的中间文本立即发送、无工具调用延迟一步判定；每条按 interimRecallMs（默认 90s）独立定时撤回；回合末先渲染「📋 本轮中间记录」小结卡 → 撤回残留原文 → 再发 final；结算前排空发送队列不漏最后一条；2026-08-18 §3.23，弃用旧「回合末合并转发」）
- [x] 图片（路径/URL，≤9 张）、语音、视频、文件工具；正在输入提示（私聊）
- [x] qq_napcat_api 白名单代理（14 个 action）、qq_group_history
- [x] ~~受守卫文件编辑 code_safe_edit/rollback/list_backups~~（**2026-08-18 已拆至独立插件 dsh-safe-edit**，随会话 sandbox 策略动态边界，跨通道全局；见 §3.21）

### t2i 渲染（2026-08-14 移植，对照 T2I_DEV_DOC）
- [x] AstrBot 元素化两遍流程（先算高再绘制）；800px/26px/右缘 790
- [x] 标题/粗体双画/斜体变换/删除线/引用/无序有序列表/代码块/表格（表头灰底/网格线/交替行/列宽拉伸/居中）/行内 code 胶囊
- [x] 彩色 emoji（Apple Color Emoji）、中文标点禁则、行内样式整体换行、字面 \n 转换
- [x] 顶栏 To 昵称（#2196F3）+ 页脚 Powered by dsh（#002FA7）
- [x] 像素级右缘验证 ≤790（压力内容全图扫描 0 违规）

### 运维
- [x] 会话映射持久化 + 重启 resume（含引导期模型选择等待）
- [x] 热加载：改 patch 文件/touch 即生效（无需重启 dsh）
- [x] 测试：149 vitest（单元 + 真实 WS 对端 + 全管线 + t2i 像素扫描 + 预设/工作区回归 + loop 合并/斜杠命令回归 + 图片压缩 + 废弃会话 id 持久化/重启回归 + preset 记录/恢复回归；safe-edit 测试已随拆分迁移至 dsh-safe-edit）

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
./node_modules/.bin/vitest run       # 149 个测试

# 线上状态
netstat -an | grep <port>             # NapCat 反向 WS 连接（ESTABLISHED）
zstd -dc ~/.dsh/sessions/*/onebot-private-*/session.jsonl.zstd   # 会话日志

# NapCat（NAS 管理面板）
网络配置 → ws-reverse → ws://<dsh 机器 IP>:<port>/ws，token 与插件 accessToken 一致
docker restart 会丢登录态（需重新扫码/QCE 登录）
```

---

*本日志由移植过程会话记录整理，随迭代持续更新。*
