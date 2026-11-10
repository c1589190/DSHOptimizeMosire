# 2026-11-04 prompt-lab 会话编排工具（功能十）

**状态**：已实现并按用户 2026-11-04 的重设计更新；单测 12/12；临时 3099 Host 实机 spawn-only 12/12。
**待用户重启 3080 Host** 后两个工具才对顶层 Agent 可见；`task` 真机回合/超时仅单测。未提交（等用户批准）。

## 本轮做什么

用户要求（m00953 原话）：「你不用帮我试，我后面会单开agent搞的，你要确保的就是这个工具做出来了，能自动在dsh指定工作区新建同级会话，并且还可以用我们的提示词指定模式指定一个提示词来用」。

2026-11-04 用户改设计（m01142 原话）：「我觉得功能可以改成这样，先查看dsh已配置的工作区，然后根据已有的工作区，创建会话，允许配置模型、系统提示词等，但是只能用那个自定义系统提示词的预设」。

即：

1. 先列出 DSH 已配置的工作区；
2. 只在**已有工作区**里创建**同级（顶层）会话**；
3. 可配模型与系统提示词；
4. 预设只能是 `minimal-prompt-lab`。

用户随后确认（m01163）：「开始吧，老对话不用自动归位」——已存在的未分组成员不动，只保证新会话正确归档。

## 旧版的问题（已修）

旧版 `prompt_lab_session` 同时接受 `workspace` 与 `cwd`；调用方传了 `cwd: "/home/cna/test"`，
工具走 `controller.create({cwd})`，**没有 attach 到工作区**。侧栏按 `workspace.sessionIds` 分组
（`@deepseek-ai/dsh-client-ui-workspace/lib/client.js` 的 `groupByWorkspace`），于是这些会话落进「未分组」。
新版删掉 `cwd`，所有创建都走 `workspaceId`，由 `controller.create` 内部 `workspace.attachSession` 归档。

## 实现

- 新包 `packages/dsh-prompt-lab-session/`（`@mosire/dsh-prompt-lab-session`），两个工具：
  - `prompt_lab_workspaces`：无参数，返回 `{workspaces:[{workspaceId,title,path,sessionCount}]}`；
  - `prompt_lab_session`：`workspace` 必填（id → 精确 title/path → `resolveByPath`），
    `prompt{file|text|blank|default}`、`model{provider,model,reasoning_effort?}`、`task`、`timeout_seconds` 可选；
    **拒绝** `cwd` 与 `preset`。
- 提示词：创建前用 `readPromptFile` 校验（UTF-8/BOM/空/256 KiB）；文件相对路径按**工作区路径**解析；
  选择通过预设作用域的 `/sp` 命令执行；真正读取仍发生在会话下一次请求。
- 模型：创建前用 `controller.modelCatalog()` 校验；随后向新会话 append 一条
  `model/selection` 事件（`{provider, model, reasoningEffort?}`）。**不**调 `controller.selectModel`，
  因为它会把选择同时存成部署默认模型。
- 创建：`sessionController.create({workspaceId, agentPreset:'minimal-prompt-lab'})`；创建后 `agents.get(sessionId)`；
  `/sp` 走 `commands.execute`；任务走 `controller.prompt(...)` + `agent.whenIdle()`；答案取
  `agent.session.snapshotEvents()` 最后一条非空 `assistant/message`。
- 装载：per-Agent `agent.ctx.tools.register`，跟随 `agent/created`/`agent.disposed`；跳过子 Agent；
  状态文件 `$DSH_HOME/prompt-lab-session-status.json` 记录两个工具名。
- `packages/dshom/index.js`：`features.promptLabSession`（默认开），
  `whenReady(['agents','sessionController','commands','workspaceRegistry'])`。

## 验证

- 单测：`node --test packages/dsh-prompt-lab-session/test/*.test.mjs` → **12/12**。
  覆盖：工作区列表；id/title/path 解析；拒绝 `cwd`/`preset`；模型目录校验 + `model/selection` 事件；
  四种 prompt kind；任务路径；无效提示词/未知工作区在 `controller.create` 前失败；子 Agent 跳过；禁用开关；
  `preparePrompt`/`normalizeConfig`/`lastAssistantText`；schema。
- 实机 spawn-only（in-process `runProfile`，web profile，127.0.0.1:3099，live `~/.dsh`）→ **12/12**：
  - 工作区 `96201178-753e-4122-a903-0815b9ccfd96`；caller `session-547fdd9b…`（`standard`）；
  - `prompt_lab_workspaces` 的列表包含该工作区；dshom 已把工具装进 caller scope；
  - 新会话 `session-af61d088-becf-4cfd-a355-0e008da3609a`，preset `minimal-prompt-lab`；
  - 工作区 `sessionIds` 含新会话（**归档修复的判据**）；
  - `prompt-lab` projection 的 `selection = {kind:'file', path:…, seq:3}`、`lastSystemSeq=0`（未冻结）；
  - 提示词 sha256 与文件一致；未发任务。
  - 证据：`.superpowers/sdd/2026-11-04-prompt-lab-session/evidence/live-spawn.json`（脚本同目录 `live-spawn.mjs`）。
- 未验证：`task` 真机回合与超时、`/sp text|blank|clear` 真机、并发批量、3080 Host 重启后的可见性。

## 文件

- 新增：`packages/dsh-prompt-lab-session/{package.json,README.md,lib/index.js,test/prompt-lab-session.test.mjs}`。
- 修改：`packages/dshom/index.js`（import + `features.promptLabSession` 的 `whenReady` 列表加 `workspaceRegistry`）。
- 文档：本文件、`README.md`、`.agents/notes/implemented/2026-11-04-prompt-lab-session.md`（D-030 修订）、根 `AGENTS.md` 功能十。
- 证据：`.superpowers/sdd/2026-11-04-prompt-lab-session/`（gitignored）。

## 下一步

1. 用户重启 3080 Host 后，用顶层会话调用 `prompt_lab_workspaces` → `prompt_lab_session`（可带 `task`）验收真实回合。
2. 批量 runner 由用户单开 agent 组装（工具已就位）。
3. 提交需用户批准。
