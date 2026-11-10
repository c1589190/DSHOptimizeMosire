# D-030：prompt-lab 会话编排工具（`prompt_lab_workspaces` + `prompt_lab_session`）

**日期**：2026-11-04（2026-11-04 按用户重设计修订）
**状态**：implemented（未提交）
**关联**：功能十；`docs/superpowers/status/2026-11-04-prompt-lab-session.md`；预设侧
`docs/superpowers/specs/2026-11-04-prompt-lab-preset-design.md`；用户原话 m00953、m01142、m01163。

## 问题

批量比较系统提示词对 Agent 表现的影响，需要「同一任务 × 多个提示词 × 多个独立会话」。
三条现成路径都不合适：

- 官方 headless（`@deepseek-ai/dsh-headless`）明确拒绝带 `agentPreset` 的会话
  （`assertAdoptable`：`runs under agent preset "...", which the one-shot runner does not compose`），
  且没有 `--system-prompt`；它只能跑没有预设的默认组合。
- 子 Agent 会继承调用方的上下文与工具面，不是「独立同级会话」，不适合对照。
- 让用户在 Web UI 手工开会话、敲 `/sp`、再发任务，无法由另一个 agent 批量驱动。

用户先要工具化（m00953），随后改设计（m01142）：先列出已配置工作区，只在已有工作区内建会话，
可配模型/提示词，且预设只能是 `minimal-prompt-lab`。

同时修掉一个真实缺陷：旧版接受 `cwd`，调用方传 `cwd: "/home/cna/test"` 时走
`controller.create({cwd})`，**没有 attach 到工作区**；侧栏严格按 `workspace.sessionIds` 分组，
这些会话于是落进「未分组」。新版不再接受 `cwd`，一律 `workspaceId` 创建。

## 决定（修订版）

D-030：新增 `@mosire/dsh-prompt-lab-session` 包，两个 agent 可调用工具，由 `@mosire/dshom` 的
`features.promptLabSession`（默认开）装载。

- `prompt_lab_workspaces`：列已配置工作区（`workspaceId/title/path/sessionCount`）；调用方先看再建。
- `prompt_lab_session`：`workspace` 必填（id → 精确 title/path → `resolveByPath`），
  `prompt`/`model`/`task`/`timeout_seconds` 可选；拒绝 `cwd` 与 `preset`；未知工作区在创建前失败并列出可用项。
- 建会话：官方 `sessionController.create({workspaceId, agentPreset:'minimal-prompt-lab'})`，
  由 controller 内部 `workspace.attachSession(sessionId)` 归档；不再有「无工作区」路径。
- 选提示词：创建前用 `readPromptFile` 校验文件（UTF-8/BOM/空/256 KiB），相对路径按工作区路径解析；
  实际选择执行预设作用域的 `/sp file|text|blank|clear`；提示词正文不入工具状态，仍以会话的
  `prompt-lab` projection 为准，文件在会话下一次请求时读取。
- 选模型：`controller.modelCatalog()` 先校验 provider/model/reasoning effort；通过后向新会话 append
  `model/selection` 事件（`{provider, model, reasoningEffort?}`）。**不**用 `controller.selectModel`：
  它会把选择同时存成部署默认模型，批量实验不应改默认。
- 跑任务（可选）：`controller.prompt(...)` → `agent.whenIdle()`（超时返回 `timeout`，不杀回合）→
  从 `agent.session.snapshotEvents()` 取最后一条非空 `assistant/message`。
- 装载面：per-Agent `agent.ctx.tools.register`，跟随 `agent/created`/`agent/disposed`；跳过子 Agent
  （`header.parentSession` / `origin:'subagent'`）。
- `signal` 缺省回退 `new AbortController().signal`（官方 `commands.execute` 直接读 `signal.aborted`）。

## 备选与否决

- **保留 `cwd` 并自动升级为工作区**：旧版思路；但调用方只要传了 `cwd` 就绕过归档，正是本次缺陷来源。
  删掉该参数，让「工作区」成为唯一入口。
- **用 `controller.selectModel` 配模型**：会改部署默认模型；改用 `model/selection` 事件。
- **独立 CLI（`tools/prompt-lab-batch.mjs`）**：可行，但每次调用要再起一个 Host，且不是 agent-native；
  批量 runner 由用户单开 agent 组装。
- **专用 headless profile**：能做成真 `dsh --profile ...` 一条命令，但要另抄一份组合（与官方 Minimal /
  Web 预设漂移），没有 `/sp` 的会话内选择/冻结语义。

## 证据

- 单测 12/12：`node --test packages/dsh-prompt-lab-session/test/*.test.mjs`。
- 实机 spawn-only（3099，in-process `runProfile`，live `~/.dsh`）12/12：工作区列表包含目标工作区；
  caller `session-547fdd9b…`；新会话 `session-af61d088-becf-4cfd-a355-0e008da3609a`
  （preset `minimal-prompt-lab`，工作区 `96201178-753e-4122-a903-0815b9ccfd96`）；
  工作区 `sessionIds` 含新会话；`prompt-lab` projection `selection {kind:'file', path, seq:3}`；
  dshom 已把工具装进 caller scope。
  证据 `.superpowers/sdd/2026-11-04-prompt-lab-session/evidence/live-spawn.json`。
- 未验：`task` 真机回合/超时、`/sp text|blank|clear` 真机、并发批量、3080 重启后的可见性。

## 后果

- 工具对所有顶层 Agent 可见（包括官方 Minimal 对照会话），因此它是 profile 级基线的一部分：
  对照与实验会话都多同一件工具，不构成预设间的差异；需要干净基线时可用
  `features.promptLabSession:false` 关掉。
- 批量实验员（另一个 agent）先调 `prompt_lab_workspaces`，再循环 `prompt_lab_session`，每次一个独立会话；
  新会话会出现在对应工作区与 Web 列表。
- 已存在的「未分组」老会话不自动归位（用户 m01163 明确）；只有新会话保证归档。
- 3080 Host 仍是旧代码，重启后才装载两个工具。
