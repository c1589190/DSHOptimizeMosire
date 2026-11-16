# 2026-11-16 修复：新会话「创建后切预设」时锚定未生效

## 触发

用户 2026-11-16 截图：新开一个「梁神模式」会话，上下文面板显示第 1 轮第 1 步工具定义 ≈14.7k（99%）、
runtime-context 已注入，模型直接调用 `list_agents`——首轮暴露策略没有生效。

## 根因

**GUI 新建会话的官方流程是「先创建、再切预设」**：`@deepseek-ai/dsh-client-ui-agent-preset` 的新会话
预设 chip 只是“staged choice”，会话按部署默认预创建，首轮开始前才通过 `AgentPresets.select`
追加 `agent-preset/selected`（`src/client/AgentPresetSeat.tsx` 文件头注释：

> “Picking stages; the choice reaches a session when one becomes current.”

而我们的锚定三件套全部只在 `agent/created` 时初始化：

- `tool-bootstrap.mjs`：`tools.restrict({allow:[bash,str_replace_editor]})` 在 `agent/created` 应用；
- `context-gate.mjs`：`suppressRuntimeContext()` + required shadows 在 `agent/created` 注册；
- `dshom/tool-gate.js`：`deferrable` 读 `session.header.agentPreset`（创建头）。

`AgentPresets.select` 的 `recompose` 只是把 agent 绑定到已挂载的预设 scope（registry `mount`→`retain`→`bind`），
不会重新触发 `agent/created`，所以三者全部漏掉；只有 **persona** 是 scope 里的静态 system-prompt 段，
切换后自然生效——造成“看起来是梁神模式、实际是 standard 工具面”的错觉。

现场证据（用户会话 `session-f8df17a3-2f8b-4ebb-9e66-06ac5c57e1ae`，cwd 本仓库）：

- `session`（seq 0，18:00:17）：`agentPreset=standard`；
- `agent-preset/selected`（seq 4，18:00:19.5）：`liangshen`；
- 首个 `request/header`（seq 12，18:00:23）：**73 tools**，`bash/read/write/edit/...` 全在；
- `runtime-context` 在 T1 S1 注入（本应被 gate 抑制）。

## 改动

1. `packages/dsh-liangshen-anchored/presets/liangshen/tool-bootstrap.mjs`
   - 新增 `lookupAgent()`（`ctx.get('agents').get(session.id)`）与 `ensurePhase()`；
   - `session/event` 首次观察到某 session 时补建 phase 并立刻 `syncToolRestriction()`。
2. `packages/dsh-liangshen-anchored/presets/liangshen/context-gate.mjs`
   - 同样的 `lookupAgent()` / `ensurePhase()`；`session/event` 首次观察时补建并 `syncContextGate()`（注册抑制与 required shadows）。
3. `packages/dshom/tool-gate.js`
   - 新增 `effectivePreset()`：创建头被最新 `agent-preset/selected` 覆盖；
   - `isDeferrable()` 改用它；`session/event` 收到 `agent-preset/selected` 时重算每个 slot：
     锚定预设且未晋升 → `disposeSlot`（卸载 feature 工具组），否则重新挂载。
4. 测试：`tool-bootstrap.test.mjs`（新增 2 条，含晋升释放）、`context-gate.test.mjs`（新增 1 条晚加入）、
   `dshom/test/tool-gate.test.mjs`（新增 1 条切换后延迟/晋升再挂载）。

## 验证

- 单测：
  - `packages/dsh-liangshen-anchored`：`node --test test/*.test.mjs` → **125/125 pass**（原 122 + 新增 3）；
  - `packages/dshom`：`node --test test/*.test.mjs` → **6/6 pass**。
- 真实 E2E（in-process `runProfile`，真实 web profile，127.0.0.1:3099，live `~/.dsh`）：
  `.superpowers/sdd/2026-11-16-preset-switch-anchor/evidence/verify-switch.mjs`
  复现 GUI 路径：`controller.create({cwd})`（无 preset）→ `presets.select(agent,'liangshen')` → 两轮对话。
  会话 `session-f035d950-ec98-4335-ad96-f9a91527366d`：
  - 创建头 `standard`，`agent-preset/selected` @ seq 4；
  - 首个 `request/header`：`["bash","str_replace_editor"]`（2 个），feature 工具 0 个；
  - 首步注入源：`[]`；persona 正确；
  - 第二请求：**73 tools**，含 `job_wait/job_read/session_*/subagent_*/prompt_lab_*`；
  - `tools/verify-session.mjs` 同源分析：`analysis.ok=true`，failures `[]`。
  证据 `verify-switch.json` / `verify-switch-events.jsonl`。

## 未验证 / 注意

- **3080 Host 需要重启**才会加载新的 preset `.mjs` 与 `tool-gate.js`；已存在的会话不能追溯修复（首请求已经发生），
  重启后需**新建会话**，在发送第一条消息前选择梁神模式。
- 临时 3099 Host 写入了 `~/.dsh/*-status.json` 的 `pid`（诊断文件，不影响运行）；本次留下测试会话
  `session-f035d950…`（cwd 在 /tmp），可忽略或删除。
- 子 Agent 首轮仍有 4 个工具（`job_wait`/`job_read` 泄漏，`tool-gate` 对 `delegationDepth>0` 立即挂载）——
  这是 2026-11-15 盘点记录的另一个已知缺口，本轮**未改**。
- 压缩重锚、`/compact` 未在本轮 E2E 覆盖。
