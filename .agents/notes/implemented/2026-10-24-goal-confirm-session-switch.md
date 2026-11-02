# 2026-10-24 · goal 续轮确认门的会话级开关（D-024）

> **状态**：implemented（用户 2026-10-24「开始吧，选 C」）。
> **需求原话（2026-10-24）**：「能不能把当前项目里维护的 goal 30 秒等待改成可开可不开？最好能细化到特定 session，有办法吗？先调查，告诉我怎么办」
> 调研后用户选 **方案 C** = 会话级覆盖 + Web UI 小开关。
> 关联：`docs/agents/02-调研-goal续轮确认门.md`、`docs/superpowers/specs/2026-10-17-goal-confirm-gate-design.md`、
> `docs/superpowers/specs/2026-10-24-goal-confirm-session-switch-design.md`、`.agents/notes/implemented/2026-10-17-goal-confirm-gate-scope.md`。

## 1. 问题

功能二（`@mosire/dsh-goal-confirm`）只有 profile 级配置：`enabled` / `timeoutSeconds`（1..3600）/
`cancelOnClose`，改动要写 `~/.dsh/profiles/web/cordis.patch.yml`，且对所有会话一起生效。
用户要把「30 秒无操作自动继续」改成**可开可不开**，并细化到**特定会话**。

## 2. 调研结论（回代码/接口核过）

1. DSH **没有 per-session 插件配置层**：`ctx.settings` 的 `describe/update(ns)` 的 `ns` 是 profile entry id
   （Inspect `Service.settings`），`dsh-settings` README 也写明表单按 profile entry 组织。
2. 官方自己的 per-session 控制走 **slash command**（`/goal`、`/permission`）：命令直接作用于当前 agent，
   不经模型，并由 `@deepseek-ai/dsh-commands` 在 handler 前追加 `command/run`（含 `name`、`args`）、
   handler 后追加 `command/done`（`dsh-commands` 源码 `lib/types/index.js`；`SessionEventMap` 类型）。
3. 第三方插件**不能写自定义 session event**：`appendPluginRecord` 仅限 `packages/experimental/` 的包
   （`dsh-session` README / 源码注释），`Session.append` 对未知类型在重开时会被拒。
4. 客户端读会话派生值走 **session projection 的 `wire.view`**（`practices.md` 第 38 行）；
   客户端投影存储 `faceOf(key)` 对未声明 key 返回稳定 face，缺失值为 `undefined`
   （`@deepseek-ai/dsh-api-session-controller` 的 `ProjectionValueStore`）。
5. composer dock 的 standardProps 含 `sessionId` 与 `useProjection`（`Slots.listSubTree` 实测），
   官方提问卡片会占用 composer seat（`dsh-client-ui-user-questions` README），因此卡片内也要给入口。
6. 插件当前没有导出 `Config` schema：`Config.listConfigs` 显示 `include:dshom` `status:absent`，
   README 里「或经 Host 设置面修改」一句是超前描述（本次一并修正）。

## 3. 裁定 D-024 = C

- **D-024**：为确认门增加**会话级覆盖**，三个入口共用同一状态与写路径：
  1. `/goal-confirm on|off|wait|timeout <秒>|reset`（`commands.register`，全局注册、作用于当前 agent）；
  2. 卡片第三选项「本会话不再确认」（等价 `off` 并放行本轮）；
  3. Web composer dock 小开关（client half，读投影、写命令）。
- 状态权威 = **会话日志**：复用 `command/run` 事件，注册 `sessionProjections` 单元
  `goal-confirm`（`stateVersion:1`）折叠它；`wire.view` 给客户端。
  无 `sessionProjections` / `commands` 时回退到进程内 Map（仅当前进程）。
- 全局 `timeoutSeconds` 放宽为 `0..3600`，`0` = 等待人工（不自动继续）。
- `wait` 在弹卡前检查 `typertGateway.hasLiveClient()`；明确为 false 时直接放行，避免无浏览器会话挂死。
- 全局 `enabled:false` 仍是硬关（插件不挂载，会话级 `on` 不反向开启）。

## 4. 实现落点

| 文件 | 改动 |
|---|---|
| `packages/dsh-goal-confirm/lib/decision.js` | 0..3600；`resolveConfig`；命令语法 `parseCommandInput`/`foldCommand`；第三选项；状态文案 |
| `packages/dsh-goal-confirm/lib/session-state.js` | projection 定义（key `goal-confirm`、stateVersion 1、wire view）+ 内存回退 |
| `packages/dsh-goal-confirm/lib/index.js` | 命令注册；pre-step 读会话状态；`continue-off`；`wait` 的 live-client 兜底；状态文件补 `effective`/`sessionState`/`skipped` |
| `packages/dshom/client.js` | composer dock 开关（locale NS `goal-confirm`），`remote.commands.execute` 写入 |
| `packages/dsh-goal-confirm/test/*` | 纯函数 + 插件行为 + 投影单元测试 |

## 5. 已知风险（写进 spec §6）

1. 投影 schema 用鸭子类型（只实现 `parse`/`safeParse`），因为本仓没有 zod、且插件不静态 import
   `@deepseek-ai/*`（版本无关约束）。上游实现目前只调 `.parse()`，若收紧需换真 zod 或官方 peer。
2. 自定义 projection key 不在 `SessionProjectionMap` 的编译期声明内，运行时按开放 key 空间工作；
   需要真实会话验证 wire 值能到 Web。
3. 卡片/开关触发的命令会在会话里留下 `command/run`/`command/done` 记录（可见结果行），属预期审计面。

## 6. 验证

- **单测**：`node --test packages/dsh-goal-confirm/test/*.test.mjs` → exit 0，`# tests 53 / # pass 53 / # fail 0`
  （先前 30 项，新增会话状态/命令/投影/第三项等 23 项）；同轮 job-tools、liangshen-anchored、subagent-access 套件均 0 失败。
  原始输出 `.superpowers/sdd/2026-10-24-goal-confirm-session-switch/evidence/unit-tests.txt`。
- **临时 Host（3099）**：为了不写 `~/.dsh`（sandbox 仅工作区可写），用 `/tmp/dshhome` 的 profile 副本 + 绝对 link；
  Host 1s 内监听，`goal-confirm-status.json` 由新进程写出
  `{"activated":true,"pid":804895,"config":{"enabled":true,"timeoutSeconds":30,"cancelOnClose":true}}`，
  日志无 goal-confirm/projection 告警；首页 boot 注入 `@mosire/dshom` client bundle（rev 6ce51f65c42e），
  取回 24600 bytes、`node --check` 通过、含 `GoalConfirmSwitch` / `remote.commands`。
  细节与命令 `.superpowers/sdd/2026-10-24-goal-confirm-session-switch/evidence/smoke-3099.md`。
- **真实 projection 服务 spike**：用 DSH 安装里的真实 `SessionProjectionRegistry` + `Session` 注册本插件的定义，
  追加真实 `command/run`，验证 `stateOf` / `snapshot().values['goal-confirm']` / `checkpoint` / `restore` 全部正确
  （`off`、`wait`、`reset` 三态都过）。该 spike 抓到并修掉 `viewSchema` 未放进 `wire` 的 bug
  （注册不报错但 `snapshot()` 抛 `TypeError`）。输出 `evidence/projection-spike.txt`，脚本 `evidence/projection-spike.mjs`。
- **未验证（不得声称通过）**：
  - 真实 Web E2E（卡片第三项、`/goal-confirm wait|reset`、dock 开关、resume 重放）——需要用户重启 3080 Host；
  - 浏览器里 slot 是否实际渲染、自定义 projection key 的 wire 是否到达页面（本轮只到「Host 激活 + bundle 可取」）。
