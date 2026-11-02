# 2026-10-24 · goal 续轮确认门：会话级开关（功能二扩展）

> **需求（用户原话，2026-10-24）**：「把当前项目里维护的 goal 30 秒等待改成可开可不开？最好能细化到特定 session」→ 调研后用户选定 **方案 C**：「开始吧，选 C」。
> 方案 C = 会话级覆盖（已规划的 B）+ Web UI 小开关（client half）。
> 关联：`docs/agents/02-调研-goal续轮确认门.md`、`docs/superpowers/specs/2026-10-17-goal-confirm-gate-design.md`、`.agents/notes/implemented/2026-10-17-goal-confirm-gate-scope.md`、`.agents/notes/implemented/2026-10-24-goal-confirm-session-switch.md`（D-024）。

## 1. 目标与非目标

**目标**

1. 确认门的三个旋钮可在**单个会话**内覆盖，而不只靠 profile 补丁：
   - `enabled`：本会话是否弹卡（`off` = 不弹、续轮直接走）；
   - `timeoutSeconds`：本会话的自动继续秒数；`0` = **不自动继续（等待人工）**；
   - `reset`：回到全局默认。
2. 三个入口共用同一份状态与同一条写路径：
   - 斜杠命令 `/goal-confirm on|off|wait|timeout <秒>|reset`；
   - 卡片第三选项「本会话不再确认」；
   - Web composer dock 的小开关（client half）。
3. 状态**可从会话日志重建**（resume / fork 后仍然有效），进程内内存只作回退。

**非目标**

- 不改全局 `enabled:false` 的「硬关」语义（插件根本不挂载，会话级 `on` 无法反向开启）；
- 不按 preset 限定；
- 不做自定义模态窗口，仍复用官方提问卡片。

## 2. 语义

| 输入 | 本会话覆盖 | 效果 |
|---|---|---|
| `/goal-confirm`（空） | 不变 | 输出全局/本会话/实际生效三层状态 |
| `/goal-confirm on` | `{enabled:true, timeoutSeconds:null}` | 弹卡；超时跟随全局 |
| `/goal-confirm off` | `{enabled:false, timeoutSeconds:null}` | 不弹卡，续轮直接进入 |
| `/goal-confirm wait` | `{enabled:true, timeoutSeconds:0}` | 弹卡且**不自动继续** |
| `/goal-confirm timeout 60` | `{enabled:true, timeoutSeconds:60}` | 弹卡，60s 后自动继续 |
| `/goal-confirm reset` | 清除覆盖 | 跟随全局默认 |
| 卡片第三项 | 等价 `off` | 关闭本会话确认门，并放行本轮 |

- 有效配置 = 全局 `enabled` / `timeoutSeconds` 被非空会话字段覆盖；`cancelOnClose` 仍只由全局决定。
- 全局 `timeoutSeconds` 的合法范围从 `1..3600` 放宽为 `0..3600`（`0` = 等待人工），默认仍为 30。
- 覆盖状态是「最后一个生效命令」：后一条命令整体替换前一条（`on` 会清掉 `wait` 的超时覆盖）。

## 3. 数据权威与实现

**会话日志是唯一权威。** DSH 不允许第三方插件写自定义 session event（`appendPluginRecord` 仅限 `packages/experimental/`，见 `dsh-session` README），因此不新造事件类型，而是复用一个**已经会被记录**的事件：`command/run`。

- 每次 `/goal-confirm …` 由官方 `@deepseek-ai/dsh-commands` 在 handler 之前追加
  `command/run { name: 'goal-confirm', args }`（`recordInput` 默认 true）；
- 插件注册一个 Host `ctx.sessionProjections` 单元：
  - key：`goal-confirm`；`stateVersion: 1`；
  - `init` → `{enabled:null, timeoutSeconds:null}`；
  - `apply` 只折叠 `command/run` 且 `name === 'goal-confirm'` 的事件，其余事件返回同一引用；
  - `wire.view` 输出 `{enabled, timeoutSeconds, global:{enabled, timeoutSeconds}}`，供 Web 端读取；
- 卡片第三项不直接改状态，而是调用 `ctx.commands.execute(agent, '/goal-confirm off', [], signal)`，
  保证同样产生 `command/run`（命令结果会成为一条可见记录，属于预期审计面）；
- `commands` 服务缺失时（例如无命令适配器的部署）回退到进程内 `Map`，仅当前进程有效；
- `sessionProjections` 缺失时同样回退到内存；
- 读取顺序：projection `stateOf(agent.session,'goal-confirm')` → 内存 → 默认。

**关键实现事实（已回代码核过）**

- `ctx.commands.execute(agent, line, attachments, signal)` 是公开服务方法；客户端侧同名 Remote 为
  `ctx.remote.commands.execute(sessionId, line, attachments)`（`@deepseek-ai/dsh-client-ui-commands` 用法）；
- 客户端投影存储按开放 key 空间工作：`session.projections.faceOf(key)` 对未知 key 返回稳定 face，
  缺失值为 `undefined`（`@deepseek-ai/dsh-api-session-controller` 的 `ProjectionValueStore`）；
- composer dock 的 standardProps 含 `sessionId` 与 `useProjection`（`Slots.listSubTree` 实测），
  适合放本开关；
- 官方卡片占用 composer seat（`dsh-client-ui-user-questions` README），所以开关必须同时做进卡片，
  不能让用户只能靠命令在 30s 窗口里抢输入。

## 4. UI 形态（方案 C 的 client half）

`conversation.composer.dock` 增加一个 `order: 4` 的条目（时间标注之后），内容是一个小按钮：

```
● 续轮确认 · 30s            ← 点击弹出（默认 / 等待 / 关 同位置显示）
   默认（跟随全局）
   开启（30s）
   等待人工确认
   本会话关闭
```

- 当前值来自 `useProjection('goal-confirm')`；`undefined` 时按全局默认渲染（避免闪烁）；
- 选中项用 `aria-checked` 标记；菜单用 `position: fixed` 按按钮矩形定位，向上弹，避免 dock 裁剪；
- 点击项调用 `ctx.remote.commands.execute(sessionId, '/goal-confirm …', [])`；
- 失败时在按钮旁显示一条错误文本，不假装成功；
- 文案走 `ctx.locale.register('goal-confirm', {zh,en})`，颜色只用 `--dsw-alias-*` token。

## 5. fail-open 与安全

- 本会话 `off` → 不弹卡、不阻塞；
- `wait`（`timeoutSeconds:0`）在弹卡前检查 `ctx.get('typertGateway')?.hasLiveClient?.()`：
  **明确为 false** 时直接放行本轮（无浏览器可答，不能挂死）；方法缺失或抛错时按「有客户端」处理；
- `ask()` 因 stop / 断连 / `ASK_ABORTED` 拒绝 → 放行（沿用现状）；
- `commands.execute` 失败 → 回退内存写入 `off`，仍放行本轮；
- 所有 gate 故障（projection 读失败、命令服务异常）都不得阻塞或删除 goal。

## 6. 已知风险 / 兼容性

1. **投影 schema 使用鸭子类型**：`stateSchema`/`viewSchema` 只需要 `.parse()`（`dsh-session-projection` 的
   实现只调用 parse），但类型契约声明为 ZodType。我们提供 `parse` + `safeParse` 的最小实现，
   并在决策记录中标注为可替换点；若上游改为更多 Zod 能力，需要换成真 zod。
2. **自定义 projection key** 不在 `SessionProjectionMap` 的编译期声明里；运行时按开放 key 空间工作，
   但这依赖框架未收紧 key 校验——实现后以真实会话验证 wire 值能到 Web。
3. 卡片/开关触发的 `/goal-confirm` 会在会话里留下 `command/run`/`command/done` 记录（可见结果行），
   这是刻意的审计面，不是副作用 bug。
4. resume/fork：投影在 resume 时从日志惰性重放；fork 复制前缀，因此子会话**继承**父会话的覆盖
   （若以后要「fork 重置」再改 `init` 判断 `header.parentSession`）。

## 7. 验收

- 单测：`node --test packages/dsh-goal-confirm/test/` 全绿，覆盖：
  - `timeoutSeconds:0` 合法、3601 非法；`resolveConfig` 覆盖合并；
  - 命令语法与 `foldCommand` 的引用稳定性；
  - 第三选项 → `command/run` + 放行本轮；
  - 本会话 `off` 不弹；`wait` 无计时器；无 live client 时 `wait` 放行；
  - 投影单元折叠 `command/run` 并输出 wire 值。
- 真实会话 E2E（需重启 3080 Host 后）：
  1. 建小 goal（`maxGoalRounds=2`）→ 卡片出现第三项；
  2. 选第三项 → 本轮继续，下一轮**不再弹卡**；会话日志有 `command/run name=goal-confirm args=off`；
  3. `/goal-confirm wait` → 下一轮卡片无 30s 自动继续；`/goal-confirm reset` 后恢复 30s；
  4. composer dock 开关显示当前状态；点击「本会话关闭/等待/默认」立即生效；
  5. resume 同一会话后覆盖仍生效（投影重放）。
- 证据落 `.superpowers/sdd/2026-10-24-goal-confirm-session-switch/evidence/`。
