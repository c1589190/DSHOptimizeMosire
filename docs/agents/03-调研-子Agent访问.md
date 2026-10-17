# 03 · 调研：DSH「子 Agent 访问」现状（2026-10-17）

> **缘起（用户原话，2026-10-17）**：「对于dsh已有的子Agent访问很显然做的是很糟糕的，你可以自己调查一下」
>
> 本文是**只读调查 + 本机真实会话语料实测**，不含实现与裁定；结论先行：
> **Web profile 下「父 → 子」的控制面是残缺的**——顶层会话里 `send_message` / `list_agents` /
> `interrupt_agent` / `wait_agent` 被 Agent Team 的同名工具占据，只能找 Team 成员，找不到普通
> `subagent` 子会话；而子 → 父的消息却通。配合「结算通知说 unless you send it more」与
> `subagent` 工具自述「可以继续用 send_message」，形成**承诺可用、实际不可用**的单向访问。
> 另一条主线是**子会话强制继承父预设**（无 per-child 选择），它决定了子会话能「访问」到多少工具与上下文；
> 对本项目功能一（梁神模式）意味着 `includeSubagents: true` 会把锚定原样压到子会话上（未实机验证，见 §6）。
>
> 调查日期：2026-10-17（Asia/Shanghai）。数据口径：本机 `~/.dsh/sessions/` 全量会话 + 本次派单实测。

## 一、机制事实（回代码核过）

### 1.1 子会话怎么创建、继承什么

- 创建：`@deepseek-ai/dsh-subagent-in-process-driver` 的 `startInProcessRun()` 通过
  `parent.ctx.agents.create({ sessionId, parentAgent, meta, … })` 建子会话
  （`…/dsh-subagent-in-process-driver/lib/index.js:161-190`）。
- 子会话 header 记录：`parentSession`、`origin: "subagent"`、`delegationDepth`、`isSeeded`、`cwd`、`agentPreset`
  （`…/dsh-subagent/lib/index.js:470-480`）。
- **预设强制继承父**：`childSessionMeta()` 用 `parent.ctx.get("agentPresets")?.composedPreset(parent.ctx)`
  写 `agentPreset`（同文件 `:472`），`applyChildComposition()` 让子 agent join 父的 preset composition
  （同文件 `:488-511`）。→ 子会话**没有**自己的预设选择；父选中什么，子就跑什么。
- 上下文：spawn 子会话是空会话（`isSeeded: false`，README「Fresh means no parent transcript」）；
  fork 子会话 seed = 父「已完成回合」快照，**不含发起委托的 in-flight turn**
  （`…/dsh-subagent-fork-in-process/README.md:36`）。
- 子会话额外拿到一条运行时委托声明 `SUBAGENT_DELEGATION_CONTEXT`（权限范围固定、不可在会话内扩宽，
  `…/dsh-subagent/lib/index.js:487`）。
- 权限：子继承父的 sandbox 覆盖与 `'never'` approval pin（driver README「What the child gets」）。

### 1.2 控制面：两套同名工具，顶层被 Team 遮蔽

- Web profile 在 **host 层全局**挂载 Agent Team：`@deepseek-ai/dsh-experimental-agent-team`
  与 `@deepseek-ai/dsh-experimental-tool-agent-team`（`~/.dsh/profiles/web/cordis.yml:1539,1547`），
  它们提供 `send_message` / `list_agents` / `interrupt_agent` / `wait_agent` / `spawn_teammate` / `team_task_*`。
- 同时预设组合里还挂 `@deepseek-ai/dsh-tool-subagent-control`（如本仓 `presets/liangshen/agent.cordis.yml`
  delegation 组），它也注册同名 `send_message` / `list_agents` / `interrupt_agent`，契约是「父 ↔ 直接 continuable 子」。
- 实际生效的是 Team 版本（工具描述原文证据见 §2.2）；Team 版本的 `send_message` 目标解析只认
  `lead` 或**活跃 teammate 名字**，否则报 `TEAM_MEMBER_NOT_FOUND`-类错误
  （`…/dsh-experimental-agent-team/lib/index.js:350-361`、`:767-774`）。
- 于是：**顶层会话可创建普通 `subagent` 子会话，但无法用 `send_message` 找它**；子会话不是 Team 成员，
  不注册 Team 工具，拿到的是 subagent-control 版本（同名不同契约）——子 → 父方向反而是通的。

### 1.3 配额、深度与持久性

- `maxDepth` 默认 **1**（子不能再委托孙）、`maxActiveSubagents` 默认 **8**（`…/dsh-subagent/lib/index.js:2822-2823`）。
- 续聊能力面（官方 service，可被插件调用）：`listChildren(parentSessionId)`（`:2971`）、
  `sendMessage(sender, targetId, …)`（`:2896`）、`interrupt(targetSessionId, …)`（`:2929`）。
- 限制（官方 README 自述）：跨进程无协调、父必须 live 才能收子消息、无 durable parent mailbox、
  接受但未落盘的消息崩溃后不重放、descendant 读取串行。

### 1.4 GUI 访问

- 普通会话侧栏**不列**子会话；入口是父会话 header 的 descendant catalog（`…/dsh-client-ui-subagent/README.md:12`），
  可逐层展开、看 running/token/时长、打开子会话（one-shot 只读，continuable 可继续）。
- 用户可配：Plugins → Subagent 页（最大递归深度、子 Agent 并发上限、子 Agent 模型路由）。

## 二、实测证据（2026-10-17，本机）

### 2.1 全量会话语料（`~/.dsh/sessions/`）

- 会话总数 **471**，其中 `origin: "subagent"` 的子会话 **427**，来自 **12** 个父会话（最多一个父会话 **173** 个子）。
- 子会话预设分布：**standard 406 / ptc 16 / cordis 3 / (none) 2**；抽查 7 个父会话全部 standard
  → 与「子继承父预设」的代码结论一致。
- 子会话首请求固定成本（均值）：

  | 子会话预设 | 工具数 | 工具 schema 字节 | system prompt 字符 | 首条 user prompt 字符 |
  |---|---|---|---|---|
  | standard (n=406) | 35.0 | 25,044 | 6,484 | 3,529 |
  | ptc (n=16) | 1 | 2,126 | **32,822** | 3,042 |
  | cordis (n=3) | 37.0 | 28,901 | 5,776 | 6,405 |

- standard 子会话平均 **120.1** 步、最多 **587** 步。
- **父 → 子后续消息极少**：427 个子会话里只有 **10 个**收到过任何后续消息
  （3 个收到 `agent-message` 共 10 条；7 个收到 `team-message` 共 15 条）。

### 2.2 本次派单（3 个子会话，`session-1799f35c…` 的子会话）

- 3 个子会话 header 均 `isSeeded: false`、`origin: subagent`、`delegationDepth: 1`、
  `agentPreset: "cordis"`（= 父会话当时的有效预设；父 header 记 standard，随后 `agent-preset/selected` 到 cordis）。
- 首条 prompt 由 Lead 手写：**4,602 / 6,314 / 8,300 字符**（spawn 无父上下文，只能靠 prompt 复述）。
- 顶层会话工具描述 = Team 版本（`send_message` 152 字符、`list_agents` 199 字符、`wait_agent` 259 字符）；
  子会话工具描述 = subagent-control 版本（`send_message` 169 字符「Send a message to an agent…」、
  `list_agents` 276 字符「List subagents you started…」）。同一会话树里**同名工具两套契约**。
- 决定性 E2E（本次会话直接调用）：父会话 `send_message({target: "7b872b21-…"})`
  → 报错 `Error: active teammate "7b872b21-2a7b-4d9d-893a-b914c20155fb" not found`。
- 反方向却通：3 个子会话的回报以 `source.kind: "agent-message"`、`form: "relay"` 落进父会话
  （父会话日志 seq 1145 / 1299 / 1320）。
- 结算通知原文（父会话 seq 1167）：
  「Background subagent 7b872b21-… finished and will do no further work **unless you send it more**.」
  → 通知承诺「可以再发」，但父方向实际发不出去。

### 2.3 与本项目功能一（梁神模式）的直接关系

- 子会话强制继承父预设 ⇒ 在 liangshen 会话里派出的子 Agent 也会跑梁神组合。
- 本仓 `presets/liangshen/agent.cordis.yml:48-51`（context-gate）与 `:93-95`（tool-bootstrap）、
  `:136-137`（instruction-hint）都设了 `includeSubagents: true`：
  按 `compaction-epoch.mjs:19-22,60-67` 的语义，子会话**首请求也会被锚定**（2 工具 + 单行 persona + 抑制自动注入），
  首个持久信号后才晋升。DSH 官方 `tool-bootstrap` 的默认恰恰相反（`includeSubagents` 缺省 = 子会话视作已晋升）。
  → 这是「保真 v7」与「子 Agent 可用性」的冲突点；**未实机验证**（见 §6，E1）。
- 反向代价：若保持 `includeSubagents: false`，子会话首请求即携带完整 40+ 工具目录（standard 子会话实测 35 工具 / 25 KB schema）。

## 三、问题清单（按严重度）

| 编号 | 问题 | 证据 | 影响 |
|---|---|---|---|
| P0-1 | **父 → 子控制面在 Web profile 被 Team 同名工具遮蔽** | §2.2 E2E 报错 + 工具描述 + 代码 | 不能 steer / list / interrupt / wait 普通子会话；`subagent` 描述与结算通知都声称可以 |
| P0-2 | **子会话强制继承父预设，无 per-child 选择** | `dsh-subagent/lib/index.js:470-480,510-511`；427 例子会话分布 | liangshen 下子会话被锚定（未实机）；ptc 下每个子会话白载 32.8 KB system prompt；无法按任务选轻/重子 Agent |
| P1-1 | **上下文接力断层**：spawn 零上下文；fork 不含 in-flight turn；无「交接包」机制 | 官方 README；本次 4.6–8.3 KB 手写 brief | 每次委托都要人工复述项目上下文，成本高、易漏；fork 在「边干边派」场景基本无用 |
| P1-2 | **可观测性弱**：父模型只见 final text / 结算通知；无进度、无子工具事件、无 token；GUI 入口藏在 header | 会话日志；client-ui-subagent README | 长任务（实测最多 587 步）无法中途干预/纠偏 |
| P2-1 | **能力面重叠**：顶层同时有 subagent / subagent_fork / spawn_teammate / wait_agent / workflow / ralph / job_*；子会话又拿到 depth=1 用不了的 subagent 工具 | 本次工具面 | 模型选择困难、schema 占上下文（顶层 47 工具 / 37.6 KB） |
| P2-2 | **持久性/跨进程限制**：父必须 live 才能收子消息；process-local 槽位；无 durable parent mailbox | 官方 README 限制节 | 长委托/重启后控制链断裂 |
| P2-3 | **权限固定且不可扩宽**：子继承父 sandbox 覆盖 + approval pin `'never'` | driver README；`:487` 委托声明 | 需要审批的操作在子会话里静默失败，只能回报「受限」 |

## 四、优化候选（都不改 DSH 源码；待裁定后立项）

- **R1 · 补齐父 → 子控制面（新 bundle，功能三候选）**
  Host 插件注册**不与 Team 重名**的工具（如 `subagent_list` / `subagent_message` / `subagent_interrupt`），
  直接调用官方 service：`ctx.subagents.listChildren(exec.agent.session.id)`、`ctx.subagents.sendMessage(exec.agent, targetId, …)`、
  `ctx.subagents.interrupt(targetId, …)`；按 sender 身份做授权（service 自带 lineage 校验）。
  与 Team 工具并存不冲突（不同名）。修 P0-1，成本中，风险=工具面再 +2~3。
- **R2 · liangshen 子 Agent 语义实验（功能一修正候选）**
  A) `includeSubagents: false`（子会话首请求即完整目录，对齐 DSH 官方默认）；
  B) 保持锚定但给 `delegationDepth > 0` 注入紧凑 delegation brief；
  C) 维持 v7 原样。需隔离对照（同一委托任务集，记录成功/步数/token/首请求 wire），证据优先。
- **R3 · 上下文接力约定/插件**
  委托时落 handoff 文件，或由插件把父 goal + 当前指令 + 关键路径注入子首请求；修 P1-1，成本中。
- **R4 · 使用面即时规避（无需代码）**
  Web profile 内需要多轮协作改用 `spawn_teammate`（Team 有消息、任务板、`wait_agent`）；
  `subagent` 只做一次性单发。可作为 AGENTS.md 的派单纪律。

## 五、待裁定

1. 「糟糕」具体指哪一层？P0-1 控制面 / P0-2 预设继承与锚定 / P1-1 上下文 / P1-2 可观测 / P2-1 能力面。
2. 是否把 **R1 立为功能三**（独立 bundle，纳入现有 spec/plan 体系）？
3. **R2** 是否本轮做隔离对照（会扩大功能一 T3/E1 范围）？
4. Web profile 的派单纪律是否改成「Team 优先」（写进根 AGENTS.md）？

## 六、未验证 / 限制

- **liangshen 子会话的锚定 wire 未实机验证**（E1）：需要在 Web 新建 liangshen 会话 → 派一次子 Agent → 读子会话日志；
  本机 427 个子会话中没有 liangshen 子会话。§2.3 的「子会话被锚定」是代码语义推论，不是实测。
- 语料仅本机；不同机器/项目结论可能不同。
- E2E 只证明了 `send_message`；`list_agents` / `interrupt_agent` / `wait_agent` 被 Team 占据由工具描述与挂载关系证明，未逐个 E2E。
- GUI 侧栏/目录行为只据官方 README + session 投影（父会话日志有 3 条 `subagent/catalog` 事件），未点开界面渲染验证。
- 长任务「587 步」来自语料统计，未逐会话审计其质量。

## 附录：证据复现

- 子会话语料统计（父会话/预设/工具面/首 prompt）：临时脚本（未入库）扫描
  `~/.dsh/sessions/*/*/session.v4.jsonl.zstd`，用本仓 `tools/verify-session.mjs` 的
  `splitZstdFrames` + `zstdDecompressSync` 解第一帧取 header；工具面取每个会话首个 `request/header`。
- 本次派单 3 个子会话：`~/.dsh/sessions/--home-cna-DSHOptimizeMosire--/{0c365980-…,7b872b21-…,93cbb7d2-…}/session.v4.jsonl.zstd`。
- 父会话（本次）：`…/session-1799f35c-e8f2-4ac2-a320-7cb59f91a405/session.v4.jsonl.zstd`（seq 1145/1167/1299/1320 为消息证据）。
- E2E 报错原文：`Error: active teammate "7b872b21-2a7b-4d9d-893a-b914c20155fb" not found`（2026-10-17 本次会话直接调用）。
- 官方限制原文：`…/dsh-subagent/README.md`、`…/dsh-tool-subagent/README.md`、`…/dsh-tool-subagent-control/README.md` 的
  Known Limitations and Deferred Work 节。
