# AGENTS.md — 给编码 agent 的工作规约

本仓库是 dsh-onebot:给 DeepSeek Harness 加 QQ 通道(OneBot 11)的纯 TS Cordis 插件。
agent 在本仓库工作时遵守以下规约。

## 构建与验证

```sh
npm install          # 首次(或 lockfile 变更后)
./scripts/build.sh   # 构建:src/ → lib/(需要 PATH 里有 dsh,peer 包解析自宿主安装)
npx vitest run       # 全量测试
npx vitest run tests/<file>.spec.ts   # 单文件
```

- 提交前必须:`./scripts/build.sh` 通过 + 相关测试通过。
- 改动 `src/` 后 `lib/` 是构建产物;不要手改 `lib/`。

## 代码规约

- 纯 TypeScript,原生 Cordis 插件形态;不改宿主核心代码。
- 网络行为(WS 重连、超时、重试)遵循现有实现的退避参数,不要随手改数值。
- 用户可见文案用中文,与现有 README/提示词风格一致。

## 提交规范

- Conventional Commits:`feat(scope): …`、`fix(scope): …`、`chore(scope): …`。
- 现有提交尾部带 `(T1)`/`(T2)` 标记,agent 提交不需要带标记。
- 一个 PR 只做一件事;顺手的无关清理不要混进来。

## 禁区

- 不要改动 `cordis.patch.yml` 的机器级配置(端口、stateDir、密钥相关)。
- 不要引入新的运行时依赖;确需时先在 PR 里说明理由并停下等 review。
- 不要动 `docs/` 里的验收证据(acceptance-evidence 等)。

## 待维护者补充

<!-- 在这里补充你希望 agent 长期遵守、但上面还没写的规矩 -->
