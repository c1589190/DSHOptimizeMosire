# 02 · 调研：goal 续轮确认门（功能二，2026-10-17）

> **需求（用户原话，2026-10-17）**：
> 「你看，这就是我要说的第二个功能——当goal被注入的时候，在webui上弹一个显式的是否确认继续窗口，如果点确认才继续，点取消就给goal删了，经过30秒（可配置）后如果啥都没动，那就继续」
>
> 结论先行：**可行，且不需要改 DSH 源码**。官方设施已经齐全：`dsh-goal-round-driver`（续轮驱动）+ `agent/pre-step` 瀑布（可拦截）+ `ctx.userQuestions` / `dsh-client-ui-user-questions`（现成的 Web 确认卡片 UI）。
> 本文是只读调研 + 方案对比，**未写实现代码、未安装任何 bundle**。

## 一、自动续轮是怎么发生的（回代码核过）

官方包（均随 DSH 0.2.0-rc.2 安装）：

| 包 | 作用 |
|---|---|
| `@deepseek-ai/dsh-goal` | 目标状态服务 `ctx.goals`：`active/paused/blocked/complete` 四相位 + 进程内 `armed/disarmed` 续轮开关；事件溯源，会话日志唯一权威 |
| `@deepseek-ai/dsh-goal-round-driver` | 续轮驱动（**无配置**）：agent 空闲且 goal `active+armed` 且有轮次余量时，队列一条 `<goal_round>` 提示 |
| `@deepseek-ai/dsh-tool-goal` | 模型侧 `get_goal/update_goal` 工具（我的当前 goal 就来自它） |
| `@deepseek-ai/dsh-command-goal` | 用户侧 `/goal` 命令 |
| `@deepseek-ai/dsh-client-ui-goal` | Web 端 GoalBar（goal 编辑/暂停/恢复/清除） |

驱动关键行为（`dsh-goal-round-driver/README.md` + `lib/index.js`）：

1. **预约 → 入待办**：空闲时预留 `roundsStarted+1`，把一条 `source.kind='goal'`、带 `goalId/revision/round` 的消息放进 agent inbox；
2. **竞态围栏**：在 `agent/pre-step` 里**先**校验预约（goal 仍 `active+armed`、revision 匹配、round == roundsStarted+1），校验通过才 `await next()` 放行；
3. **轮次计数**：只有真正进入历史的 `user/message` 才消耗轮次；人类消息/过期预约不消耗；
4. **取消/暂停/阻塞**抑制续轮；会话恢复/fork 后 active goal 默认 **disarmed**，需显式 resume。

## 二、拦截点：`agent/pre-step`（回代码核过）

Event 契约（本机 Inspect 查询）：

```
'agent/pre-step' (waterfall)
payload: { agent, messages: UserMessage[], turn, step, signal }
next(): Promise<PreStepDecision>
PreStepDecision = { kind: 'reject' } | { kind: 'enter', messages, startsRequestSeries?: true }
```

- 驱动自己注册的 `agent/pre-step` 监听**先校验再 next()**；
- 瀑布的 after-next 变换按注册逆序执行，`prepend: true` 可让本插件监听成为最外层——**在我们的监听里等待用户确认，确认后才 `next()`，驱动才开始校验**；
- 取消路径：先 `ctx.goals.clear(agent, ref)`，再 `next()` ⇒ 驱动看到 goal 已清 ⇒ 判预约无效 ⇒ `{kind:'reject'}` + 恢复其它 claimed 消息；（不自己造 reject，避免和驱动的恢复逻辑打架）。
- 只拦「自动续轮」：`message.source.kind === 'goal' && source.round > 0`；人工 `/goal`、人类消息、子代理普通消息不受影响。

## 三、弹窗：复用官方 userQuestions（回代码核过）

`ctx.userQuestions`（`@deepseek-ai/dsh-user-questions`）：

| 方法 | 用途 |
|---|---|
| `ask(request): Promise<AskUserQuestionAnswer>` | 向「作用域 answerer 瀑布」提问并等待回答；请求带 live root agent 时由 Web 客户端卡片回答 |
| `askTimed(request, callId, timeoutMs)` | 计时等待，超时返回 `{pending:true, callId}`（需要 tool call 身份） |

Web 端 `@deepseek-ai/dsh-client-ui-user-questions`：**ask_user_question 的现成卡片 UI**（composer 占位、选项/自定义输入、关闭=取消）。关键语义（README 原文）：

- 卡片有两个来源：「A live Host request creates it and carries the answer back」+ Session projection；**无 tool-call 的匿名 live 请求也能渲染**（README：「a request that carries no tool call has no row to return from, so closing it rejects the whole wait as `ASK_CANCELLED`」）；
- 关闭卡片 = 取消等待（`ASK_CANCELLED`）；本插件用**自己的 AbortSignal + 30s 定时器**中断 `ask()`（`ASK_ABORTED`）实现「无操作→继续」；
- 不需要 `askTimed` 的合成 callId（合成 callId 没有 projection 行，卡片移除语义有风险）。

⇒ 功能二的 v1 **不需要自写客户端 UI**；如用户坚持要「模态窗口」观感，v2 再加自定义 client 插件（`shell.overlay` / composer 卡片），见 §五方案 B。

## 四、方案对比

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| **A. 官方卡片 + pre-step 扣住（推荐 v1）** | host 插件 `prepend` 监听 `agent/pre-step` → `ctx.userQuestions.ask()`（选项：继续 / 取消并删除 goal）→ 确认/30s 超时放行，取消 `ctx.goals.clear` 后放行 | 零新增 UI 代码；复用官方卡片（双语/键盘/主题）；改动面最小 | 观感是 composer 卡片不是「窗口」；关闭卡片=取消（需在问题文案里说清） |
| **B. 自定义模态窗口** | host 插件 + client 插件（`shell.overlay` 或 composer 卡片插槽），host 经 session command/Remote 与 client 通信 | 完全符合「窗口」预期；可做倒计时 | 需自写 client bundle + Host⇄Client 通道；验证成本高 |
| **C. 暂停/恢复竞速** | 监听 idle 先 `goals.pause()`，弹窗后确认再 `resume()` | 不改 pre-step | 与驱动抢 `agent/status` 顺序，竞态不可证明；不推荐 |

**推荐路线：A 先落地（P0），B 作为 P1 观感升级（若用户要求）。**

## 五、v1 语义表（待确认）

| 用户动作 | 行为 |
|---|---|
| 点「继续」 | 放行本轮（行为与未装插件完全一致） |
| 点「取消并删除 goal」 | `ctx.goals.clear(agent, ref)` → 本轮被驱动丢弃 → 之后不再自动续轮 |
| 关闭卡片（X） | 与取消同义：删除 goal（沿用官方「关闭=ASK_CANCELLED」） |
| 30s 无操作 | **视为继续**（AbortSignal 中断 ask，放行本轮；卡片刻移除） |
| 会话后台/无浏览器 | 同样 30s 后自动继续（无卡片可答） |
| 子代理 | 官方限制：child agent 不能发起人工交互 ⇒ 捕获 `DELEGATED_CALLER` 直接放行（不弹、不阻塞） |
| 暂停/阻塞/非 active goal | 不进入本插件逻辑 |

配置项（插件 Config，Web 设置页可改）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `timeoutSeconds` | `30` | 无操作自动继续时长（正数） |
| `cancelOnClose` | `true` | 关闭卡片是否等同删除 goal（关掉则只放弃本轮、保留 goal） |
| `scope` | `all` | `all` 全局会话 / `preset` 仅指定预设（若做成 preset 内行） |

## 六、spike 清单（实现前必须验证）

1. host 插件从 `agent/pre-step`（prepend）里调 `ctx.userQuestions.ask()`，Web 端**匿名 live 请求**是否真的渲染为 composer 卡片（本机桥接/Remote 路由）；
2. 30s AbortSignal 中断后，客户端卡片是否干净移除、不影响下一轮提问；
3. 取消路径（clear goal → next()）后驱动是否安静丢弃该轮、不 block 新 goal；
4. 与会话恢复/fork 的交互：active goal 恢复后默认 disarmed，不应弹窗；
5. 无浏览器/后台会话：ask 是否在 30s 内超时而不挂死（或直接跳过 ask 更优——可先查 `ctx` 是否有「当前有无 Client」的能力）。

## 七、待裁定

| ID | 问题 | 选项 | 建议 |
|---|---|---|---|
| G-001 | v1 UI 形态 | A 官方提问卡片 / B 自定义模态窗口 / C 先 A 后 B | **A**（零 UI 代码，最快可用）；B 作后续观感升级 |
| G-002 | 挂载范围 | A 全局（所有会话/预设）/ B 仅梁神预设内 | **A**：这是 profile 级交互策略，与预设无关 |
| G-003 | 关闭卡片语义 | A=取消并删 goal / B=仅放弃本轮 | **A**（与用户「点取消就删」一致） |
| G-004 | 与功能一的关系 | A 独立 bundle / B 同一个 bundle 两个 patch 行 | **A** 独立包（可单独启停） |
