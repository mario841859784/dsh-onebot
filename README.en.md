# dsh-onebot

> **English | [中文](README.md)**

A QQ channel for DeepSeek Harness. 给 DeepSeek Harness 加上 QQ 通道。

This plugin turns dsh into a QQ bot (**OneBot 11 protocol**, compatible with NapCat / Lagrange / LLOneBot / go-cqhttp).
Like [dsh-vision](https://github.com/dsh-external/dsh-vision), it ships as an external plugin: **zero Python, pure
TypeScript, a native Cordis plugin** mounted into the dsh host process, with no core code changes.

```
User(QQ) ←→ NapCat ←→ dsh-onebot plugin ←→ dsh Agent (one per chat)
                        ├─ Reverse WS server / forward WS client (auto-reconnect)
                        ├─ Inbound: CQ parsing, image download, speech-to-text (STT), reply/forward expansion
                        └─ Outbound: split sending, Markdown stripping, [[qq_forward]], image/voice/video/file tools
```

## Features

| Category | Capability |
|---|---|
| Connection | Reverse WS (NapCat ws-reverse dials in, default port 8643) or forward WS (plugin dials out, default `ws://127.0.0.1:3001`); auto-reconnect with backoff (2s → 60s) |
| Inbound | Private/group chats; segment-array-first parsing (CQ string fallback), CQ unescaping, @/reply trigger detection (fail-closed); images resolved from 4 sources (url/base64/file/hash) with auto-shrink (long edge ≤ `imageMaxSize`, GIFs untouched); files received via dual channel (CDN direct link `get_private_file_url` + `get_file` base64/url fallback); face id→emoji/card/poke segment types; quoted messages auto-fetched via `get_msg`; merged forwards auto-expanded via `get_forward_msg` |
| Voice | ffmpeg to 16 kHz WAV + whisper transcription (openai-whisper / whisper.cpp / custom command), falls back to a `[语音]` placeholder on failure |
| Text image | t2i card renderer (@napi-rs/canvas): headings/bold/italic/strikethrough/quotes/lists/code blocks/tables/inline code pills/color emoji/CJK punctuation rules; same numbers as the Hermes original (800px/26px/rules/right edge 790) |
| Outbound | Long messages split on sentence boundaries (default ≤100 chars/message); **>150 chars rendered as a t2i text-image card** (AstrBot style: headings/quotes/lists/tables/code blocks/color emoji, auto-fallback to split text on render failure); Markdown stripped to plain QQ text; `[[qq_forward]]` merged-forward cards (group/private); loop interim messages auto-collapsed into a merged-forward card with recall (≥2 buffered → forward + delete_msg, single messages sent as-is); typing indicator (`set_input_status`, private chats only) |
| Commands | Slash commands (admin only): `/new` fresh session, `/model` view/switch model, `/workspace` view/switch workspace, `/stop` stop generation and clear leftovers, `/help` help |
| Tools | `qq_send_image` (≤9 images, path or URL), `qq_send_voice`, `qq_send_video`, `qq_send_file`, `qq_send_forward`, `qq_napcat_api` (14 allowlisted actions), `qq_group_history` |
| Permissions | Admin allowlist (`ONEBOT_ALLOWED_USERS`), dm/group policies (open/allowlist/disabled), group @-mention gating, restricted users soft limit (`[受限用户:仅问答]`), outbound sensitive-content auditing |
| Sessions | One persistent Agent per QQ chat (stable derived session id), auto-resumed after restart; mounted into presets/workspaces via `agentPreset`/`workspacePath`; mapping flushed to disk at the end of every turn |
| Ops | Hot reload (edit patch config/touch → takes effect, no dsh restart); temp media TTL cleanup |
| Prompt | Injects QQ platform notes automatically (plain-text output, images via view_image, tool guidance) |

## Compatibility

| Item | Requirement |
|---|---|
| dsh | ≥ 0.1.0-rc.6 (`engines.dsh`; all @deepseek-ai/* are peer deps at 0.1.0-rc.6) |
| Node.js | ≥ 22 |
| OneBot 11 impl | NapCat / Lagrange / LLOneBot / go-cqhttp (reverse or forward WebSocket) |
| Optional deps | Voice transcription needs ffmpeg + whisper CLI; t2i text images need Noto CJK fonts on Linux |

Last verified: 2026-08-14 (99/99 vitest green; tested against a live dsh web: QQ private/group send & receive, text-image cards, merged forwards, voice transcription, inbound large-image shrink).

## Installation

**Prerequisites**: dsh (≥0.1.0-rc.6) on PATH; NapCat or another OneBot 11 implementation running.

```sh
git clone <repo> ~/dsh-plugins/dsh-onebot
cd ~/dsh-plugins/dsh-onebot
npm install --include=dev
./scripts/build.sh          # link host @deepseek-ai packages + tsc src/ → lib/
```

Mount it in `~/.dsh/config.yaml` (create it if missing):

```yaml
- insert:
    - id: dsh-onebot
      name: '$HOME/dsh-plugins/dsh-onebot/lib/index.js'
      config:
        mode: reverse        # reverse = NapCat dials in; forward = plugin dials out
        port: 8643
        # accessToken: ''    # must match NapCat's config
        # botQQ: ''          # leave empty to learn automatically from meta events
        adminUsers: ['<your-QQ-number>']   # required: at least one admin, otherwise private chats & slash commands are unavailable
```

> ⚠️ **You must configure at least one admin on first setup** (`adminUsers` or the `ONEBOT_ALLOWED_USERS` env var):
> `dmPolicy: open` (default) only allows admins to DM, and slash commands are admin-only too; with no admin,
> nobody can talk to the bot.
> For development you can temporarily set `allowAllUsers: true` (or `ONEBOT_ALLOW_ALL_USERS=true`) to allow everyone.

Restart dsh (`dsh web` or however you start it); the log line `[dsh-onebot] mounted` means it loaded.

**NapCat side (required, pick one of two modes)**:

- **reverse mode (NapCat dials into dsh, recommended)**: in NapCat's network settings add a **WebSocket client**,
  set "report URL" to dsh's WS address `ws://<dsh-host-ip>:<port>/ws` (e.g. `ws://192.168.1.100:8643/ws`),
  and set "token" to the same value as the plugin's `accessToken`; when dsh and NapCat are on different machines
  `127.0.0.1` won't work.
- **forward mode (dsh dials out to NapCat)**: enable the **WebSocket server** in NapCat's network settings
  (listens on `0.0.0.0:3001` by default), set the plugin's `url` to `ws://<napcat-host-ip>:3001`
  (`ws://127.0.0.1:3001` works on the same machine), tokens must match on both sides.

Tokens must match on both sides; for the message report format, choose **"array"** (the plugin parses segment
arrays first; CQ strings are only a fallback). After configuring, restart dsh. `[dsh-onebot] mounted` in the log
plus a successful NapCat connection means you're ready.

**Deployment requirements**: NapCat must be on a LAN **reachable from dsh** (same subnet / routable).
The WS connection, image downloads and file resolution all depend on this network path; when NapCat and dsh are
not on the same machine, enable the **"file-to-URL" switch** on the NapCat side so `get_file` returns a downloadable
http(s) url (otherwise it returns a container-local path the plugin cannot access).

## Configuration

The full schema lives in the `Config` of [src/index.ts](src/index.ts) (schemastery-validated, every key has a
default). Common options:

| Key | Default | Description |
|---|---|---|
| `mode` | `reverse` | `reverse`/`forward` |
| `host` / `port` | `0.0.0.0` / `8643` | reverse listen address |
| `url` | `ws://127.0.0.1:3001` | forward target |
| `accessToken` | empty | OneBot token |
| `botQQ` | empty | bot QQ (empty = auto-learned) |
| `requireMention` | `true` | groups only respond when @-mentioned or replied to |
| `dmPolicy` | `open` | DM policy: `open`(admins only)/`allowlist`/`disabled` |
| `groupPolicy` | `open` | group policy: `open`(everyone)/`allowlist`/`disabled` |
| `adminUsers` | `[]` | admin QQ numbers; or the `ONEBOT_ALLOWED_USERS` env var. **At least one is required**, otherwise DMs (`dmPolicy=open`) and slash commands are unavailable to everyone |
| `allowFrom` / `groupAllowFrom` | `[]` | allowlisted users/groups |
| `interimMessages` | `true` | send interim text between tool calls immediately; `false` sends only the final reply |
| `splitLength` | `100` | text-path split length: ≤ this value sent as one message, beyond it split on punctuation/spaces (customizable) |
| `sttEnabled` | `true` | voice transcription (needs ffmpeg + whisper CLI) |
| `sttModel` | `small` | whisper model |
| `textImageThreshold` | `150` | t2i card threshold: body length > this renders a text-image card; `<=0` disables the card path. Three tiers (defaults 100/150, both customizable): ≤`splitLength` single message → `splitLength`~`textImageThreshold` split by punctuation → >`textImageThreshold` text-image card |
| `cardFooter` | `dsh` | card footer brand ("Powered by <brand>") |
| `fontFiles` / `fontFamilies` | `[]` | t2i font file/family overrides (Linux deployments: install Noto CJK, see below) |
| `mediaDir` | `<dsh-home>/media/onebot` | inbound media / mapping file directory |
| `imageMaxSize` | `2048` | inbound image long-edge limit (px): larger images are proportionally shrunk before reaching the vision model (transparent PNGs preserved, GIFs untouched); `<=0` disables |
| `agentPreset` | empty | agent preset for sessions (empty = default) |
| `workspacePath` | empty | workspace for sessions (empty = host cwd) |

Env vars: `ONEBOT_ALLOWED_USERS` (comma-separated admins), `ONEBOT_ALLOW_ALL_USERS=true` (development).

## dm / group access policies (pick on first setup)

Private (`dmPolicy`) and group (`groupPolicy`) chats each have three options:

| Option | dmPolicy (private) | groupPolicy (group) |
|---|---|---|
| `open` | **Admins only** can DM (`adminUsers`/`ONEBOT_ALLOWED_USERS`; with `allowAllUsers: true` everyone can) | **All groups** can chat (messages gated by `requireMention`: @ or reply required; group members get the `[受限用户:仅问答]` soft limit) |
| `allowlist` | Only the **`allowFrom`** QQ numbers can DM (admin not required) | Only the **`groupAllowFrom`** groups can chat |
| `disabled` | All DMs rejected | All group chats rejected |

**Recommended setups**:
- Just for yourself → `dmPolicy: open` + configure `adminUsers` (only you can DM);
- A few friends → `dmPolicy: allowlist` + `allowFrom: ['QQ1','QQ2']`;
- Group-only bot → `groupPolicy: open` (with the default `requireMention: true`, members must @ the bot);
- Only specific groups → `groupPolicy: allowlist` + `groupAllowFrom`.

## t2i font dependencies

Text-image cards need three font families (CJK / monospace / color emoji). The plugin registers them
automatically from the system and fixed paths at startup; missing glyphs render as tofu blocks.

- **macOS**: zero install. Uses system Hiragino Sans GB / Songti SC, Menlo and Apple Color Emoji automatically.
- **Linux** (Debian/Ubuntu, one command):

  ```sh
  sudo apt install fonts-noto-cjk fonts-dejavu-core fonts-noto-color-emoji
  ```

  | Package | Provides (auto-registered path) | Used for |
  |---|---|---|
  | `fonts-noto-cjk` | `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc` | CJK body/headings (SC face auto-extracted from the ttc, JP/Mono fallback) |
  | `fonts-dejavu-core` | `/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf` | code blocks / inline code monospace |
  | `fonts-noto-color-emoji` | `/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf` | color emoji |
  | optional `fonts-wqy-zenhei` / `fonts-wqy-microhei` | `/usr/share/fonts/truetype/wqy/*.ttc` | CJK fallback (when Noto is missing) |
  | optional `fonts-unifont` | `/usr/share/fonts/opentype/unifont/*.otf` | last-resort fallback |

- **Custom**: `fontFiles` adds extra font files (restart to apply); `fontFamilies` prioritizes family names.
  The renderer does an ink self-check: families missing glyphs are dropped and fall back automatically,
  so you never get a silent tofu card.

## Permissions & data

- **Network**: opens a WebSocket to the OneBot 11 gateway (reverse listen or forward dial-out); inbound
  images/files are downloaded from the QQ CDN.
- **Files**: inbound media and chat mappings are written to `<dsh-home>/media/onebot/` (`mediaDir`,
  expired files cleaned after 6 hours); session data is persisted by the dsh host.
- **System calls**: voice transcription invokes local ffmpeg and whisper CLI (disable with `sttEnabled: false`).
- **Sensitive info**: `accessToken` and the admin allowlist live in the dsh config, never in logs; outbound
  content passes a sensitive-information audit.
- **No telemetry**: nothing is collected; no third-party services are called besides your configured OneBot
  gateway and the image CDN.

## Platform notes injected into the model

- QQ does not render Markdown → output plain text (numbered/dashed lists, inline backticks).
- Send images/files/voice/video with the `qq_send_*` tools; merged forwards with `qq_send_forward`.
- User-sent images are annotated with their local path; inspect them with `view_image` (dsh-vision).
- Group messages carry a `[HH:MM nickname(QQ)]` prefix; restricted-user messages carry a `[受限用户:仅问答]`
  prefix (answer only, no file/terminal/config operations).

## Uninstall

1. Remove the dsh-onebot insert entry from `~/.dsh/profiles/<profile>/cordis.patch.yml`;
2. Restart dsh; `[dsh-onebot] mounted` gone from the log means it's unloaded;
3. Optional: delete the plugin directory and leftover media under `<dsh-home>/media/onebot/`.

## Development

```sh
./scripts/build.sh                 # compile src/ → lib/
./node_modules/.bin/vitest run     # 99 tests: unit + real WS peer + full pipeline
```

Lessons ported from the source DEVLOG:

- **CQ unescaping**: NapCat escapes `&` in URLs to `&amp;`; unescape before downloading (the root cause of CDN 403s).
- **Fail-closed @ detection**: when the bot's QQ is unknown, group messages are treated as un-mentioned and never
  auto-replied.
- **Fail pending actions on disconnect**: reject all in-flight actions immediately on WS close to avoid 10-30 s
  stalls and leaks.
- **Dedupe reconnects**: only one reconnect task per concurrent disconnect, preventing dual WS connections.
- **int(target) fallback**: chat_id parsing runs inside try/catch so a bad target can't crash the host.
- **Temp media 6h cleanup**: write-only-without-delete would pile up forever.
- **t2i iterates by code point**: JS string indexing splits emoji surrogate pairs (the high surrogate gets
  classified as CJK → rendered as a black glyph); drawing/measuring must use `Array.from`/for...of.
- **t2i measure = draw**: line breaks/column widths all go through `segWidth` (pill/bold/italic extra width),
  with pixel-level right-edge verification ≤790 (non-white test `not(r>245&&g>245&&b>245)`).

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| Group chat not responding | With `requireMention: true`, @ or reply is required; @ detection is fail-closed; make sure botQQ was learned from meta events or configured explicitly |
| Image download 403 | NapCat escapes `&` in URLs to `&amp;` (parsing unescapes automatically); if it still fails, check the media download line in the log |
| File receive fails | NapCat on a different machine needs the "file-to-URL" switch on, otherwise `get_file` returns an unreachable container path; confirm dsh ↔ NapCat network connectivity |
| Tofu CJK in text images | Linux without CJK fonts: `apt install fonts-noto-cjk`, and point `fontFiles` at an SC font file |
| Crash loop / tool registration conflict | The same plugin file inserted twice (double instance); check the patch has no duplicate entries |
| Voice shows `[语音]` placeholder | ffmpeg or whisper unavailable; install and restart, or set `sttEnabled: false` |
| Where are the logs | dsh host logs; historical root causes & fixes in [DEVLOG.md](DEVLOG.md) |

## Development record

Full timeline / root causes / fixes: [DEVLOG.md](DEVLOG.md) (ported from the Hermes onebot plugin's DEVLOG convention).

## License

BSD-3-Clause
