# @mosire/dsh-goal-confirm

goal 自动续轮确认门（功能二）：官方 goal 续轮驱动即将注入一条自动续轮
（`source.kind === 'goal'` 且 `round > 0`）时，Host 插件在 `agent/pre-step`（`prepend`）
扣住本步，复用官方 `ctx.userQuestions` 与 Web `ask_user_question` 卡片请用户确认。

## 四种结果

| 用户动作 | 结果 |
|---|---|
| 「继续自动推进」 | 放行本轮，行为与未安装本插件一致 |
| 「取消并删除 goal」 | `ctx.goals.clear()` 删除 goal；驱动丢弃本轮，此后不再自动续轮 |
| 无操作（默认 30 秒，可配置） | 中断提问，自动继续本轮 |
| 关闭卡片 | 默认等同取消并删除 goal（`cancelOnClose: true`）；置 `false` 时视为继续 |

卡片标题为「Goal 续轮」，正文含当前轮次/轮次上限、目标摘要与超时说明。
只拦截自动续轮：人工 `/goal`、普通人类消息、子代理（`delegationDepth > 0`）不弹卡片；
goal 须处于 `active` + `armed`，且轮次等于 `roundsStarted + 1`。

## 为什么复用 `ctx.userQuestions`

- **零新增浏览器代码**：本包是单 Host 插件，没有 client half；
- **官方卡片 UI**：弹窗就是随 DSH 安装的 `@deepseek-ai/dsh-client-ui-user-questions`，
  主题、双语、键盘操作与关闭语义由官方维护，插件只提供问题内容并等待回答。

## 配置

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关；`false` 时完全不干预 |
| `timeoutSeconds` | integer，1..3600 | `30` | 无操作后自动继续的秒数；非法值在激活期报错 |
| `cancelOnClose` | boolean | `true` | 关闭卡片是否等同取消并删除 goal |

缺省值定义在 `lib/index.js` 的 `Config`；可在 bundle patch 里传入 `config`，或经 Host 设置面修改。

## 安装（Web profile）

```sh
# 与功能一相同的 bundle 安装方式（任选其一）
dsh plugin --profile web add link:/home/cna/DSHOptimizeMosire/packages/dsh-goal-confirm
# 或 GUI：plugin_manager install_bundle，target 用包目录绝对路径
```

装好后在 web profile 全局生效（所有会话/预设），只对 goal 自动续轮起作用；
无需选择预设，也没有浏览器端安装步骤。

## 降级规则（永不卡死会话）

- `goals` / `userQuestions` 服务缺失、无可用 answerer、子代理、后台或无浏览器会话、
  超时、turn 取消 → 一律放行本轮（fail-open）；
- 取消路径 `clear` 失败 → 重读 goal 后重试一次 → 仍失败则 `pause` → 再失败只记日志并放行；
- 同一轮重复进入 `pre-step` 由幂等集合去重，不重复弹卡片。

## 验证

- 诊断：插件以 best-effort 写 `$DSH_HOME/goal-confirm-status.json`
  （默认 `~/.dsh/goal-confirm-status.json`），记录最近一次处理结果，供排障；文件不存在表示尚未触发。
- 单测：`node --test packages/dsh-goal-confirm/test/`。
- 手动 E2E：建 goal（`maxGoalRounds=3`）→ 等自动续轮 → 卡片出现后依次验证：
  「继续自动推进」放行本轮；下一轮「取消并删除 goal」（会话 JSONL 应出现 `goal/change` clear）；
  关闭卡片；无操作超时自动继续（可临时配 `timeoutSeconds: 5`）。
- **验证状态**：代码与单测（由实现方/Lead 记录）；真实会话 E2E 结果以仓库状态存档为准。

## 已知限制（v1）

- 弹窗是**官方提问卡片**，不是自定义模态窗口，无倒计时圆环（v2 可另行 spec）；
- 全局挂载（web profile），暂不支持按 preset 限定；
- 确认状态（幂等集合）只在进程内、按轮次记忆，不跨重启持久化；
- 以下边界尚未验证，勿据本文推断：后台/无浏览器会话的超时表现、与功能一（梁神锚定）
  同时安装的联测、会话恢复/fork 后的行为。以上均以真实会话与仓库状态存档为准。
