# D-031：会话查看工具（`session_list` / `session_read` / `session_find`）

**日期**：2026-11-04
**状态**：implemented（未提交）
**关联**：功能十一；`docs/superpowers/status/2026-11-04-session-inspect.md`；用户原话 m01309、m01337。

## 问题

Agent 在排查/复盘时看不到「另一个会话」的上下文：会话库在 `~/.dsh/sessions/`，Web UI 只能人眼看，
而 `sessionQuery` 虽然提供了读服务，但没有面向模型的便捷入口。用户要一套「便捷查看其他对话的
上下文内容等信息」的工具（m01309）。

约束：

- 不能改 DSH 源码；只走官方服务。
- 只读；不能借查看工具改别人的会话。
- 不能因为「查看」而把目标会话的工具面/上下文改掉（因此只看顶层会话，不做跨 Agent 注入）。
- Web profile 的 `session-query-sqlite` 默认 `openAt: never`，FTS 不可用；不能假设全文搜索存在。

## 决定

D-031：新增 `@mosire/dsh-session-inspect` 包，三个只读工具，由 `@mosire/dshom` 的
`features.sessionInspect`（默认开）装载到**顶层** Agent scope。

- `session_list`：`listSessions` + `readTitleSnapshots`；工作区/预设/子 Agent/存活过滤；默认 20 条。
- `session_read`：`surface`（`readSurface`，当前模型上下文）/ `raw`（`readSession`，完整日志）/
  `event`（`readEvent`，`seq` ± 窗口，窗口上限 50）。统一头部（预设/标题/cwd/父/模型/工具数/轮数/
  token 合计）+ `limit`/`max_chars`/`tail` 截断。
- `session_find`：读 `readSession`，用本包 `eventText()` 渲染后做字面、大小写不敏感、空白归一化扫描；
  返回 `seq/type/time/surface/snippet`，再用 `session_read mode=event` 钻取。
- 只装顶层 Agent（`header.parentSession`/`origin:'subagent'` 跳过）；不创建/不修改会话。
- 不做跨会话 FTS v1：需要时由用户显式改 profile（`openAt: first-search`），不在本包偷偷开索引。

## 备选与否决

- **Web UI 面板**：用户要 agent 自己查，面板不能被 agent 调用。
- **直接用 `filterEvents` 实现 `session_find`**：官方 `extractSessionEventText()` 对
  `system/message` 返回空串（completed `turn/end` 也不索引），搜不到系统提示词。改为本地扫描后
  与 `session_read` 的渲染一致；代价是 `session_find` 会加载该会话完整日志。
- **直接解码 `session.v4.jsonl.zstd`**：绕过 live/preferred、继承前缀、surface 折叠，
  等于重写一遍 `sessionQuery`；不做。
- **跨会话搜索（`searchSessions`/`searchEvents`）**：Web profile 默认无 FTS；先不做。

## 证据

- 单测 14/14：`node --test packages/dsh-session-inspect/test/*.test.mjs`。
- 全工作区 277/277：`node --test packages/*/test/*.test.mjs`。
- 实机 18/18（in-process `runProfile`，web profile，127.0.0.1:3099，live `~/.dsh`）：
  - 工作区 `a6ae1ad0-6b25-4701-b3ec-c30d4258fbb8`，caller `session-dccbbaef-693b-4bf8-b5a6-6184139a0250`；
  - `minimal-prompt-lab` 会话 `session-0e6d893b-34a1-4d93-965b-5ec9c80149fc`，`/sp file` 选
    `/tmp/dsh-session-inspect-5zpoyj/prompt.md`，一轮真实模型回合；
  - `session_list` 找到会话/preset/live；`session_read surface` 含 system + user + runtime-context +
    assistant，隐藏 reasoning；`raw` 渲染 request/header 与 turn/end；`session_find` 在 seq 9
    （系统提示词）命中；`event` 钻取 seq 9。
  - 证据 `.superpowers/sdd/2026-11-04-session-inspect/evidence/live-session-inspect.json`。
- 证据目录 `.superpowers/sdd/2026-11-04-session-inspect/` 被 gitignore，不作为交付物。

## 后果

- 3080 Host 需重启后三个工具才对顶层 Agent 可见。
- 超大会话整段加载；`max_chars`/`limit` 只限渲染，不限读取。
- 跨会话搜索仍缺；如需要，另立 profile FTS 决策。
- 提交需用户批准。
