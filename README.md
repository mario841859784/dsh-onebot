# dsh-onebot

给 DeepSeek Harness 加上 QQ 通道。A QQ channel for dsh.

本插件把 dsh 变成一个 QQ 机器人（**OneBot 11 协议**，兼容 NapCat / Lagrange / LLOneBot / go-cqhttp），
与 [dsh-vision](https://github.com/dsh-external/dsh-vision) 同款的外部插件形态：**零 Python、纯 TS、
原生 Cordis 插件**，挂载进 dsh 宿主进程，不改任何核心代码。

```
用户(QQ) ←→ NapCat ←→ dsh-onebot 插件 ←→ dsh Agent（每个会话一个）
                        ├─ 反向 WS 服务器 / 正向 WS 客户端（自动重连）
                        ├─ 入站：CQ 解析、图片下载、语音转写(STT)、引用/合并转发展开
                        └─ 出站：分段发送、Markdown 剥离、[[qq_forward]]、图片/语音/视频/文件工具
```

## 功能

| 类别 | 能力 |
|---|---|
| 连接 | 反向 WS（NapCat ws-reverse 拨入，默认端口 8643）或正向 WS（拨出，默认 ws://127.0.0.1:3001）；断线自动重连（2s→60s 退避） |
| 入站 | 私聊/群聊、段数组优先解析（CQ 字符串回退）、CQ 反转义、@/回复触发检测（fail-closed）、图片四路解析（url/base64/file/hash）、引用消息自动取原文（get_msg）、合并转发自动展开（get_forward_msg） |
| 语音 | ffmpeg 转 16kHz WAV + whisper 转写（openai-whisper / whisper.cpp / 自定义命令），失败降级 [语音] 占位 |
| 出站 | 长消息按句号分段（默认 ≤100 字/条）、Markdown 剥离为 QQ 纯文本、[[qq_forward]] 合并转发（群/私聊）、正在输入提示（set_input_status，仅私聊） |
| 工具 | `qq_send_image`（≤9 张，路径或 URL）、`qq_send_voice`、`qq_send_video`、`qq_send_file`、`qq_send_forward`、`qq_napcat_api`（14 个白名单 action）、`qq_group_history` |
| 权限 | 管理员白名单（`ONEBOT_ALLOWED_USERS`）、dm/group 策略（open/allowlist/disabled）、群聊 @提及 gating、受限用户 [受限用户:仅问答] 软限制、出站敏感内容审计 |
| 会话 | 每个 QQ 会话一个持久 Agent（session id 稳定派生），重启后自动 resume；每轮结束 flush 落盘 |
| 提示词 | 自动注入 QQ 平台说明（纯文本输出、图片走 view_image、工具指引） |

## 安装

**前置**：dsh（≥0.1.0-rc.6）在 PATH 上；NapCat 或其他 OneBot 11 实现已运行。

```sh
git clone <repo> ~/dsh-plugins/dsh-onebot
cd ~/dsh-plugins/dsh-onebot
npm install --include=dev
./scripts/build.sh          # 链接宿主 @deepseek-ai 包 + tsc 编译 src/ → lib/
```

挂载到 ~/.dsh/config.yaml（没有就新建）：

```yaml
- insert:
    - id: dsh-onebot
      name: '$HOME/dsh-plugins/dsh-onebot/lib/index.js'
      config:
        mode: reverse        # reverse = NapCat 拨入；forward = 插件拨出
        port: 8643
        # accessToken: ''    # 与 NapCat 配置一致
        # botQQ: ''          # 留空自动从 meta 事件学习
```

重启 dsh（`dsh web` 或你的启动方式），日志出现 `[dsh-onebot] mounted` 即挂载成功。

**NapCat 侧（reverse 模式）**：配置一个 ws-reverse 通道，URL 指向 dsh 所在机器
（如 `ws://192.168.1.100:8643/ws`），token 与上面一致。

## 配置

完整配置项见 [src/index.ts](src/index.ts) 的 `Config` schema（schemastery 校验，均有默认值）。常用：

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `reverse` | `reverse`/`forward` |
| `host` / `port` | `0.0.0.0` / `8643` | reverse 监听 |
| `url` | `ws://127.0.0.1:3001` | forward 目标 |
| `accessToken` | 空 | OneBot token |
| `botQQ` | 空 | 机器人 QQ（空=自动学习） |
| `requireMention` | `true` | 群聊需 @ 或回复才响应 |
| `dmPolicy` | `open` | `open`(仅管理员)/`allowlist`/`disabled` |
| `groupPolicy` | `open` | `open`/`allowlist`/`disabled` |
| `adminUsers` | `[]` | 管理员 QQ；也可用 `ONEBOT_ALLOWED_USERS` 环境变量 |
| `allowFrom` / `groupAllowFrom` | `[]` | 白名单用户/群 |
| `interimMessages` | `true` | 工具调用之间的中间文本是否立即发送；`false` 只发最终回复 |
| `splitLength` | `100` | 长回复分段长度 |
| `sttEnabled` | `true` | 语音转写（需 ffmpeg + whisper CLI） |
| `sttModel` | `small` | whisper 模型 |
| `mediaDir` | `<dsh-home>/media/onebot` | 入站媒体/映射文件目录 |

环境变量：`ONEBOT_ALLOWED_USERS`（逗号分隔管理员）、`ONEBOT_ALLOW_ALL_USERS=true`（开发用）。

## 给模型的平台说明（自动注入）

- QQ 不渲染 Markdown → 输出纯文本（编号/短横线列表、行内反引号）。
- 发图/文件/语音/视频用 `qq_send_*` 工具；合并转发用 `qq_send_forward`。
- 用户发来的图片会标注本地路径，用 `view_image`（dsh-vision）查看。
- 群聊消息带 `[HH:MM 昵称(QQ)]` 前缀；受限用户消息带 `[受限用户:仅问答]` 前缀（仅回答，禁止文件/终端/配置操作）。

## 开发

```sh
./scripts/build.sh                 # 编译 src/ → lib/
./node_modules/.bin/vitest run     # 42 个测试：单元 + 真实 WS 对端 + 全管线
```

要点（来自移植源 DEVLOG 的教训）：

- **CQ 反转义**：NapCat 会把 URL 里的 `&` 转成 `&amp;`，下载前必须反转义（CDN 403 的根因）。
- **@ 检测 fail-closed**：不知道机器人 QQ 时，群消息一律视为未 @，不自动回复。
- **断线即失败 pending**：WS 断开时立即 reject 所有未完成 action，避免 10-30s 干等与泄漏。
- **重连去重**：并发断线只允许一个重连任务，防止双 WS 连接。
- **int(target) 兜底**：chat_id 解析进 try/catch，坏目标不能炸掉宿主。
- **临时媒体 6h 过期清理**：只写不删会无限堆积。

## 路线图（v2 候选）

- t2i 文字图渲染器（@napi-rs/canvas 移植 Hermes 的 AstrBot 风格卡片：表格/彩色 emoji/中文禁则）
- 入站图片压缩（≤2048px，避免大图拖慢视觉模型）
- loop 中间消息合并转发 + 撤回
- 用户档案（群消息 JSONL 记录 + HTTP 查询端点）

## License

BSD-3-Clause

