# @mosire/dsh-goal-confirm

goal 自动续轮确认门（功能二）：官方 goal 续轮驱动即将注入一条自动续轮
（`source.kind === 'goal'` 且 `round > 0`）时，Host 插件在 `agent/pre-step`（`prepend`）
扣住本步，复用官方 `ctx.userQuestions` 与 Web `ask_user_question` 卡片请用户确认。

## 四种结果

| 用户动作 | 结果 |
|---|---|
| 「继续自动推进」 | 放行本轮，行为与未安装本插件一致 |
| 「取消并删除 goal」 | `ctx.goals.clear()` 删除 goal；驱动丢弃本轮，此后不再自动续轮 |
| 「本会话不再确认」 | 放行本轮，并把本会话的确认门关掉（写 `/goal-confirm off`，下一轮起不再弹卡） |
| 无操作（默认 30 秒，可配置；`0` = 等待人工） | 中断提问并自动继续；`0` 时保持等待，直到点选或本轮被停止 |
| 关闭卡片 | 默认等同取消并删除 goal（`cancelOnClose: true`）；置 `false` 时视为继续 |

卡片标题为「Goal 续轮」，正文含当前轮次/轮次上限、目标摘要与超时说明。
只拦截自动续轮：人工 `/goal`、普通人类消息、子代理（`delegationDepth > 0`）不弹卡片；
goal 须处于 `active` + `armed`，且轮次等于 `roundsStarted + 1`。

## 会话级开关（2026-10-24，D-024）

确认门除了 profile 级默认值，还支持**按会话覆盖**，三个入口写同一份状态：

| 入口 | 用法 |
|---|---|
| 斜杠命令 | `/goal-confirm`（查看三层状态）、`on`、`off`、`wait`、`timeout <0..3600>`、`reset` |
| 卡片第三项 | 「本会话不再确认」= `off` 并放行本轮 |
| Web UI | composer dock 的「续轮确认 · 默认/开/等待/关」小开关（client half 在 `@mosire/dshom`） |

- 有效配置 = 全局 `enabled`/`timeoutSeconds` 被会话覆盖逐字段合并；`cancelOnClose` 仍只由全局决定。
- `off`：本会话不弹卡，续轮直接走；`wait`（`timeoutSeconds: 0`）：弹卡但不自动继续。
- 状态权威是**会话日志**：每次 `/goal-confirm …` 由官方命令服务记录 `command/run { name, args }`，
  插件注册 `ctx.sessionProjections` 单元（key `goal-confirm`、`stateVersion: 1`）折叠它；
  resume/fork 后从日志重建，`wire.view` 把 `{enabled, timeoutSeconds, global}` 送给 Web。
- 没有 `commands` / `sessionProjections` 服务时（如无命令适配器的部署）回退到进程内 Map，仅当前进程有效。
- `wait` 在弹卡前检查 `typertGateway.hasLiveClient()`；明确无网页连接时直接放行，避免挂死。
- 全局 `enabled: false` 仍是硬关：插件不注册任何监听/命令，会话级 `on` 无法反向开启。

## 为什么复用 `ctx.userQuestions`

- **零新增浏览器代码**：弹窗就是随 DSH 安装的 `@deepseek-ai/dsh-client-ui-user-questions`，
  主题、双语、键盘操作与关闭语义由官方维护，插件只提供问题内容并等待回答；
- 会话级开关的 UI 也只用官方 `conversation.composer.dock` additive 槽，不替换宿主渲染器。

## 配置

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关；`false` 时完全不干预（也不注册命令/投影） |
| `timeoutSeconds` | integer，0..3600 | `30` | 无操作后自动继续的秒数；`0` = 等待人工 |
| `cancelOnClose` | boolean | `true` | 关闭卡片是否等同取消并删除 goal |

缺省值定义在 `lib/decision.js` 的 `DEFAULT_CONFIG`；在 bundle patch 里给 `dshom` 行传
`config.goalConfirm` 即可改全局默认（本包没有导出的 `Config` schema，Host 设置页不会生成表单）。

## 安装（Web profile）

```sh
# 与功能一相同的 bundle 安装方式（任选其一）
dsh plugin --profile web add link:/home/cna/DSHOptimizeMosire/packages/dsh-goal-confirm
# 或 GUI：plugin_manager install_bundle，target 用包目录绝对路径
```

装好后在 web profile 全局生效（所有会话/预设），只对 goal 自动续轮起作用；
无需选择预设，也没有浏览器端安装步骤（UI 开关随 `@mosire/dshom` 的 client half 提供）。

## 降级规则（永不卡死会话）

- `goals` / `userQuestions` 服务缺失、无可用 answerer、子代理、后台或无浏览器会话、
  超时、turn 取消 → 一律放行本轮（fail-open）；
- 会话级 `off` → 不弹卡；`wait` 且无 live client → 放行；
- 取消路径 `clear` 失败 → 重读 goal 后重试一次 → 仍失败则 `pause` → 再失败只记日志并放行；
- 卡片第三项写命令失败 → 回退内存写入 `off`，仍放行本轮；
- 同一轮重复进入 `pre-step` 由幂等集合去重，不重复弹卡片。

## 验证

- 诊断：插件以 best-effort 写 `$DSH_HOME/goal-confirm-status.json`
  （默认 `~/.dsh/goal-confirm-status.json`），记录最近一次处理结果（含 `effective`、`sessionState`
  或 `skipped: session-off / no-live-client`），供排障；文件不存在表示尚未触发。
- 单测：`node --test packages/dsh-goal-confirm/test/*.test.mjs`（53 项，2026-10-24）。
- 手动 E2E：建 goal（`maxGoalRounds=3`）→ 等自动续轮 → 卡片出现后依次验证：
  「继续自动推进」放行本轮；下一轮「取消并删除 goal」；第三项「本会话不再确认」后下一轮不再弹；
  `/goal-confirm wait` 后卡片不再自动继续；`reset` 恢复 30s；composer dock 开关与命令状态一致。
- **验证状态**：单测与临时 Host 激活见 `.superpowers/sdd/2026-10-24-goal-confirm-session-switch/`；
  真实 Web E2E 需重启 3080 Host 后执行。

## 已知限制

- 弹窗是**官方提问卡片**，不是自定义模态窗口，无倒计时圆环；
- 会话级状态依赖 `sessionProjections` 的自定义 key；投影 schema 是鸭子类型
  （只实现 `parse`/`safeParse`，本仓无 zod 依赖），上游若改用更多 Zod 能力需替换；
- 卡片/开关触发的命令会在会话里留下 `command/run`/`command/done` 记录（可见结果行），属预期审计面；
- 全局 `enabled:false` 是硬关，会话级 `on` 不能反向开启；
- 本会话覆盖会被 fork 的子会话继承（fork 复制日志前缀）。
