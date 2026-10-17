# @mosire/dsh-subagent-access

子 Agent 访问（功能三 M1）：在**顶层会话**补回「父 → 子」控制面。
三个工具只调用官方 `ctx.subagents` 服务与 `ctx.agents` 状态，不复制 DSH 源码、
不改 Agent Team 行为。

## 为什么需要它

Web profile 在 host 层全局挂载 Agent Team，其 `send_message` / `list_agents` /
`interrupt_agent` 只认 Team 的 lead 与 active teammate（证据见
`docs/agents/03-调研-子Agent访问.md` §2.2）。普通 `subagent` / `subagent_fork`
子会话不是 Team 成员，于是顶层会话能派子会话，却**列不出、发不进、停不下**。
本包用**不与 Team 重名**的三个工具补上这条路径：

| 工具 | 做什么 | 参数 | 返回 |
|---|---|---|---|
| `subagent_list` | 列出本会话启动的直接子会话；id / 可选 label / 生命周期模式 / 实时状态 | 无 | `{children:[{id,label?,mode,status,createdAt}]}` |
| `subagent_message` | 给本会话启动的子会话发一条后续消息；运行中的子会话在最近 step 边界收到，idle 的 continuable 子会话启动新回合，one-shot 不可续 | `child_id`、`message`（均必填） | `{messageId}` |
| `subagent_interrupt` | 中断本会话启动的子会话当前回合；子会话保留可继续，其后代继续运行 | `child_id`（必填） | `{previousStatus:"running"\|"inactive"}` |

- 状态只有两档：`running` = 该 Agent 正在执行回合；其余（idle、已释放、从未驻留）
  一律 `inactive`。
- 工具错误直接透传官方服务语义（如 `NOT_RESUMABLE` / `UNAUTHORIZED` /
  `PARENT_UNAVAILABLE`），不吞异常、不改写错误。
- 本包**不加任何 system-prompt section**，默认只装 root 会话，因此不改变
  liangshen 首轮锚定的 wire 形状。

## 安装（Web profile）

先在工作区建立官方包 symlink farm（无 npm 依赖、无构建步骤）：

```sh
node tools/link-dsh-peers.mjs
```

再按既有 bundle 方式安装（任选其一）：

```sh
# GUI：plugin_manager install_bundle，target 用包目录绝对路径
dsh plugin --profile web add link:/home/cna/DSHOptimizeMosire/packages/dsh-subagent-access
```

装好后在 web profile 全局生效（所有会话/预设），无需选择预设，也没有浏览器端
步骤；卸载或 `enabled:false` 即回滚。

## 配置

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关；`false` 时不安装工具、不注册监听 |
| `includeDelegatedAgents` | boolean | `false` | `true` 时子会话（`delegationDepth > 0`）也安装该工具组 |

缺省值定义在 `lib/catalog.js` 的 `normalizeConfig`；可在 bundle patch 的
`config` 里传入，或经 Host 设置面修改。未知键 / 非布尔值在激活期抛错。

## 诊断

插件以 best-effort 写 `$DSH_HOME/subagent-access-status.json`
（默认 `~/.dsh/subagent-access-status.json`）：

```json
{"activated":true,"pid":123,"config":{"enabled":true,"includeDelegatedAgents":false},
 "installed":["session-…"],"tools":["subagent_list","subagent_message","subagent_interrupt"],
 "at":"2026-10-17T00:00:00.000Z"}
```

- `installed` 是当前已安装工具的会话 id 列表；
- `reason:"disabled"` / `reason:"missing-services"` 记录未安装原因（服务缺失时另有
  `missing` 数组）；
- 写文件失败（只读 `DSH_HOME` 等）只忽略，绝不影响工具。

## 与 Agent Team 的共存 / 已知限制（v1）

- 不与 Team 重名 → 不冲突：Team teammate 仍由 Team 工具管理，普通子会话由本包管理，
  底层同为 `ctx.subagents` 服务。
- **v1 不做 Team 成员过滤**：Team Lead 的 `subagent_list` 也会列出其 Team 成员
  （它们同样是子会话），`subagent_message` 也能送达，但会绕过 Team 的持久邮箱记账。
  M2 再决定是否依赖 `ctx.agentTeams.tryMembership()` 过滤。
- 冷启动 / 非驻留子会话的 `subagent_message` 行为完全按官方服务语义（可能返回
  `NOT_RESUMABLE` 等），本包不伪造成功。
- 跨进程、父会话离线、durable parent mailbox 等官方限制同样适用；父会话必须
  live 才能收到子会话回报（见官方 `@deepseek-ai/dsh-subagent` README 的限制节）。

## 验证

```sh
cd packages/dsh-subagent-access
node --check lib/index.js
node --check lib/catalog.js
node --test test/*.test.mjs
```

单测覆盖：安装目标筛选（root / delegated / `includeDelegatedAgents`）、
`enabled:false`、三工具的 execute 参数与返回值、错误透传、`agent/created` /
`agent/disposed` 与插件卸载的 disposer 释放、`subagents` 缺失 fail-open。
**实现方只跑了单测；bundle 安装与真实会话 E2E 由 Lead 按
`docs/superpowers/plans/2026-10-17-subagent-access.md` Task 4 执行**，
本文不声称安装或 E2E 已通过。

## 设计来源

- 设计：`docs/superpowers/specs/2026-10-17-subagent-access-design.md`（M1）
- 计划：`docs/superpowers/plans/2026-10-17-subagent-access.md`
- 调查：`docs/agents/03-调研-子Agent访问.md`
- 决策：`.agents/notes/implemented/2026-10-17-subagent-access-scope.md`
