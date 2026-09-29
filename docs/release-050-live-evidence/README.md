# 0.5.0 发版与 live web profile 升级证据（2026-09-29）

| # | 文件 | 内容 |
|---|------|------|
| 01 | 01-commits.txt | 两笔 commit：3af11a7 feat（适配代码+证据文档+gitignore）、ee28ea7 chore(release): 0.5.0 |
| 02 | 02-npm-registry.txt | registry 核验：latest=0.5.0，engines.dsh 含第四分支 >=0.2.0-rc.1 <0.3.0-0 |
| 03 | 03-market-updates.json | market updates API（force=1）：installedVersion=0.5.0（latestVersion=0.4.9 为宿主 registry 元数据缓存，尚未复制 0.5.0） |
| 04 | 04-exemption-cleanup.txt | compatibility.json 撤销 0.4.9 陈旧豁免后状态 + profile node_modules=0.5.0 |
| 05 | 05-bridge-final.txt | 8765 LISTEN（pid 54650 fd 23）+ ESTAB（172.17.0.4 fd 33，桥接全程无闪断）+ 宿主 err.log 零 ERROR |

## 关键事实（如实记录）

- live 升级经官方 CLI 通道 `dsh plugin --profile web add dsh-onebot-qq@0.5.0`（exit 0），全程宿主进程不重启（pid 54650，etime 覆盖整个任务窗口），QQ 桥零闪断（同 fd 33、对端 41380 连续）。
- 运行中宿主 fiber 仍为启动时（11:46）载入的 0.4.9 host-plane 代码：add 仅替换磁盘文件，宿主无新 mounted 行、无 fd 变化。0.5.0 host-plane 代码将随宿主下次重启生效。
- 依据（宿主源码实证，dshmarket/lib/routes.js #685 注释）：profile 为 hoisted 布局，更新就地重写文件、模块 URL 不变，Node ESM 缓存使同 URL 的后续 import 命中旧模块；disable→enable（setEntryDisabled）只重建 fiber 不换模块，「Only a restart ends the process that holds it」。已挂载插件的就地版本替换在宿主设计上即 restart-required（dsh-plugin-manager change() 无 hmr 时返回 restart-required；hmr 服务未挂载）。
- 豁免形态前后对照：升级前 compatibility.json 含 `"dsh-onebot-qq@0.4.9": ["0.2.0-rc.1"]`（宿主 0.2.0-rc.1 下旧 peer 上限 <0.2.0-0 失配的强豁免记录）；升级后 0.5.0 满足新分支、安装期 compat 校验零告警，并以 `dsh plugin revoke-version` 撤销陈旧条目——compatibility.json 已无 dsh-onebot-qq。
- market 侧 registry 元数据缓存 latestVersion=0.4.9 属 CDN 复制延迟（npm --prefer-online 已确认 latest=0.5.0），随宿主缓存刷新自愈，无需干预。
- onebotSettings/getSettings RPC 未经直接调用核验：该 RPC 仅宿主 /api 通道可达（浏览器会话鉴权），无可用凭据通道；以桥接功能证据替代（ESTAB 持续、宿主日志 OneBot connected / turn/end 正常、零 ERROR）。
