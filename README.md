# DSHOptimizeMosire（dshom）

「梁神模式」的现代复刻 + 功能优化：一个装进 DeepSeek Harness（DSH）的 agent preset 插件。

复刻基准是社区已停用的**锚定式（anchored standard）**实现——首轮只暴露 Minimal 双工具、剥离自动注入上下文、
首次工具调用后放开完整目录、压缩后重新锚定；优化方向见调研长文与项目铁律。

两个功能：
1. **梁神模式复刻**（Web profile 插件 bundle）：见 `docs/agents/00-调研-梁神模式谱系.md`；
2. **goal 续轮确认门**（功能二）：goal 自动续轮注入时弹显式确认（确认→继续 / 取消→删除 goal / 30s 可配置无操作→继续），
   见 `docs/agents/02-调研-goal续轮确认门.md`。

- 状态：调研完成，设计与实现未开始（2026-10-17）
- 入口：[AGENTS.md](AGENTS.md)（项目简介 + 五条铁律 + 文档索引）
- 调研：[docs/agents/00-调研-梁神模式谱系.md](<docs/agents/00-调研-梁神模式谱系.md>)
- 存档：[docs/superpowers/status/2026-10-17-initial-survey.md](docs/superpowers/status/2026-10-17-initial-survey.md)
