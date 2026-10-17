# 2026-10-17 · 子 Agent 访问（功能三）的范围裁定

> 状态：**implemented（Lead 依用户 2026-10-17 授权直接实现）**。用户原话：「对于dsh已有的子Agent访问很显然做的是很糟糕的，你可以自己调查一下」+
> 「你说的这些问题我陆陆续续全都遇到过一遍了」+「出设计，提交并推送，然后开始实现」。
> 设计见 `docs/superpowers/specs/2026-10-17-subagent-access-design.md`；调查见 `docs/agents/03-调研-子Agent访问.md`。

## 已确认事实（回代码 + E2E 核过）

1. Web profile 顶层会话的 `send_message`/`list_agents`/`interrupt_agent`/`wait_agent` 被 host 层 Agent Team 版本占据
   （`~/.dsh/profiles/web/cordis.yml:1539,1547`），Team 目标解析只认 lead/active teammate
   （`dsh-experimental-agent-team/lib/index.js:350-361`）；
2. E2E：父会话 `send_message({target:<subagent id>})` → `active teammate "…" not found`；子→父 `agent-message` relay 通；
3. 427 个子会话语料中仅 10 个收到过任何后续消息；子会话强制继承父预设（`dsh-subagent/lib/index.js:470-480,510-511`）；
4. spawn 无父上下文、fork 不含 in-flight turn、观测弱（调研 §三）。

## 裁定

| ID | 问题 | 裁定 | 理由 |
|---|---|---|---|
| S-001 | 本轮实现范围 | **M1 仅父 → 子控制面三工具**（list/message/interrupt）；M2（liangshen 子 Agent 锚定语义实验）只写实验设计，不实现；R3（上下文接力）延后 | 控制面缺口有 E2E 铁证、只调官方 service、不依赖行为实验；锚定语义必须隔离对照后才能改（铁律 5） |
| S-002 | 交付形态 | **独立 bundle `@mosire/dsh-subagent-access`**（host 插件、全局挂载） | 与 goal-confirm 同构，可单独启停/回滚；不动两个既有 bundle |
| S-003 | 工具面 | **3 个工具**：`subagent_list` / `subagent_message` / `subagent_interrupt`，**刻意不与 Team 重名**；不加 prompt section；默认只装 root 会话（`delegationDepth===0`），`includeDelegatedAgents` 可扩 | 精准补缺口、最小工具面（agent-experience：总工作量最小）；避免与 Team 同名混淆 |
| S-004 | 实现边界 | 只调官方 `ctx.subagents.listChildren/sendMessage/interrupt` + `ctx.agents` 状态；**不复制 DSH 源码、不改 Team 行为、不改 `subagent` 工具描述** | 铁律 1；Team 同名工具是既有设计，不在本功能内处理 |
| S-005 | Team 成员 | v1 **不做 Team 成员过滤**（Team Lead 的 list 也会列出其 teammate；message 可送达但绕过 Team 持久邮箱记账）→ 列为已知限制，M2 再定 | 避免 v1 依赖 `ctx.agentTeams` 私有关系；先交付可验证的控制面 |

## 影响面 / 后续

- 验收：A1/B1–B6/C1–C3/D1/E1（spec §1.3）；真实 E2E 在本次会话做（spawn → list → interrupt → message）。
- 安装后工具面 +3（约 +1.5–2 KB schema），root 会话锚定首轮不受影响（bootstrap 只放双工具）。
- M2 实验（includeSubagents A/B/C）待用户批准后用隔离任务集执行，数据驱动是否偏离 v7 保真。
