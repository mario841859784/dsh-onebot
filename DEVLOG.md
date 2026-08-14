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
- **连接**：反向 WS（默认 18643，本机 8643 预留给 Hermes），NapCat ws-reverse 拨入
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
| 上午 | NapCat 拨入成功（18643 ESTABLISHED）；真实 QQ 链路验证：hello → 模型回复 → turn completed；重启记忆验证（暗号柚子跨重启保留） |
| 上午 | **t2i 里程碑**：按 T2I_DEV_DOC 整理方案获批；canvas 实验（系统字体家族/emoji 彩色/ttc/逐字形回退）；六模块落地（fonts/canvas/measure/parser/elements/index） |
| 上午 | t2i 修三处：fontkit ESM 入口是浏览器构建（改 createRequire 惰性加载）、表格数据结构维度、嵌套 required 不被参数 DSL 支持 |
| 上午 | **emoji 代理对 bug**：JS 字符串索引按 UTF-16 码元拆开 emoji → 高代理位被分类成 CJK 渲染成黑字形（像素扫描发现）→ 全链路改按码点迭代 |
| 上午 | t2i 集成：textImageThreshold=150 卡片路径 + 渲染失败回退分段；76/76 全过；像素右缘扫描 ≤790；view_image 视觉校准通过 |
| 上午 | t2i 确定性 E2E：长消息 → 出站 types=[image] fileLens=[193629]（单图片段 193KB 卡片） |
| 上午 | **split 分段修复**：需要我做什/么直接说 中间截断 → 对齐原版 _split_reply（窗口内向后找标点、标点集去掉 .:;、空格回退、代理对保护）79/79 全过，热加载上线 |
| 下午 | 本日志 |

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
  - patch 已配 `agentPreset: standard` + `workspacePath: /home/user/workspace`
- **验证**：80 vitest 全绿（新增回归测试：joinPreset 收到 standard + create/attachSession 按 cwd 调用）；tsc 构建通过。**生效需重启 dsh web**（宿主侧插件无 HMR）
- **注意**：restart 后 loadMapping resume 的旧会话（header cwd=~/.hermes/workspace）也会被挂到对应工作区（不存在则自动创建）

---
## 4. 功能清单（当前状态）

### 入站
- [x] 私聊/群聊（群需 @/回复触发，requireMention 默认 true；白名单授权）
- [x] 段数组优先解析（CQ 字符串回退）、CQ 反转义
- [x] 图片 url/base64/file/hash 四路获取；语音 ffmpeg→whisper 转写（失败降级 [语音]）
- [x] 引用消息自动取原文（get_msg）；合并转发自动展开（get_forward_msg）
- [x] 表情 id→emoji、@、回复、卡片、戳一戳段类型；群聊 [HH:MM 昵称(QQ)] 前缀注入

### 出站
- [x] 长消息策略：≤100 单条 / 100–150 标点分段 / >150 t2i 文字图卡片（渲染失败回退分段）
- [x] Markdown 剥离为 QQ 纯文本；[[qq_forward]] 合并转发（群/私聊）
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
- [x] 测试：80 vitest（单元 + 真实 WS 对端 + 全管线 + t2i 像素扫描 + 预设/工作区回归）

---

## 5. 已知限制 / 待办

1. **断线瞬间的回复丢失**：无连接时 sendMsg 失败仅记日志（与 Hermes 一致）；待增强：断线重连后补发
2. **ZWJ 组合 emoji / 区域指示符**：按码点拆分绘制（原版一致限制）
3. **t2i 链接/图片语法原样当文本**、无多级列表/任务列表/嵌套引用/合并单元格（原版一致限制）
4. **Linux 部署**：需安装 Noto CJK（ttc 默认面可能是 JP，fontkit 提取 SC 面代码已就位但未在 Linux 实测）；emoji 需注册 NotoColorEmoji
5. 入站图片压缩（≤2048px）、loop 中间消息合并转发+撤回、用户档案（Hermes 版有，未移植）
6. 卡片最大高度未限制（超长 markdown 可能生成超高图）

---

## 6. 快速备忘（运维）

```bash
# 插件目录 / 挂载点
~/dsh-plugins/dsh-onebot/            # 源码 + lib（构建产物入库）
~/.dsh/profiles/web/cordis.patch.yml # 挂载配置（改/touch 即热加载）

# 构建与测试
cd ~/dsh-plugins/dsh-onebot && npm install --include=dev && ./scripts/build.sh
./node_modules/.bin/vitest run       # 79 个测试

# 线上状态
netstat -an | grep 18643             # NapCat 反向 WS 连接（ESTABLISHED）
zstd -dc ~/.dsh/sessions/--Users-mario-.hermes-workspace--/onebot-private-*/session.jsonl.zstd   # 会话日志

# NapCat（NAS 192.168.1.100:6098/webui）
网络配置 → ws-reverse → ws://192.168.1.100:18643/ws，token 与插件 accessToken 一致
docker restart 会丢登录态（需重新扫码/QCE 登录）
```

---

*本日志由移植过程会话记录整理，随迭代持续更新。*
