# 子 Agent 访问设计 · 功能三（父 → 子控制面）

> **状态**：设计已定；用户 2026-10-17 授权「出设计，提交并推送，然后开始实现」，并确认「你说的这些问题我陆陆续续全都遇到过一遍了」。
> 本文覆盖 **M1（本轮实现）父→子控制面三工具**；M2（liangshen 子 Agent 锚定语义实验）只给实验设计，不实现。
> 关联：`docs/agents/03-调研-子Agent访问.md`（调查与 E2E 证据）；决策记录 `.agents/notes/implemented/2026-10-17-subagent-access-scope.md`。
> **本文不含实现代码**；实现按 `docs/superpowers/plans/2026-10-17-subagent-access.md` 执行。

## 1. 问题与目标

### 1.1 已确认的问题（回代码 + E2E 核过）

1. **Web profile 下父 → 子控制面残缺**：host 层全局挂载的 Agent Team 工具占据顶层会话的
   `send_message` / `list_agents` / `interrupt_agent` / `wait_agent`，其目标解析只认 `lead` 或 active teammate
   （`dsh-experimental-agent-team/lib/index.js:350-361`）；普通 `subagent` / `subagent_fork` 子会话不是 Team 成员。
   E2E 证据（2026-10-17 本次会话）：父会话 `send_message({target:"7b872b21-…"})` →
   `Error: active teammate "7b872b21-2a7b-4d9d-893a-b914c20155fb" not found`。
2. 反方向（子 → 父 `agent-message` relay）是通的；`subagent` 工具自述「continue with send_message」、
   结算通知「unless you send it more」与实际能力矛盾。
3. 427 个子会话语料里只有 10 个收到过任何后续消息 → 控制路径事实上不可用。
4. 子会话强制继承父预设、spawn 无上下文、fork 不含 in-flight turn、可观测性弱、能力面重叠（详见调研 §三）。

### 1.2 目标（M1）

在**不改 DSH 源码、不改 Team 行为**的前提下，给**顶层会话**补一组模型可直接调用的工具，
让它能对**自己启动的普通子会话**执行：列出、发消息（唤醒/续聊）、中断当前回合。
底层只调用官方 `ctx.subagents` 服务与 `ctx.agents` 状态。

### 1.3 成功判据（验收）

| ID | 判据 | 验证方式 |
|---|---|---|
| A1 | bundle 安装 `application: applied`、行激活无 diagnostic；状态文件写出 `activated:true` | `plugin_manager` 返回 + `$DSH_HOME/subagent-access-status.json` |
| B1 | 顶层会话的工具面出现 `subagent_list` / `subagent_message` / `subagent_interrupt`；**liangshen 首轮锚定 wire 不变**（首请求仍 2 工具） | `cordis_inspect_query` Tool.listTools（当前会话）+ verify-session 回归 |
| B2 | `subagent` 派发子会话后，`subagent_list` 返回该子会话的 id / label / mode / status | 真实会话 E2E |
| B3 | 对 idle 的 continuable 子会话 `subagent_message` → 子会话启动新回合并把回复以 `agent-message` 送达父会话 | 真实会话 E2E + 子/父会话 JSONL |
| B4 | 对 running 子会话 `subagent_interrupt` → 子会话当前回合被中止、可再次 message；返回 `previousStatus:"running"` | 真实会话 E2E（长任务子会话） |
| B5 | one-shot 子会话可被列出；对其 message 返回「不可续」错误（服务语义），不崩溃、不静默 | 单测 + 真实语料 |
| B6 | 对非直接子会话 / 伪造 id：服务拒绝（`UNAUTHORIZED`/`NOT_FOUND` 类），工具返回错误结果 | 单测 |
| C1 | `enabled:false` → 不安装任何工具、不注册监听 | 单测 + 安装验证 |
| C2 | `includeDelegatedAgents:true` → 子会话也安装该工具组（默认 false，仅 root） | 单测 |
| C3 | agent 销毁 / 插件卸载时工具 disposer 全部执行，无残留 | 单测 |
| D1 | `subagents` 或 `agents` 服务缺失 → fail-open（不安装工具、不抛异常），状态文件记录原因 | 单测 |
| E1 | 功能一/二回归：45 + 30 项既有单测全绿；Team 工具与既有会话不受影响 | 全量测试 + 安装后实测 |

**负向用例**：从未派发过子会话的会话 → `subagent_list` 返回空数组；对自身 id 调 message/interrupt → 服务拒绝；
Team 成员/Team 工具行为不因本插件改变。

### 1.4 非目标

- 上下文接力（R3：父会话上下文/交接包注入子会话）——延后，另行设计；
- 修改 DS H 源码、`subagent` / `subagent_fork` 工具描述、Team 工具；
- GUI/子会话侧栏、跨进程控制、durable parent mailbox；
- M2（liangshen 子 Agent 是否锚定）——只给实验设计，实现需实验数据后由用户裁定；
- Team 成员过滤（见 §5 已知限制）。

## 2. 架构

**独立 bundle、单 host 插件，无 client half。**

```
packages/dsh-subagent-access/
├── package.json            # @mosire/dsh-subagent-access, private, dsh.bundle.patch
├── cordis.patch.yml        # insert 行 id=subagent-access
├── lib/
│   ├── index.js            # cordis 插件：安装/卸载 per-agent 工具、状态文件
│   └── catalog.js          # 纯逻辑：配置归一化、目录行映射、状态映射（可单测）
├── test/{catalog,plugin}.test.mjs
└── README/NOTICE/LICENSE/icon.svg/locale
```

- **安装时机**：`apply()` 时对 `ctx.agents.list()` 全部已存活 agent 安装；之后监听
  `agent/created` / `agent/disposed`（与官方 Team 工具同款模式，
  `dsh-experimental-tool-agent-team/lib/index.js:540-556`）。
- **安装位置**：每个目标 agent 的 `agent.ctx.tools.register(defineTool(...))`；
  disposer 收集、销毁时逆序释放；插件卸载时全部释放。
- **目标筛选**：默认仅 `agent.session.header.delegationDepth ?? 0 === 0`（root 会话）；
  `includeDelegatedAgents:true` 时对所有 agent 安装。
- **依赖注入**：`inject = ['agents', 'subagents']`；`tools` 通过 `agent.ctx.tools` 使用。
  `subagents` 缺失时 fail-open：不安装、写状态并 warn。
- **defineTool**：从官方 `@deepseek-ai/dsh-tools` 导入（bundle 声明 peer；workspace 用
  `tools/link-dsh-peers.mjs` 建立的 symlink farm 解析，与功能一同款做法）。

## 3. 工具契约

工具名**刻意不与 Team 重名**（Team 已有 `send_message` / `list_agents` / `interrupt_agent`）。

### 3.1 `subagent_list`

- 描述：列出本会话启动的子 Agent 会话（id / label / 模式 / 实时状态）。
- 参数：无。
- 输出：`{ children: [{ id, label?, mode: "continuable"|"one-shot"|"unknown", status: "running"|"inactive", createdAt }] }`
- 行为：`ctx.subagents.listChildren(agent.session.id, exec.signal)`；status =
  `ctx.agents.get(id)?.status === "running" ? "running" : "inactive"`（非 resident 一律 inactive）。
- 空列表合法；服务异常 → 工具错误文本，不抛出未捕获异常。

### 3.2 `subagent_message`

- 描述：给本会话启动的一个子 Agent 发后续消息。运行中的子 Agent 在最近 step 边界收到；idle 的
  continuable 子 Agent 会启动新回合。one-shot 子 Agent 不可续。返回已接受的消息 id，不返回子 Agent 的回复。
- 参数：`child_id`（string, required，来自 `subagent_list` 的 id）；`message`（string, required，自包含）。
- 输出：`{ messageId }`
- 行为：`ctx.subagents.sendMessage(agent, childId, [{type:"text", text: message}], { signal: exec.signal })`。
- 错误：服务自己的 `NOT_RESUMABLE` / `UNAUTHORIZED` / `PARENT_UNAVAILABLE` 等错误消息透传为工具错误。

### 3.3 `subagent_interrupt`

- 描述：中断本会话启动的一个子 Agent 的当前回合；子 Agent 本身保留可继续，其后代继续运行。返回中断前状态。
- 参数：`child_id`（string, required）。
- 输出：`{ previousStatus: "running"|"inactive" }`
- 行为：先采样 `ctx.agents.get(childId)` 状态，再 `ctx.subagents.interrupt(childId, { kind:"ancestor", agent })`。
- 错误：非后代/伪造 id → 服务授权错误透传。

**描述写作约束**（agent-experience）：只描述行为与返回，不复述实现；参数规则写在参数描述里；
不与其它工具重复规则。

## 4. 配置与诊断

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | false → 完全不安装工具 |
| `includeDelegatedAgents` | `false` | true → 子会话（delegationDepth>0）也安装该工具组 |

诊断文件：`$DSH_HOME/subagent-access-status.json`（best-effort，不影响功能）：

```json
{"activated":true,"pid":123,"config":{"enabled":true,"includeDelegatedAgents":false},
 "installed":["session-…"],"tools":["subagent_list","subagent_message","subagent_interrupt"]}
```

## 5. 与 Agent Team 的共存 / 已知限制（v1）

- 不重名 → 不冲突；Team 的 teammate 仍由 Team 工具管理，普通 subagent 由本插件管理；底层同为
  `ctx.subagents` 服务。
- **v1 不做 Team 成员过滤**：Team Lead 的 `subagent_list` 也会列出其 Team 成员（它们同样是子会话），
  `subagent_message` 也能送达，但会绕过 Team 的持久邮箱记账。M2 再决定是否按
  `ctx.agentTeams.tryMembership()` 过滤并从描述中提示。
- 冷启动/非 resident 子会话的 message 行为按官方服务语义（可能失败返回 `NOT_RESUMABLE` 等），不做额外伪造。

## 6. 验证计划

1. **单测**（`node --test test/*.test.mjs`）：
   - `catalog.js`：配置默认/非法值；目录 entry → 输出行映射（三种 mode、label 可选、状态映射）；
   - 插件：fake ctx（假 `agents`/`subagents`/`agent.ctx.tools.register`）验证安装目标筛选、
     写作用域/监听注册与释放、三工具 execute 的调用参数与返回、错误透传、fail-open。
2. **真实安装**：`plugin_manager install_bundle` → status 文件 → 当前会话 `Tool.listTools` 出现三工具。
3. **真实 E2E**（Lead 在本次会话执行并记录 seq）：
   - 派发一个 continuable 子会话执行长任务（bash sleep）→ `subagent_list` 看到 running；
   - `subagent_interrupt` 中止 → 状态回 inactive；
   - `subagent_message("结束并回报 OK")` → 子会话新回合 → 父会话收到 `agent-message`；
   - 对照：Team 的 `list_agents` / `send_message` 行为不变。
4. **回归**：两个既有包全部测试；liangshen 真实会话（若可）首轮仍 2 工具。

## 7. 未验证 / 风险

- 跨进程 / 父会话离线 / 冷恢复路径未实测（官方 README 声明的限制）。
- Team 成员记账绕过（§5）在 v1 接受。
- 工具面 +3：约 +1.5–2 KB schema；装在 root 会话，锚定首轮不受影响（bootstrap 只放双工具）。
- 回滚：`enabled:false` 或卸载 bundle；不写任何 DSH 安装目录。

## 8. M2（只设计，不实现）：liangshen 子 Agent 锚定语义实验

问题：v7 的 `includeSubagents: true`（[agent.cordis.yml:48-51,93-95,136-137]
(`file:///home/cna/DSHOptimizeMosire/packages/dsh-liangshen-anchored/presets/liangshen/agent.cordis.yml`)）
让子会话首请求也被锚定（2 工具 + 单行 persona）；DSH 官方 tool-bootstrap 默认相反（子会话视作已晋升）。
本机 427 个子会话无语料可参考（没有 liangshen 子会话）。

实验设计（待用户批准后执行）：

| 臂 | 配置 | 预期 |
|---|---|---|
| A | `includeSubagents: true`（v7 原样） | 子会话首请求 2 工具；首个信号后晋升 |
| B | `includeSubagents: false`（DSH 默认） | 子会话首请求即完整目录 |
| C | 保持锚定 + 给 depth>0 注入简短 delegation brief | 子会话首请求 2 工具 + 规则提示 |

- 任务集：同一组 6–12 个自包含委托任务（改文件、跑测试、调研各若干），固定模型/route；
- 指标：任务成功率、步数、token、首请求 wire（工具数/注入源）、失败模式；
- 判据：只有「A 显著差于 B/C」才考虑改默认值；否则保真优先（D-001）。
