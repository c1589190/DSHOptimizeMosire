# goal 续轮确认门设计 · 功能二

> **状态**：设计已获用户裁定（2026-10-17：G-001=A 官方提问卡片 / G-002=A 全局 / G-003=A 关闭=取消删 goal / G-004=A 独立 bundle），本文为**待用户评审的 spec**。
> **关联**：`docs/agents/02-调研-goal续轮确认门.md`；决策记录 `.agents/notes/implemented/2026-10-17-goal-confirm-gate-scope.md`。
> **用户原话附录**见 §11。**本文不含实现代码**；实现须在 spec 评审通过并出实现计划后进行。

## 1. 目标

当 goal 自动续轮（`source.kind='goal' && round>0`）即将注入模型步时，在 Web UI 弹出**显式确认**：

- **确认** → 本轮照常继续（行为与未装插件一致）；
- **取消**（选择「取消并删除 goal」或关闭卡片）→ `ctx.goals.clear()` 删除 goal，本轮被驱动丢弃，此后不再自动续轮；
- **30 秒（可配置）无操作** → 自动继续；
- 后台会话 / 无浏览器连接 / 子代理 → 不阻塞而自动继续。

全局生效（web profile 所有会话与预设），独立 bundle，可单独启停。**不修改 DSH 源码**，不改官方 bundle 行。

## 2. 成功判据（验收；含负向用例）

| ID | 判据 | 验证方式 |
|---|---|---|
| A1 | 装包后行 `goal-confirm` 激活无 diagnostic | `plugin_manager` + `Config.listConfigs` |
| B1 | 有 goal 的会话出现自动续轮时，Web 端在 30s 内出现官方提问卡片（header「Goal 续轮」、含轮次/上限、两个选项） | 真实会话观察 + 截图/日志 |
| B2 | 选「继续」→ 本轮进入，模型收到标准 `<goal_round>` 提示；无额外副作用 | 会话 JSONL + 观察 |
| B3 | 选「取消并删除 goal」→ goal 被 clear（tombstone 事件）、本轮被驱动丢弃、不再自动续轮 | 会话 JSONL `goal/change` + 卡片刻移除 + 不再有 goal 轮 |
| B4 | 关闭卡片（不选）→ 同 B3（取消语义） | 真实会话观察 |
| B5 | 30s 无操作 → 卡片消失、本轮自动继续 | 真实会话 + 计时 |
| B6 | 会话在后台/无浏览器连接 → 30s 后自动继续（不挂死） | 后台会话测试 + 计时 |
| B7 | 子代理（`delegationDepth>0`）续轮 → 不弹卡片、直接继续 | 真实子代理或单测 |
| B8 | goal 非 `active+armed`（暂停/阻塞/完成）→ 不弹 | 单测 + 真实会话 |
| C1 | 配置 `enabled: false` → 完全不干预（行为与官方一致） | 单测 + 安装验证 |
| C2 | `timeoutSeconds` 可配置（如 5s）生效 | 单测 + 真实会话 |
| C3 | `cancelOnClose: false` → 关闭卡片视为继续（本轮放行、goal 保留） | 单测 |
| D1 | 缺少 `userQuestions` 服务 / 无 answerer / 非 root agent → 放行（fail-open），不挂死 | 单测 |
| D2 | `goals` 服务缺失或读取异常 → 放行 + 日志 | 单测 |
| E1 | 与功能一同装：liangshen 预设下同样生效；锚定首轮/晋升行为不受影响 | L2 联测（功能一验收回归） |

**负向用例**：普通人类消息、`/goal` 人工命令、非 goal 来源消息不触发；两个会话同时续轮互不阻塞；取消后重新创建 goal 可正常弹确认。

## 3. 非目标

- 自定义模态窗口 / 倒计时圆环（v2 可选，另行 spec）；
- 按 preset 限定挂载（v1 全局）；
- 跨重启持久化「已确认」状态（确认仅进程内、按轮次记忆）；
- 修改官方 `dsh-goal-round-driver` / `dsh-user-questions` / Client UI；
- 对**非自动**轮次（人工 `/goal`、首轮）弹窗。

## 4. 架构

**单 host 插件，无 client half**：复用官方 `@deepseek-ai/dsh-client-ui-user-questions` 卡片 UI（已随 Web profile 安装）。

```
packages/dsh-goal-confirm/
  package.json           # private, type:module, dsh.bundle.patch
  cordis.patch.yml       # - insert: [{ id: goal-confirm, name: '@mosire/dsh-goal-confirm' }]
  lib/index.js           # host plugin: export function apply(ctx, config); export const Config
  locale/{zh,en}.json    # 插件卡展示
  test/*.test.mjs        # node --test
  README.md NOTICE LICENSE
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: goal-confirm
      name: '@mosire/dsh-goal-confirm'
```

（配置缺省走 `Config` 默认值；需要改时在 patch 里给 `config` 或走 Web 设置页。）

**依赖关系**：无硬注入；事件回调时用 `ctx.get('goals')` / `ctx.get('userQuestions')` 可选获取（缺失即放行）。原因：宿主组合可能裁剪这些服务（TUI/headless），硬 `inject` 会让插件在无 goal 的部署里激活失败。

## 5. 拦截算法（伪代码）

```js
export const name = 'goal-confirm'
export const Config = /* { enabled: boolean, timeoutSeconds: number, cancelOnClose: boolean } */

export function apply(ctx, config) {
  if (!config.enabled) return
  const asked = new Set()          // `${sessionId}:${round}` 幂等，避免重复弹
  const confirmed = new Set()      // 已确认轮次

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const goals = ctx.get('goals')
    const questions = ctx.get('userQuestions')
    const submitted = messages.find(m => m.source?.kind === 'goal' && m.source.round > 0)
    if (submitted === undefined || goals === undefined || questions === undefined) return next()

    const round = submitted.source.round
    const key = `${agent.id}:${round}`
    if (confirmed.has(key)) return next()

    const goal = goals.get(agent)                       // 可能抛：捕获后放行
    if (!goal || goal.phase !== 'active' || goal.activation !== 'armed') return next()
    if (round !== goal.roundsStarted + 1) return next() // 交给驱动拒绝
    if ((agent.session?.header?.delegationDepth ?? 0) > 0) return next()

    if (asked.has(key)) return next()
    asked.add(key)

    const decision = await askWithTimeout(questions, { agent, signal, goal, round })
    if (decision === 'cancel') await cancelGoal(goals, agent)   // clear；失败降级为 pause
    else confirmed.add(key)
    return next()
  }, { prepend: true })
}
```

`askWithTimeout`：

1. 自建 `AbortController`，`timeoutSeconds` 后 abort（与 `payload.signal` 联动：turn 取消时一并 abort）；
2. `questions.ask({ questions: [...], agent, signal: controller.signal })`；
3. 结果映射：
   - 返回 answer 且选择「继续」→ `'continue'`；
   - 返回 answer 且选择「取消并删除 goal」→ `'cancel'`；
   - `ASK_CANCELLED`（用户关闭卡片）→ `cancelOnClose ? 'cancel' : 'continue'`；
   - `ASK_ABORTED`（超时或 turn 取消）→ `'continue'`（超时=继续；turn 取消时放行由框架处理）；
   - `DELEGATED_CALLER` / `NO_PROVIDER` / `CALLER_NOT_LIVE` → `'continue'`（fail-open + 日志）；
   - （`'skip'` 不复存在：关闭语义在 `cancelOnClose` 两态间是 cancel/continue 二者之一）
   - 其它异常 → 日志 + `'continue'`（**绝不因本插件卡死会话**）。

`cancelGoal`：`goals.clear(agent, { id: goal.id, revision: goal.revision })`；`STALE` 时重读一次再试；仍失败则 `goals.pause(...)`；再失败只记日志并放行（**不伪造成功**）。

## 6. 问题内容（中文文案 v1）

```json
{
  "header": "Goal 续轮",
  "id": "goal-round",
  "question": "第 {round} 轮（上限 {maxGoalRounds}）自动续轮：确认继续？",
  "detail": "目标：{objective 前 200 字}\n\n30 秒无操作将自动继续；关闭本卡片视为取消并删除 goal。",
  "options": [
    { "label": "继续（30 秒后自动继续）", "description": "放行本轮，行为与未启用确认门一致。" },
    { "label": "取消并删除 goal", "description": "删除当前 goal，本轮被丢弃，之后不再自动续轮。" }
  ]
}
```

- 推荐项放首位（官方 UI 约定）；`timeoutSeconds` 参与文案（模板替换）；
- 不加 `intent`（不是 plan-review；通用卡片流程即可）。

## 7. 配置（Config Schema）

| 键 | 类型 | 默认 | 校验 | 说明 |
|---|---|---|---|---|
| `enabled` | boolean | `true` | 布尔 | 总开关 |
| `timeoutSeconds` | number | `30` | 正整数，1..3600 | 无操作自动继续时长 |
| `cancelOnClose` | boolean | `true` | 布尔 | 关闭卡片是否等同取消并删 goal；`false` 时关闭视为继续 |

非法配置在激活期 fail-fast（`Config` schema 校验）。

## 8. 错误处理与降级

| 场景 | 行为 |
|---|---|
| `goals`/`userQuestions` 服务缺失 | 放行（不弹、不卡） |
| 用户关闭卡片 | `cancelOnClose=true` 删 goal；`false` 时视为继续（放行本轮、goal 保留） |
| 超时 / turn 取消 | 放行 |
| 子代理 / 非 root | 放行 |
| clear 失败 | 重读重试 → pause → 只记日志放行（如实记录） |
| 两次 pre-step 同轮 | `asked` 集合幂等，不重复弹 |
| 插件卸载/禁用 | 立即不再拦截（监听随 ctx 清理） |

## 9. 验证计划

**Spike（实现前，必须）**：
1. host 插件从 `agent/pre-step`（prepend）调 `ctx.userQuestions.ask()`，Web 端**匿名 live 请求**是否渲染为 composer 卡片（真实 Web 会话）；
2. 超时 abort 后卡片干净移除、不影响下一次提问；
3. 取消路径（clear → next()）驱动安静丢弃本轮、不 block 新 goal；
4. 后台无浏览器会话：ask 是否 30s 内超时（或提前跳过）。

**L0 单测**：结果映射（continue/cancel/skip/aborted/errors）、配置校验、幂等、`cancelOnClose` 两态、非 active/非 armed、round 不匹配、子代理放行、服务缺失放行。

**L1 安装**：`plugin_manager install_bundle` → 行激活无 diagnostic → `Config.listConfigs` 可见三字段。

**L2 真实会话 E2E**（手动/半自动）：
- 创建 goal（`maxGoalRounds=3`）→ 自动续轮时卡片出现 → 选「继续」→ 本轮完成；
- 下一轮卡片出现 → 选「取消并删除 goal」→ goal 清空（会话 JSONL `goal/change` clear tombstone）、不再续轮；
- 再建 goal → 本轮卡片出现 → 关闭卡片 → 同取消；
- 再建 goal → 30s（或临时配 5s）无操作 → 自动继续；
- 与功能一同装：liangshen 预设会话跑一遍功能一 B1/C1 断言不受影响。

**证据**：`.superpowers/sdd/2026-10-17-goal-confirm/evidence/`（卡片截图/日志/JSONL 摘要/计时）；未验证项如实标注。

## 10. 里程碑与风险

| 里程碑 | 任务 | 验收 |
|---|---|---|
| M0 | 4 项 spike（重点 1、3） | 卡片可见、超时/取消路径正确 |
| M1 | host 插件 + Config + 单测 | L0 绿 |
| M2 | 安装 + L2 E2E | A1/B1-B6/C1-C2 |
| M3 | 文档/状态/与功能一联测 | E1 + 证据归档 |

风险：

| 风险 | 缓解 |
|---|---|
| 匿名 live 请求可能不被官方卡片 UI 渲染 | spike 1 卡点；若不通 → 退回 `askTimed` + 合成 callId 可行性验证；再不通 → 升 G-001=B（自定义 client 窗口，另立 spec） |
| 无浏览器/后台会话 hold 30s 影响无人值守节奏 | 默认 30s 可配；后续可加「无活跃 Client 时跳过询问」优化（查 Host 能力后再定） |
| 用户关闭卡片与「取消」语义混淆 | 详情文案明确写「关闭本卡片视为取消并删除 goal」；`cancelOnClose` 可关 |
| 与 goal 驱动竞态（预约过期） | 只在 round==roundsStarted+1 且 armed 时弹；放行后交给驱动围栏最终裁决 |
| 与功能一同时安装的回归 | L2 联测；两包互不依赖 |

## 11. 用户原话附录（逐字，2026-10-17）

> 「你看，这就是我要说的第二个功能——当goal被注入的时候，在webui上弹一个显式的是否确认继续窗口，如果点确认才继续，点取消就给goal删了，经过30秒（可配置）后如果啥都没动，那就继续」

裁定（用户选择）：G-001=A 官方提问卡片；G-002=A 全局挂载；G-003=A 关闭卡片=取消并删 goal；G-004=A 独立 bundle。
