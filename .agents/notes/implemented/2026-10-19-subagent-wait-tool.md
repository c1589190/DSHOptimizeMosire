# 决策记录：父→子 Agent 等待工具 `subagent_wait`（2026-10-19）

- **日期**：2026-10-19（用户：「给子Agent组件做一个Agent使用tool主动等待子Agent停下，然后自动返回最后一条消息的tool」）
- **状态**：implemented；单测 32/32；待 DSH 重启后在新会话实机验证。
- **背景**：现有父→子控制面只有 list/message/interrupt；后台子 Agent 的产出由 `subagent-settled` 消息异步送回，
  模型无法在同一个 step 内「等它跑完并拿结果」。

## 裁定 D-021

- 新工具 `subagent_wait`（第 4 个），参数 `child_id`（必需）、`timeout_seconds`（可选，0/省略=无限等待）。
- 行为：
  1. `subagents.listChildren(parentSessionId)` 校验 `child_id` 是**直接子会话**；
  2. live child 用官方 `agent.whenIdle()` 阻塞等待（无该方法时 500ms 轮询状态兜底）；父会话 `exec.signal` 中止等待；
  3. 超时返回 `{ status: 'timeout', childId }`，不伪造结果；
  4. 子 Agent idle 后从 live `ctx.sessions` 的 `snapshotEvents()`（或 `sessionQuery.readSession`）读取事件，
     返回最后一条**非空 assistant 消息** `{ role:'assistant', text, time }`；没有则省略 `lastMessage`；
  5. `timeout_seconds` 非数字/负数在工具调用时报错。
- 输出 schema：`{ status: 'inactive'|'timeout', childId, lastMessage? }`。
- 兼容性：0.2.1 不再随 dsh 提供 `@deepseek-ai/dsh-tools`，本地 `defineTool` 负责把紧凑 parameter/output spec 编译成 JSON Schema。

## 验证 / 限制

- 单测：`subagent-access 32/32`（新增 4 个 wait 用例），liangshen 76/76、goal-confirm 30/30。
- 待验：DSH 重启后新会话实际出现 `subagent_wait`；对运行中子 Agent 的阻塞与最后消息内容在真实会话中确认。
- 超时只停止等待，不中断子 Agent（需要停止请用 `subagent_interrupt`）。
