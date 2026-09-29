# market 迁移证据索引（dsh-onebot-qq@0.4.7，live web profile，2026-09-25）

迁移：live patch 摘除手工绝对路径两行 → `dsh plugin --profile web add dsh-onebot-qq@0.4.7` 官方安装 → bundle patch（裸包名两行）热挂载回 8765。全程热操作，宿主 pid 3500551 未重启。QQ 桥闪断约 3 分钟。

| # | 文件 | 内容 |
|---|------|------|
| 00 | 00-live-web-baseline.txt | 迁移前基线：cordis.patch.yml / cordis.yml / package.json sha256 + 8765 LISTEN/ESTAB + 进程 |
| 01 | 01-getSettings-pre-migrate.json | 迁移前 onebotSettings/getSettings：revision=0，host 192.168.5.74，port 8765 |
| 02 | 02-unmount-after-patch-edit.txt | 摘条目后 ~2s 旧 fiber 卸载（8765 消失），宿主存活 |
| 03 | 03-plugin-add.txt | `dsh plugin add dsh-onebot-qq@0.4.7` exit 0（fresh-release 由 minimumReleaseAgeExclude 放行） |
| 04 | 04-market-log-tail.ndjson | .dsh-market/log.ndjson（迁移时点附近） |
| 05 | 05-getSettings-post-migrate.json | 迁移后 getSettings：ok，revision=0 未跳变，host/port 与迁移前一致，accessToken set:true |
| 06 | 06-market-recognizes-install.json | market updates API（force=1）：source npm，installed=latest=0.4.7，updateAvailable=false |
| 07 | 07-market-update-noop.json | in-host market 对 dsh-onebot-qq 的 agent 守卫事件（update-blocked）——market 已纳管该包 |
| 08 | 08-patch-diff-before-after.txt | 迁移前后 live patch diff（仅 insert 块两行 + 注释变更，config 覆盖行未动） |
| 09 | 09-final-verification.txt | 终态验证矩阵：8765 LISTEN（fd 24，pid 3500551）、ESTAB（172.17.0.3，fd 29）、getSettings、node_modules、免责核验、宿主进程 |

## 说明（如实记录）

- ⑤ log.ndjson 无 install/hot-mount 事件：CLI 通道（`dsh plugin add`）不经过宿主内 market 服务，logEvent 仅存在于宿主 market RPC 路径（dshmarket/src/routes.ts 实证）。market 识别以 06/07 两证替代；完成定义中的 `dsh plugin list` 已通过（dsh-onebot-qq@0.4.7 在 profile dependencies）。
- headless Chromium 设置页渲染：本机无 chromium/playwright 可执行文件，条件不具备，未做。
- live patch 中唯一含「dsh-plugins」字样处为迁移说明注释，非路径条目；YAML safe_load 扫描 name 字段零绝对路径。
- 部署副本 /vol2/@appshare/Harness/dsh-plugins/dsh-onebot 保留不删（回滚锚点）；备份 cordis.patch.yml.bak-migrate-20260925 与迁移前 live patch sha256 一致（ac87a4a3…）。

---
**DevOps 自动化师** · 2026-09-25 · 迁移完成，验证矩阵全过
