# 2026-10-17 · goal 续轮确认门（功能二）的范围（proposed）

> 状态：**implemented（用户已裁定，2026-10-17）**。设计见 `docs/superpowers/specs/2026-10-17-goal-confirm-gate-design.md`（待评审）。
> 关联：`docs/agents/02-调研-goal续轮确认门.md`、根 `AGENTS.md` §一/§四/§七、`docs/superpowers/status/2026-10-17-initial-survey.md`。

## 1. 背景与用户原话（2026-10-17，逐字）

> 「你看，这就是我要说的第二个功能——当goal被注入的时候，在webui上弹一个显式的是否确认继续窗口，如果点确认才继续，点取消就给goal删了，经过30秒（可配置）后如果啥都没动，那就继续」

## 2. 已确认事实（回代码核过）

1. 自动续轮由官方 `@deepseek-ai/dsh-goal-round-driver`（0.2.0-rc.2，无配置）驱动；goal 服务 `ctx.goals` 提供 `pause/resume/clear` 等生命周期；
2. 驱动在 `agent/pre-step` 瀑布里先校验预约再 `await next()`；`prepend: true` 的监听可先于它扣住本步（Event 契约：`{kind:'reject'}` | `{kind:'enter', messages}`）；
3. 续轮消息 `source.kind='goal'` 且 `round > 0`，可精确识别；
4. Web 端已有 `@deepseek-ai/dsh-client-ui-user-questions`（ask_user_question 卡片 UI），支持**匿名 live 请求**；关闭卡片 = `ASK_CANCELLED`；`ctx.userQuestions.ask()` 可由 host 插件直接调用（需要 live root agent）；
5. 子代理（child agent）不允许发起人工交互（`DELEGATED_CALLER`）⇒ 子代理路径自动放行。

## 3. 选项与取舍

| ID | 问题 | 选项 | 建议 |
|---|---|---|---|
| G-001 | v1 UI 形态 | A 官方提问卡片（`ctx.userQuestions.ask`）/ B 自定义模态窗口（client 插件）/ C 先 A 后 B | **A**：零新增 UI 代码、复用官方双语卡片；B 作为后续观感升级 |
| G-002 | 挂载范围 | A 全局（web profile 所有会话）/ B 仅梁神预设 | **A**：这是一条 profile 级交互策略，与 agent preset 无关 |
| G-003 | 关闭卡片 | A 等同取消并删除 goal / B 仅放弃本轮保留 goal | **A**（与「点取消就删」一致） |
| G-004 | 交付形态 | A 独立 bundle / B 与功能一同一个 bundle | **A**：可单独启停、单独验证、失败不影响功能一 |

## 4. 裁定（2026-10-17）

- **G-001 = A（官方提问卡片）**；**G-002 = A（全局挂载）**；**G-003 = A（关闭卡片=取消并删 goal）**；**G-004 = A（独立 bundle）**。
- spec 已落盘待评审。

## 5. 影响面 / 后续任务

- 裁定后：设计（host 插件 `agent/pre-step` + `userQuestions` + Config）→ spec → writing-plans → 实现（含 spike 清单 5 项）；
- 若选 B：需额外 client bundle（slot 选择依据 `Slots.listSubTree`）、Host⇄Client 通道设计、浏览器验证；
- 需在 `docs/superpowers/specs/` 建独立 spec（与功能一的梁神复刻 spec 分开）；
- 与当前会话的关系：**实现前，本会话的 goal 续轮仍是官方行为（无确认门）**。
