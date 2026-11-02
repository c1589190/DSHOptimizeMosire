# 2026-10-24 · 状态：goal 确认门会话级开关（D-024）

> 跨会话开工先读本文件，再看 `docs/superpowers/specs/2026-10-24-goal-confirm-session-switch-design.md`
> 与 `.agents/notes/implemented/2026-10-24-goal-confirm-session-switch.md`。

## 做了什么

功能二（`@mosire/dsh-goal-confirm`）从「profile 级开关」扩展为「profile 默认 + 会话级覆盖」：

- `/goal-confirm` 命令：`on` / `off` / `wait` / `timeout <0..3600>` / `reset`；bare = 三层状态。
- 卡片第三项「本会话不再确认」：写 `off` 并放行本轮。
- `@mosire/dshom` 的 composer dock 开关：「续轮确认 · 默认/30s/等待/关」菜单。
- 状态由会话日志 `command/run` 经 `sessionProjections` key `goal-confirm` 折叠；`wire.view` 给 Web。
- `timeoutSeconds: 0` = 等待人工（不再自动继续）；`wait` 无 live client 时直接放行。
- 全局 `enabled:false` 仍是硬关。

## 验证状态

| 层 | 结果 |
|---|---|
| 单测 | ✅ `node --test packages/dsh-goal-confirm/test/*.test.mjs` → 53/53，exit 0 |
| 其它套件回归 | ✅ job-tools / liangshen-anchored / subagent-access 均 `fail 0` |
| 临时 3099 Host | ✅ 新进程激活（status `activated:true,pid:804895`），无 goal-confirm 告警；client bundle 可取且 `node --check` 通过 |
| 真实 projection 服务 | ✅ 真实 `SessionProjectionRegistry` + `Session` 上验证 off/wait/reset、wire 值、checkpoint、restore；抓到并修掉 `wire.viewSchema` 嵌套 bug |
| 真实 3080 Web E2E | ❌ **未做**（当前 Host 仍是旧进程） |

## 下一步（重启 3080 Host 后）

1. 建小 goal（`maxGoalRounds=2`）→ 卡片出现第三项；
2. 选第三项 → 本轮继续，下一轮不弹；JSONL 有 `command/run name=goal-confirm args=off`；
3. `/goal-confirm wait` → 下一轮卡片无自动继续；`/goal-confirm reset` 恢复 30s；
4. composer dock 开关显示当前状态，点击「本会话关闭/等待/默认」立即生效；
5. resume 同一会话后覆盖仍生效（投影重放）；
6. 检查 `~/.dsh/goal-confirm-status.json` 出现 `effective` / `sessionState` / `skipped`。

## 回滚

- 只回滚会话级行为：保留 bundle，把 `dshom` 配置的 `goalConfirm.enabled` 置 `false`（硬关，旧行为是"没有确认门"）。
- 只想回到「全局 30s、无会话开关」：git revert 本次相关提交（`packages/dsh-goal-confirm/lib/*`、`packages/dshom/client.js`、
  `packages/dsh-goal-confirm/README.md`、locale、docs）。
- 投影 key 若未来冲突：改 `SESSION_PROJECTION_KEY` 并 bump `SESSION_STATE_VERSION`。
