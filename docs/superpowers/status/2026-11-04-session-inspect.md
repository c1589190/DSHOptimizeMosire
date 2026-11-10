# 2026-11-04 会话查看工具（功能十一）

**状态**：已实现并验证；单测 14/14、全工作区 277/277、临时 3099 Host 实机 18/18。
**待用户重启 3080 Host** 后三个工具才对顶层 Agent 可见；未提交（等用户批准）。

## 本轮做什么

用户要求（m01309 原话）：「能不能做一套便捷查看其他对话的上下文内容等信息的工具？」

设计给两个形态，用户选 A（m01337 原话：「A」）：做成 **agent 可调用的只读工具**，而不是 Web UI 面板。
本轮交付三个工具：

1. `session_list` — 先看有哪些会话（可按工作区/预设/子 Agent/存活过滤，带标题）。
2. `session_read` — 看一个会话：`surface`（当前模型上下文，默认）/ `raw`（完整日志）/ `event`（seq 窗口）。
3. `session_find` — 在单个会话内做字面扫描，拿到 seq 再用 `session_read mode=event` 钻取。

只读：不写、不删、不创建会话；只装**顶层** Agent scope，跳过子 Agent。

## 为什么不是别的东西

- **Web UI 面板**：用户要的是「另一个 agent 能自己查」，面板不能由 agent 调用。
- **跨会话全文搜索**：Web profile 的 `session-query-sqlite` 行默认 `openAt: never`
  （`@deepseek-ai/dsh-web-app/cordis.patch.yml`），FTS 索引未开；本轮不替用户改 profile，
  先做「单会话字面扫描 + 精确读取」。
- **直接解码 `session.v4.jsonl.zstd`**：绕过官方 `sessionQuery`，会把 live/preferred、继承前缀、
  surface 折叠都自己重写一遍；本轮只用官方读路径。

## 实现

- 新包 `packages/dsh-session-inspect/`（`@mosire/dsh-session-inspect`），仅依赖官方服务：
  `ctx.sessionQuery`（必需）、`ctx.workspaceRegistry`（可选，用于工作区过滤）。
- `apply(ctx, config)`：
  - 需要 `agents` + `sessionQuery`；`workspaceRegistry` 缺失时工作区过滤不可用，其余照常。
  - per-Agent `agent.ctx.tools.register`，跟随 `agent/created` / `agent/disposed`；跳过
    `header.parentSession` 或 `origin:'subagent'` 的 Agent。
  - 状态文件 `$DSH_HOME/session-inspect-status.json` 记录 `tools` / `installed` / `config`。
- `session_list`：`listSessions(signal)` + `readTitleSnapshots(ids)`；默认只列顶层
  （`header.parentSession === undefined`），按 `createdAt` 倒序。
- `session_read`：
  - `surface` → `readSurface(sessionId)`，渲染当前模型上下文，默认隐藏 reasoning；
  - `raw` → `readSession(sessionId)`，支持 `types` / `from_seq` / `to_seq` 过滤；
  - `event` → `readEvent({sessionId, seq, before, after})`，before/after 夹到 `0..50`；
  - 头部含预设、标题、cwd、父会话、模型、工具数、轮数、token 合计；输出受 `max_chars` 截断。
- `session_find`：读 `readSession`，用本包的 `eventText()` 渲染后做字面、大小写不敏感、
  空白归一化匹配；返回 `seq/type/time/surface/snippet`。
  - **偏差**：设计里写的是 `sessionQuery.filterEvents`；实测官方 `extractSessionEventText()`
    对 `system/message` 返回空串（也不索引 completed `turn/end`），所以它搜不到系统提示词。
    改为本地扫描后，`session_find` 与 `session_read` 看到的是同一份文本，系统提示词也能搜到。
- `packages/dshom/index.js`：新增 `features.sessionInspect`（默认开），
  `whenReady(['agents','sessionQuery'])`。

## 验证

- 单测：`node --test packages/dsh-session-inspect/test/*.test.mjs` → **14/14**。
  覆盖：列表/排序/标题、子 Agent/工作区/预设/存活过滤、未知工作区、surface 渲染与 reasoning 开关、
  `max_chars` 截断、raw 类型过滤、event 窗口与 before/after 转发、参数校验、find（含 system 消息）、
  `eventText` 工具错误、`normalizeConfig`、`apply` 只装顶层 + 状态文件、`apply` 禁用。
- 全工作区：`node --test packages/*/test/*.test.mjs` → **277/277**。
- 实机（in-process `runProfile`，web profile，127.0.0.1:3099，live `~/.dsh`）→ **18/18**：
  - 工作区 `a6ae1ad0-6b25-4701-b3ec-c30d4258fbb8`；caller `session-dccbbaef-693b-4bf8-b5a6-6184139a0250`；
  - 新建 `minimal-prompt-lab` 会话 `session-0e6d893b-34a1-4d93-965b-5ec9c80149fc`，`/sp file` 选
    `/tmp/dsh-session-inspect-5zpoyj/prompt.md`，发一轮「Reply with the single word OK.」；
  - `session_list` 找到该会话、preset 正确、live=true；
  - `session_read surface` 含 system 提示词、用户任务、runtime-context、assistant「OK」，隐藏 reasoning，
    头部有模型与 token 合计；
  - `session_read raw`（`types: request/header,turn/end`）渲染请求模型/工具数与 turn 结束；
  - `session_find` 在系统提示词（seq 9）命中并给出片段；`session_read event` 钻取 seq 9 窗口；
  - dshom 已把三个工具装进 caller scope。
  - 证据：`.superpowers/sdd/2026-11-04-session-inspect/evidence/live-session-inspect.json`
    （脚本同目录 `live-session-inspect.mjs`）。

## 未验证 / 已知限制

- 跨会话全文搜索未做（Web profile FTS 默认关闭）；需要时可给 profile 打 `openAt: first-search`。
- 超大会话的 `surface`/`raw`/`find` 会整段加载；只有 `max_chars`/`limit`/`tail` 的渲染上限，
  没有流式读取。
- `from_seq`/`to_seq`/`types` 的实机组合只覆盖了 `types`；`tail`、`include_reasoning` 实机未单独跑。
- 会话标题依赖 `readTitleSnapshots`；新会话在标题生成前可能没有 title。
- 3080 Host 仍是旧进程；重启后三个工具才对顶层 Agent 可见。

## 文件

- 新增：`packages/dsh-session-inspect/{package.json,README.md,lib/index.js,test/session-inspect.test.mjs}`。
- 修改：`packages/dshom/index.js`（import + `features.sessionInspect`）。
- 文档：本文件、包 `README.md`、`.agents/notes/implemented/2026-11-04-session-inspect.md`（D-031）、根 `AGENTS.md` 功能十一。
- 证据：`.superpowers/sdd/2026-11-04-session-inspect/`（gitignored）。

## 下一步

1. 用户重启 3080 Host 后，让一个顶层 Agent 调 `session_list` / `session_read` / `session_find` 验收。
2. 若确实需要跨会话搜索，再单独评估 profile 的 FTS 开关（会影响索引与磁盘）。
3. 提交需用户批准。
