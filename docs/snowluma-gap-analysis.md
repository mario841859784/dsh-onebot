# dsh-onebot × SnowLuma 协议兼容性差距分析

- 日期：2026-11-04
- 对象：SnowLuma v2.4.0（github.com/SnowLuma/SnowLuma，OneBot v11 协议端，TypeScript，源码可见非商业许可）
- 本体：dsh-onebot 插件（当前针对 NapCat 的 OneBot v11 实现）
- 性质：只读研究，未改动任何代码。

## 信息来源

| 来源 | URL |
| --- | --- |
| 项目 README | https://github.com/SnowLuma/SnowLuma |
| API 参考（动作总目录、调用方式、信封） | https://snowluma.github.io/zh/docs/api |
| 对接机器人（正向/反向 WS、鉴权、多账号） | https://snowluma.github.io/zh/docs/guide/connect-bot |
| 配置参考（networks 适配器、messageFormat、reportSelfMessage） | https://snowluma.github.io/zh/docs/guide/configuration |
| SDK 文档（连接、鉴权、事件订阅） | https://snowluma.github.io/zh/docs/sdk |
| 各动作页 | `https://snowluma.github.io/zh/docs/api/{category}/{action}`（下表逐条引用） |

> 注：`raw.githubusercontent.com` 在研究环境不可达，动作页参数/响应结构均取自文档站渲染页（由 OpenAPI 生成）。SnowLuma 源码未逐行审读，凡文档未写明处均标注"需实测"。

---

## 1. 总览结论

**SnowLuma 可以接入，无需架构级改动；预估为中小规模适配。**

- 插件的全部核心链路所依赖的动作（收发消息、撤回、引用展开、图片/语音获取、群历史、群文件浏览/上传、OCR、AI 语音、typing）在 SnowLuma 中**全部存在**，其中一部分在 `extended`（NapCat 兼容扩展）分类下，命名与 NapCat 一致。
- 主要差距集中在四类：
  1. **反向 WS 鉴权形式**：插件 reverse 服务端只认 `Authorization: Bearer` 头，SnowLuma 生态（含官方 SDK 客户端）倾向 `?access_token=` query；
  2. **get_file 语义收窄**：SnowLuma 的 `get_file` 仅覆盖图片/语音缓存（响应也无 `base64` 字段），聊天文件必须走 `get_private_file_url` / `get_group_file_url`；
  3. **get_group_msg_history 锚点参数名**：SnowLuma 用 `message_id` 作锚点，插件传的是 `message_seq`；
  4. **合并转发发送（send_forward_msg 系列）请求体未文档化**，插件构造的 NapCat 风格 node（`{uin,name,content}`）是否被接受需实测。
- 事件面（message/meta）兼容；插件本来就忽略 notice/request 事件，SnowLuma 新增的 `bot_status` notice 不会造成破坏。
- 传输面：forward 模式（插件作 WS 客户端连 SnowLuma `ws://127.0.0.1:3001/`）与 SnowLuma 默认配置**零改动即匹配**（默认端口 3001、路径 `/`、Bearer 头鉴权均一致）。

---

## 2. 连接与鉴权

### 2.1 SnowLuma 侧提供的能力（文档依据）

- 适配器分四类，配置在 `config/onebot.json` / `onebot_<uin>.json` 的 `networks` 下：`httpServers`（默认 `0.0.0.0:3000`）、`wsServers`（默认 `0.0.0.0:3001`，path `/`，role `Universal|Api|Event`）、`wsClients`（SnowLuma 主动拨出反向 WS）、`httpClients`（事件 HTTP 上报）。见 [配置参考](https://snowluma.github.io/zh/docs/guide/configuration)。
- 通用字段：`accessToken`（鉴权令牌，自动生成）；`messageFormat`（`array`|`string`，决定事件 `message` 字段形态，默认 `array`）；`reportSelfMessage`（`true` 时推送 `post_type='message_sent'` 自身消息，默认 `false`）。同上。
- 鉴权："**`Authorization: Bearer <token>` 或 `?access_token=`**"（[对接机器人](https://snowluma.github.io/zh/docs/guide/connect-bot)、[API 参考](https://snowluma.github.io/zh/docs/api)）。HTTP 与 WS 可各配各的 token。
- 多账号：每 UIN 一份 `onebot_<uin>.json`，默认都占 3000/3001，第二账号需改端口。

### 2.2 与插件两种模式的对照

| 项目 | 插件实现 | SnowLuma | 结论 |
| --- | --- | --- | --- |
| forward（插件作 WS 客户端连 SnowLuma） | `headers.Authorization='Bearer '+token`（connection.ts:429），默认连 `ws://127.0.0.1:3001`（index.ts url 默认值） | `wsServers` 接受 Bearer 头或 `?access_token=`，默认 `0.0.0.0:3001`、path `/` | **兼容，零改动**。建议在配置参考中把 SnowLuma wsServers 的 accessToken 与插件 accessToken 对齐 |
| reverse（SnowLuma 拨入插件 WS 服务端） | 服务端**只校验 `Authorization: Bearer` 头**（connection.ts:330-332，timingSafeEqual），不认 `?access_token=` query；要求 accessToken 非空（connection.ts:313-315） | `wsClients` 仅配置 url/role/reconnectIntervalMs；**SnowLuma 拨出时用什么形式携带 token，文档未明确**。旁证：官方 SDK 的 WebSocket 客户端是"通过查询参数附加到连接 URL"（[SDK 文档](https://snowluma.github.io/zh/docs/sdk)），同生态实现大概率用 query 参数 | **风险点：插件 reverse 服务端需增加 `?access_token=` 校验**（改动小）。实际头部形式需用真实 SnowLuma 实例实测 |
| WS 层保活 | 插件自管 WS ping/pong（30s ping，60s 无 pong 断开，connection.ts:572-578），不依赖 OneBot meta heartbeat | 文档未提 SnowLuma 是否响应协议层 ping；未提及是否周期发 heartbeat meta_event | 标准库通常自动 pong，**低风险，需实测**。插件不依赖 heartbeat，故 SnowLuma 不发 heartbeat 也无碍 |
| HTTP API / HTTP 上报 | 插件未使用 | SnowLuma 提供 `httpServers`/`httpClients` | 无需改动（可作为未来低配接入路径） |
| 事件 messageFormat | 插件优先读段数组 `Array(message)`，缺省回退 CQ 字符串解析（inbound.ts:100-105、cq.ts:206） | 默认 `array`，可选 `string` | 兼容。保持默认 `array` 即可 |
| reportSelfMessage | 插件 ignoreSelf 逻辑按 user_id==selfId 过滤（inbound.ts:241） | 默认 false，不推自身消息 | 无影响 |
| 多账号 | 插件单连接、单 botQQ（index.ts botQQ 配置 + 事件 self_id 学习，connection.ts:644-645） | 每 UIN 独立实例/端口 | 兼容：一实例一账号。多账号需多份插件连接配置（现有 v1 范围外） |

---

## 3. 动作对照表

SnowLuma 动作清单来自 [API 参考](https://snowluma.github.io/zh/docs/api)（标准分类）与 `extended` 分类（NapCat 兼容扩展，共 115 个）。信封统一为 `{status,retcode,data,message,wording}`，`retcode===0` 才算成功——与插件 connection.call 的判定一致（connection.ts，status==='ok' 取 data）。

### 3.1 核心链路动作

| 动作 | SnowLuma 支持 | 文档依据 | 插件调用点 | 差异 / 结论 |
| --- | --- | --- | --- | --- |
| `send_msg` | ✅ 标准（message 分类），自动按 message_type/群号路由 | [message/send_msg](https://snowluma.github.io/zh/docs/api/message/send_msg) | outbound.ts:420 | 参数 `{message_type?, group_id?, user_id?, message, auto_escape?}`；`message` 接受 string/段数组/object。注意：**text 段 `text` 字段恰好为 `""` 被视为兼容占位、不计可发送段；纯空白文本仍走正常校验**（send_msg 页参数说明）→ 空白文本段可能被拒，见 §5.3 |
| `delete_msg` | ✅ 标准 | [message/delete_msg](https://snowluma.github.io/zh/docs/api/message/delete_msg) | interim.ts:245,257 | `{message_id}` → `data:null`。兼容；NapCat recallMsg 慢的 60ms 限速（interim.ts:27-29）对 SnowLuma 无害，可保留 |
| `get_msg` | ✅ 标准 | [message/get_msg](https://snowluma.github.io/zh/docs/api/message/get_msg) | inbound.ts:277,559 | 返回消息事件对象（去 post_type/self_id，附 real_id），含 message 段数组 + raw_message。**SnowLuma 会逐个刷新图片/语音/视频 URL，失败保留原地址**——对插件引用展开有利。兼容 |
| `get_image` | ✅ extended | [extended/get_image](https://snowluma.github.io/zh/docs/api/extended/get_image) | inbound.ts:490 | 参数 `file?`/`file_id?`；返回 `{file,url,file_size,file_name}`。插件取 `url` 下载或 `file` 路径，兼容 |
| `get_record` | ✅ extended | [extended/get_record](https://snowluma.github.io/zh/docs/api/extended/get_record) | inbound.ts:494 | 参数 `file?/file_id?/out_format?`，out_format 枚举含 `mp3`。传 out_format 时**响应附带 `base64`（服务端转码）**，返回 `{file,url,file_size,file_name,out_format,base64}`。插件目前只取 `file` 再走 media.resolve——建议改为优先取 `base64`（小改动），见 §6 |
| `get_file` | ✅ extended，**语义收窄** | [extended/get_file](https://snowluma.github.io/zh/docs/api/extended/get_file) | inbound.ts:611 | 文档明示"**仅图片/语音缓存；群文件请用 get_group_file_url**"；参数 `file_id?/file?`；返回 `{file,url,file_size,file_name}`，**响应 schema 无 `base64` 字段**。插件聊天文件回退分支（期望 base64/http url）大概率失效 → 群聊文件必须补 `get_group_file_url` 分支，见 §6 |
| `get_forward_msg` | ✅ extended | [extended/get_forward_msg](https://snowluma.github.io/zh/docs/api/extended/get_forward_msg) | inbound.ts:678 | 参数 `id?` 或 `message_id?`（均为 string）——与插件双参数兼容。返回 `data.messages[]`，每项为**完整 OneBot 消息事件**（含 sender/message/raw_message，非 NapCat 的 node.data 包裹）——插件 expandForward 的多形态取值链（inbound.ts:671-712：node.sender?.nickname、node.message 等）恰好覆盖此结构，兼容 |
| `send_forward_msg` | ⚠️ extended，**请求体未文档化** | [extended/send_forward_msg](https://snowluma.github.io/zh/docs/api/extended/send_forward_msg) | outbound.ts:456 | 文档页响应为 `{message_id,res_id,forward_id}`，请求示例为空 `{}`，**未列出 messages 参数结构**。插件发送 `{group_id, messages:[{type:'node',data:{uin,name,content}}]}`（NapCat 风格）。get_forward_msg 页提到节点 content "可作为转发节点 content 再次发送"，暗示存在 node 发送路径，但字段名（uin/name vs user_id/nickname）未知 → **需实测**，可能要改节点字段或改用 `upload_forward_msg`（extended 亦有） |
| `send_private_forward_msg` | ⚠️ 同上 | [extended/send_private_forward_msg](https://snowluma.github.io/zh/docs/api/extended/send_private_forward_msg) | outbound.ts:458 | 同上，参数 `{user_id,…}` |
| `send_group_forward_msg` | ⚠️ 同上（插件当前未用，白名单外） | [extended/send_group_forward_msg](https://snowluma.github.io/zh/docs/api/extended/send_group_forward_msg) | — | 备选路由 |
| `get_group_msg_history` | ✅ extended | [extended/get_group_msg_history](https://snowluma.github.io/zh/docs/api/extended/get_group_msg_history) | tools.ts:393 | 参数：`group_id*`、**`message_id?`（锚点，默认 0）**、`count?`（默认 20）、`reverse_order?`（仅 message_id≠0 时生效）。**插件传 `message_seq` 作锚点（NapCat 字段名）→ SnowLuma 不识别，翻页锚点失效（只能取最新一页）** → 需改参数名，见 §6 |
| `ocr_image` | ⚠️ extended，**输入受限** | [extended/ocr_image](https://snowluma.github.io/zh/docs/api/extended/ocr_image) | commands.ts:788 | 参数 `image*`（string，长度≥1）；文档描述"**需图片 URL 或已缓存的图片 file_id**"。插件传 `base64://...` 是否被接受**文档未明确，需实测**。不兼容时的替代：先 `get_image` 换 URL，或改传 file_id。返回 `{texts:[{text,confidence,coordinates}],language}`，与插件取 `data.texts[].text` 兼容 |

### 3.2 白名单动作（tools.ts:21-37 NAPCAT_API_WHITELIST）

| 动作 | SnowLuma | 文档依据 | 结论 |
| --- | --- | --- | --- |
| `get_group_member_list` | ✅ 标准 group-info | [group-info/get_group_member_list](https://snowluma.github.io/zh/docs/api/group-info/get_group_member_list) | 返回含 nickname/card/role/level/last_sent_time 等，兼容 |
| `get_group_member_info` | ✅ 标准 group-info | [group-info/get_group_member_info](https://snowluma.github.io/zh/docs/api/group-info/get_group_member_info)（未逐字段核对，同分类 schema 风格一致） | 兼容（no_cache 参数文档未明确，需实测） |
| `get_stranger_info` | ✅ 标准 friend | [friend/get_stranger_info](https://snowluma.github.io/zh/docs/api/friend/get_stranger_info) | 返回 nickname 等；字段比 NapCat 更丰富，插件取 nickname 兼容 |
| `upload_group_file` | ✅ 标准 group-file | [group-file/upload_group_file](https://snowluma.github.io/zh/docs/api/group-file/upload_group_file) | 参数 `{group_id,file,…}`，响应 `{file_id}`；`file` 是否接受 `base64://` 文档未明确（示例为字符串），需实测 |
| `upload_private_file` | ✅ 标准 group-file | [group-file/upload_private_file](https://snowluma.github.io/zh/docs/api/group-file/upload_private_file) | 同上 |
| `get_group_root_files` | ✅ 标准 group-file | [group-file/get_group_root_files](https://snowluma.github.io/zh/docs/api/group-file/get_group_root_files) | 返回 `{files[],folders[]}` 结构与 NapCat 一致 |
| `get_group_files_by_folder` | ✅ 标准 group-file | [group-file/get_group_files_by_folder](https://snowluma.github.io/zh/docs/api/group-file/get_group_files_by_folder) | 同上 |
| `get_group_file_url` | ✅ 标准 group-file | [group-file/get_group_file_url](https://snowluma.github.io/zh/docs/api/group-file/get_group_file_url) | `{group_id,file_id}` → `{url}`。**插件当前未在入站文件链路使用它（只用于白名单透传），SnowLuma 下应把它补入群文件获取主路径** |
| `get_private_file_url` | ✅ 标准 group-file | [group-file/get_private_file_url](https://snowluma.github.io/zh/docs/api/group-file/get_private_file_url) | `{file_id}` → `{url}`，与插件入站文件主路径（inbound.ts:593）吻合 |
| `ocr_image` / `get_forward_msg` / `get_record` / `get_file` | ✅/⚠️ extended | 见 §3.1 | 白名单本身无需拆分（动作名全部存在） |
| `get_ai_characters` | ✅ extended | [extended/get_ai_characters](https://snowluma.github.io/zh/docs/api/extended/get_ai_characters) | `{group_id}` → 按分类分组的角色列表（character_id/character_name/preview_url） |
| `send_group_ai_record` | ✅ extended | [extended/send_group_ai_record](https://snowluma.github.io/zh/docs/api/extended/send_group_ai_record) | 参数 `{group_id*, character*, text*, chat_type?}` |

### 3.3 插件内部直接调用的其他动作

| 动作 | SnowLuma | 文档依据 | 插件调用点 | 结论 |
| --- | --- | --- | --- | --- |
| `set_input_status` | ✅ extended | [extended/set_input_status](https://snowluma.github.io/zh/docs/api/extended/set_input_status) | bridge.ts:1225,1242（typing，`{user_id,event_type}`） | 动作存在；文档示例仅示 user_id，`event_type` 参数名未在节选中列出，**需实测**。失败仅影响 typing 指示器，非致命 |

插件不调用 `get_login_info`/`get_status`/`get_version_info`/`can_send_*`（SnowLuma 均支持，见 [API 参考](https://snowluma.github.io/zh/docs/api) 信息分类），无影响。

---

## 4. 事件对照

| 事件 | 插件处理 | SnowLuma | 结论 |
| --- | --- | --- | --- |
| `post_type=message`（private/group） | normalizeOneBot11（inbound.ts:85-119）：段数组优先、CQ 回退、sender.card??nickname、message_id、reply/forward 提取 | OneBot v11 标准消息事件，`message` 形态由 messageFormat 决定（默认段数组），SDK 文档确认 onGroupMessage/onPrivateMessage 事件分发（[SDK](https://snowluma.github.io/zh/docs/sdk)） | **兼容**。事件带 self_id（消息事件对象含 self_id，get_msg 页结构佐证）→ 插件 selfId 学习（connection.ts:644-645）正常 |
| `post_type=meta_event`（heartbeat/lifecycle） | 仅学习 self_id 并打日志（connection.ts:655-661、index.ts:405-410），heartbeat 静默 | 文档**未明确**是否周期发 heartbeat meta_event | 无依赖（插件保活用 WS ping/pong），**无风险** |
| `post_type=notice` | **故意忽略（v1 设计）**，connection.ts:663 | SnowLuma 会推 `notice_type: bot_status`（sub_type online/offline，账号上下线）及常规 notice（[对接机器人](https://snowluma.github.io/zh/docs/guide/connect-bot)） | 不破坏现有功能。bot_status 可作为后续增强（掉线主动提示）；忽略即无影响 |
| `post_type=request`（好友/群申请） | 忽略（connection.ts:663） | SnowLuma 支持 set_friend_add_request / set_group_add_request（标准 request 分类） | 无影响（插件 v1 未实现申请处理） |
| `post_type=message_sent`（自身消息回显） | 不处理；ignoreSelf 按 user_id 过滤 | 默认 reportSelfMessage=false 不推送 | 无影响 |

**撤回/戳一戳等 notice 驱动功能**：插件 cq.ts:260-262 能把消息内 `poke` 段渲染为 [戳一戳]，但 QQ 的戳一戳实际以 notice 事件上报，插件本就不处理 notice——此为既有 v1 行为，与 SnowLuma 无关（SnowLuma extended 有 friend_poke/群拍一拍动作与对应 notice，插件侧未消费）。

---

## 5. 消息段与媒体

### 5.1 入站段解析（cq.ts:190-281）

插件处理的段类型：text / image / face / record / video / file / at / reply / forward / json / poke / contact / location / share / 未知类型兜底。SnowLuma 宣称支持"文本、图片、语音、视频、文件、回复、提及、转发及常见卡片"（[README](https://github.com/SnowLuma/SnowLuma)）+ json 段特殊规则（README：接受标准 `data.data` 字符串、兼容非数组对象与 `{type:"json",data:"..."}` 简写）。逐项结论：

- `image`（cq.ts:196-204）：依赖 `data.url` 或 `data.file`（base64:// / file:// / hash→get_image）。SnowLuma 事件中图片段带 url（get_msg 页"逐个尝试刷新图片、语音和视频 URL"佐证）→ 兼容。`sub_type==='1'` 表情包分支依赖 NapCat 字段，SnowLuma 是否同名**未明确，需实测**（失败时只是退回普通图片路径，无害）。
- `record`/`video`（cq.ts:218-225）：同上，url 优先 → 兼容。
- `file`（cq.ts:226-238）：插件假设 NapCat 字段（`file`=文件名、`file_id`=真实 id、`name` 常缺省）。SnowLuma file 段字段名**文档未明确，需实测**；若沿用 NapCat 风格（其 extended 分类整体对标 NapCat）则兼容。
- `forward`（cq.ts:250-255）：插件取 `data.id ?? data.resId`，SnowLuma 与 get_forward_msg 用 `id`/`message_id` → 兼容。
- `at`/`reply`/`face`/`text`/`json`：标准段，兼容。

### 5.2 入站媒体获取路径

| 媒体 | 插件路径 | SnowLuma 适配结论 |
| --- | --- | --- |
| 图片 | image.url → media.downloadUrl（SSRF fence）→ 魔数嗅探 + 压缩（media.ts） | 兼容。**注意**：若 SnowLuma 返回的 URL 指向其本机文件服务（私网地址），默认 `allowPrivateHosts=false` 会被 SSRF fence 拒绝 → 部署文档需注明可能要开 allowPrivateHosts（配置项已存在，index.ts） |
| 语音 | get_record{file,out_format:'mp3'} → {file} → media.resolve（url 下载 / file:// 拷贝 / base64:// 写盘） | 兼容但**建议改用响应中的 base64 字段**（SnowLuma 服务端已转码，省一次往返）；ffmpeg→whisper 转写链（stt.ts）不受协议端影响 |
| 视频 | url 下载 | 兼容 |
| 文件 | ① get_private_file_url{file_id} → url；② get_file{file} → base64/http url（inbound.ts:581-645） | ① 完全兼容（SnowLuma 标准 group-file 动作）；② **SnowLuma 的 get_file 仅覆盖图片/语音缓存且无 base64 字段** → 群聊文件第二分支失效。补救：群聊场景改走 `get_group_file_url{group_id,file_id}`（SnowLuma 标准），get_file 分支保留作私聊兜底 |

### 5.3 出站消息与媒体

- 出站段构造（outbound.ts:404-460、tools.ts）：text/image(base64:// 或 url)/record(base64://)/video/file(base64://+name)/reply/at/node。SnowLuma `send_msg` 的 message 接受段数组；**段内 data.file 是否接受 `base64://` URI scheme 文档未明确**（download_file 描述提及 base64 输入，发送段未逐条写明），需实测——若不支持，需走 SnowLuma 的 `download_file`（extended，url/base64 落盘 data/downloads）或 `upload_file_stream` 预上传后再引用本地路径。
- **空文本段校验差异**：SnowLuma send_msg 页明示 text 段 `text===""` 为兼容占位不计可发送段、纯空白文本仍参与校验 → `qq_send_segments`（tools.ts:295-337，允许空白段）与 split.ts 的切分结果中若出现纯空白/空段，可能被 SnowLuma 拒发。建议出站前过滤空/纯空白 text 段（小改动）。
- 合并转发发送：见 §3.1 send_forward_msg 系列 ⚠️。
- t2i 卡片（textImageThreshold>150 渲染 PNG 发 image 段 base64://）：同 base64:// 问题，需实测。

---

## 6. 建议改动清单（按文件）

工作量：小 = 单点字段/分支调整；中 = 需新增分支/适配层；大 = 无（本方案未出现）。

| # | 文件 | 改动 | 方案 | 工作量 |
| --- | --- | --- | --- | --- |
| 1 | src/connection.ts:330-332 | reverse 鉴权兼容 `?access_token=` | 在现有 Bearer 头校验外，增加对 upgrade 请求 URL query `access_token` 的 timingSafeEqual 校验（OneBot v11 标准形式） | 小 |
| 2 | src/tools.ts:393 | `get_group_msg_history` 锚点参数名 | `message_seq` → `message_id`（SnowLuma 语义：锚点消息 id，配合 reverse_order；可保留 message_seq 作为对 NapCat 的兼容双发或按 impl 分支切换） | 小 |
| 3 | src/inbound.ts:581-645 | 群聊文件获取补 `get_group_file_url` 分支 | 群聊（可从 chatId/group 上下文判断）先走 `get_group_file_url{group_id,file_id}`；`get_file` 分支降级为兜底并删除对 `base64` 字段的强依赖（SnowLuma 响应无此字段） | 中 |
| 4 | src/inbound.ts:494 | get_record 结果优先用 `base64` | 响应含 base64（服务端已按 out_format 转码）时直接写盘，跳过 url/file 二次解析 | 小 |
| 5 | src/commands.ts:788 | /ocr 的 ocr_image 输入 | 实测 `base64://` 是否被接受；不被接受时改为先 get_image 换 URL 或直接传图片 file_id | 中（含实测） |
| 6 | src/outbound.ts:443-460 | 合并转发发送适配 | 实测 NapCat 风格 node `{type:'node',data:{uin,name,content}}`；若被拒，按实测结果改节点字段（如 `user_id`/`nickname`）或改用 `upload_forward_msg` 两段式 | 中（含实测） |
| 7 | src/outbound.ts / src/tools.ts / src/split.ts | 出站空/纯空白 text 段过滤 | 发送前剔除 `text` 为空或纯空白的段（SnowLuma 会校验空白文本段） | 小 |
| 8 | src/index.ts | 配置项增量 | 可选：`impl: 'napcat'|'snowluma'|'auto'` 适配开关（用 get_version_info 的 app_name 自动判别）；文档注明 SnowLuma 部署下 allowPrivateHosts 的适用场景 | 小 |
| 9 | src/tools.ts:21-37 | 白名单策略（可选） | 全部白名单动作 SnowLuma 均支持，**可不拆分**；若后续引入不支持扩展的实现，再按 impl 拆分白名单 | 小（可选） |
| 10 | src/bridge.ts:1218-1246 | typing 指示器 | 无需改动（set_input_status 存在）；实测确认 `event_type` 参数名后关闭 | 小（验证项） |
| 11 | 文档/部署说明 | SnowLuma 接入指引 | forward 模式：SnowLuma `wsServers` 开 3001 + 与插件共享 token，插件 mode=forward 即插即用；reverse 模式：SnowLuma `wsClients` 指向插件 `/ws`，插件需完成 #1 | 小 |

总体：**无阻塞性缺口**；#1–#4 完成即可覆盖主链路，#5/#6 依赖实测结果。

---

## 7. 风险与未决问题（需实测清单）

1. **SnowLuma `wsClients` 拨出时的 token 携带形式**（Bearer 头 or `?access_token=` or 两者）：文档未明确；SDK 自己的 WS 客户端用 query 参数，提示生态倾向 query。→ 决定 #1 是否为硬前提。
2. **`send_forward_msg` / `send_private_forward_msg` 的请求体结构**（messages 节点数组？node 字段名 uin/name vs user_id/nickname？）：文档未列出请求参数。→ 决定 #6 方案。
3. **发送段 `base64://` 支持面**（image/record/video/file 段的 data.file 是否接受 base64:// URI）：文档未明确。→ 影响 qq_send_image/voice/video/file 与 t2i 卡片。
4. **`ocr_image` 是否接受 `base64://` 输入**：文档只写"图片 URL 或已缓存的图片 file_id"。
5. **入站 file 段字段名**（file/file_id/name 是否与 NapCat 完全同名同义）。
6. **get_group_member_info 的 no_cache 参数**、image 段 `sub_type` 字段是否存在：文档未明确，影响小。
7. **WS 协议层 ping/pong 与心跳 meta_event**：SnowLuma 是否响应 WS ping 未文档化（标准实现通常响应）；是否周期发 heartbeat meta_event 未文档化（插件无依赖）。
8. **多账号与 messageFormat**：多账号 = 多 SnowLuma 实例 + 多插件连接配置（插件单连接假设，v1 范围外）；messageFormat 保持默认 `array`。
9. **响应刷新 URL 行为差异**：SnowLuma get_msg 会尝试刷新媒体 URL 并同步 raw_message——对插件是利好，但 URL 时效性（rkey 机制，extended get_rkey 相关动作）与 NapCard 签名 URL 的有效期可能不同，下载失败重试路径需实测。
10. **许可**：SnowLuma 为源码可见非商业许可（非 OSI），商用/公开分发衍生版需书面授权（README"使用边界"）——如插件发行渠道涉及商业用途需法务确认。

---

## 附：插件对协议端实现假设的完整清单（核对来源）

- 动作调用点：tools.ts:362（白名单透传）、tools.ts:393（get_group_msg_history）、bridge.ts:1225/1242（set_input_status）、interim.ts:245/257（delete_msg）、outbound.ts:420（send_msg）、outbound.ts:456/458（send_forward_msg / send_private_forward_msg）、commands.ts:788（ocr_image）、inbound.ts:277/559（get_msg）、inbound.ts:490（get_image）、inbound.ts:494（get_record）、inbound.ts:593（get_private_file_url）、inbound.ts:611（get_file）、inbound.ts:678（get_forward_msg）。
- 连接/鉴权假设：connection.ts（reverse 仅 Bearer 头、forward Bearer 头、echo 关联、retcode 判定、WS ping/pong 保活、notice/request 忽略）。
- 事件假设：inbound.ts:85-119（message_type 二值、sender.card/nickname、段数组+CQ 双形态）、connection.ts:644-645（self_id 学习）。
- NapCat 特化假设：inbound.ts:574-579（get_private_file_url 优先 + get_file base64 回退）、inbound.ts:671-712（get_forward_msg 双参数 + 节点多形态）、cq.ts:226-238（file 段 file/file_id/name）、cq.ts:250-255（forward 段 id/resId）、interim.ts:27-29（recallMsg 慢限速）、bridge.ts:1218-1246（set_input_status typing）、tools.ts:191-210（record 段"协议端负责转码"注释）。
