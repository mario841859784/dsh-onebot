# AGENTS.md — dsh-onebot 开发惯例

> 项目规约 + 行为准则。行为准则部分参考 [andrej-karpathy-skills/CLAUDE.md](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md)（减少常见 LLM 编码错误），倾向谨慎而非速度；琐碎任务可自行判断。

## 1. 行为准则（先想后写 / 简单优先 / 外科手术 / 目标驱动）

**1.1 先想后写**：不假设、不藏困惑、摊开权衡。实现前：
- 明确说出你的假设；不确定就问
- 存在多种解读时列出来，不要默默选一个
- 有更简单的方案就说出来，该反对就反对
- 有不清楚的地方就停下，指出是什么让你困惑，然后问

**1.2 简单优先**：解决问题的最小代码，不做投机性扩展。
- 不加没被要求的功能；不为单次使用造抽象
- 不加没被要求的"灵活性/可配置性"；不为不可能场景写错误处理
- 写了 200 行而 50 行能解决，就重写
- 自问：资深工程师会觉得这过度复杂吗？

**1.3 外科手术式改动**：只碰必须碰的，只清理自己的烂摊子。
- 不顺手"改进"邻近代码/注释/格式；不重构没坏的东西；匹配现有风格
- 发现无关死代码：提出来，不要删
- 你造成的孤儿 import/变量/函数必须清掉；预先存在的死代码除非被要求否则不删
- 检验标准：每一行改动都应能追溯到用户的请求

**1.4 目标驱动执行**：定义成功标准，循环直到验证通过。
- "修 bug" → "写复现测试，然后让它过"；"重构 X" → "重构前后测试都过"
- 多步任务先列计划，每步带 verify 检查
- 强成功标准让你能独立循环；弱标准（"弄好它"）只会带来反复澄清

## 2. 项目铁律（源自 DEVLOG.md §0 与踩过的坑）

- **DEVLOG 必写**：所有改动必须更新 DEVLOG.md（时间线/根因/修复/验证）
- **能外置的模块就外置**：纯逻辑拆独立模块（src/cq.ts、src/t2i/*），bridge.ts 只留调用点
- **t2i 测量=绘制**：换行/列宽统一走 segWidth（胶囊/粗体/斜体附加宽），像素级右缘验证 ≤790（非白判定 not(r>245&&g>245&&b>245)）
- **字符串迭代必须按码点**（Array.from / for...of），禁止 text[i] 索引 —— emoji 代理对会被拆开渲染成黑字形（DEVLOG §3.1）
- **分段对齐 Hermes 原版语义**：标点集 。！？!?；;\n，窗口内向后找标点，无标点退空格，边界不劈代理对（DEVLOG §3.2）
- **度量与绘制同家族**（t2i 字体）：家族名解析失败时 Skia 静默回退成豆腐块，必须显式选家族

## 3. 命令

```sh
# 构建（内含 link-host.sh：宿主 @deepseek-ai 符号链接）
npm install --include=dev && ./scripts/build.sh

# 测试
./node_modules/.bin/vitest run

# 上线/热加载（改配置或 touch 即 1 秒生效，无需重启 dsh）
touch ~/.dsh/profiles/web/cordis.patch.yml
```

## 4. 验收（改动完成前自查）

- [ ] tsc 零错误 + vitest 全绿
- [ ] 渲染改动：像素右缘扫描（x>791 零违规）+ view_image 视觉检查
- [ ] 协议/桥接改动：tests/e2e-peer.mjs 模拟对端 E2E 通过
- [ ] 配置改动：与 ~/.dsh/profiles/web/cordis.patch.yml 的说明同步
- [ ] DEVLOG.md 已更新

## 5. 关键文件地图

| 文件 | 职责 |
|---|---|
| DEVLOG.md | 开发时间线/坑/运维备忘（本规约的事实来源） |
| src/bridge.ts | chat→Agent 桥接、出站策略（t2i 卡片路径/分段回退） |
| src/split.ts | 分段、Markdown 剥离、[[qq_forward]] 解析、敏感审计 |
| src/t2i/index.ts | 卡片渲染入口（renderTextImage） |
| tests/e2e-peer.mjs | 模拟 NapCat 对端（ws-reverse 拨入 + echo 应答） |
