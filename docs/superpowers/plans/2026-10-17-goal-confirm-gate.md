# goal 续轮确认门 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** goal 自动续轮注入时，在 Web UI 弹官方提问卡片（确认→继续 / 取消→删除 goal / 30s 可配置无操作→继续），全局生效、独立 bundle、不修改 DSH 源码。

**Architecture:** 单 host 插件（无 client half）：`agent/pre-step` 以 `prepend:true` 扣住 `source.kind='goal' && round>0` 的本步，调 `ctx.userQuestions.ask()`（官方 Web 卡片渲染匿名 live 请求），自建 AbortSignal+定时器实现超时；取消则 `ctx.goals.clear()` 后 `next()` 让驱动围栏拒绝本轮。服务缺失/子代理一律放行（fail-open）。

**Tech Stack:** Node ≥22.19、plain ESM host 插件（`export function apply(ctx, config)`、`export const Config`）、bundle patch、`node --test`、官方 `@deepseek-ai/dsh-user-questions` + `@deepseek-ai/dsh-client-ui-user-questions`（复用，不修改）。

**Spec:** `docs/superpowers/specs/2026-10-17-goal-confirm-gate-design.md`

## Global Constraints

- 不修改 DSH 源码；不修改官方 goal 驱动 / user-questions / Client UI。
- 只拦截自动续轮（`source.kind==='goal' && source.round>0`）；人工 `/goal`、人类消息、普通子代理消息不拦截。
- 超时/服务缺失/子代理/异常一律**放行**（绝不卡死会话）；取消唯一写操作是 `ctx.goals.clear()`（失败降级 pause，再失败只记日志）。
- Config：`enabled=true`、`timeoutSeconds=30`(1..3600)、`cancelOnClose=true`；非法配置激活期 fail-fast。
- 全局挂载（web profile）；独立 bundle；与功能一互不依赖。
- 提交：用户 2026-10-17 已授权本阶段提交推送。

## Review Focus

- 匿名 live 请求是否真被官方卡片渲染（若否 ⇒ 方案升级，见 spec 风险表）。
- 超时 abort 后卡片残留/影响下一次提问。
- 取消路径 `clear` 后驱动是否安静丢弃本轮、不 block 新 goal。
- 关闭卡片语义（`cancelOnClose` 两态）与文案一致性。
- 后台/无浏览器会话 30s 内不挂死。

---

### Task 1: Bundle 骨架 + 拦截 spike

**Files:**
- Create: `packages/dsh-goal-confirm/package.json`
- Create: `packages/dsh-goal-confirm/cordis.patch.yml`
- Create: `packages/dsh-goal-confirm/lib/index.js`（spike 版：识别 goal 轮 → 调 `ctx.userQuestions.ask` 问一句、10s 超时 → 放行）

**Interfaces:**
- Produces：bundle 包名 `@mosire/dsh-goal-confirm`；行 id `goal-confirm`；spike 行为可观测（日志 `goal-confirm: spike asked round N`）。
- Consumes：`ctx.get('userQuestions')`、`ctx.get('goals')`。

- [ ] **Step 1: 写包骨架与 spike 插件**（`node --check` 通过；spike 用 10s 超时、单问题「spike 确认」）。
- [ ] **Step 2: `node --check lib/index.js`** Expected: exit 0。
- [ ] **Step 3: 安装 bundle**（`plugin_manager install_bundle`，target 绝对路径）→ 记录 `application`/`warnings`。
- [ ] **Step 4: 真实验证**：在当前/测试会话触发一次 goal 自动续轮，观察 Web 是否出卡片；选「继续」观察本轮继续；关闭卡片观察 `ASK_CANCELLED` 日志。
- [ ] **Step 5: 若卡片不出现**：停止，按 spec 风险表升级方案（`askTimed`+合成 callId 验证 → 再不通转 G-001=B），并更新 spec 后再继续。
- [ ] **Step 6: 证据落盘** `.superpowers/sdd/2026-10-17-goal-confirm/evidence/spike-*.log`；Commit。

---

### Task 2: 决策核心 + 正式插件 + 单测

**Files:**
- Create: `packages/dsh-goal-confirm/lib/decision.js`（纯函数，可单测）
- Modify: `packages/dsh-goal-confirm/lib/index.js`
- Create: `packages/dsh-goal-confirm/test/decision.test.mjs`
- Create: `packages/dsh-goal-confirm/test/config.test.mjs`

**Interfaces:**
- Produces：`decideOutcome(result: {kind:'answer', selected:string[]} | {kind:'error', code?:string}, config: {cancelOnClose:boolean}) -> 'continue'|'cancel'`（`ASK_CANCELLED` + `cancelOnClose=false` ⇒ `'continue'`；`ASK_ABORTED`/`DELEGATED_CALLER`/`NO_PROVIDER`/`CALLER_NOT_LIVE`/未知 ⇒ `'continue'`；选「取消并删除 goal」⇒ `'cancel'`；选「继续」⇒ `'continue'`）。
- Produces：`buildQuestion({round, maxGoalRounds, objective, timeoutSeconds}) -> AskUserQuestionItem`（文案与 spec §6 一致）。

- [ ] **Step 1: 写失败测试**：答案/错误码/config 组合全表（含 `cancelOnClose` 两态、未知错误码）；`buildQuestion` 的 header/id/两个选项 label、detail 含轮次与超时秒数。
- [ ] **Step 2: 跑测试 FAIL**。
- [ ] **Step 3: 实现 `decision.js`** 至测试 PASS。
- [ ] **Step 4: 改写 `lib/index.js` 为正式版**：`export const Config`（三字段校验）、`apply` 内 `agent/pre-step` prepend 监听、`asked`/`confirmed` 幂等集合、AbortController+timeout 联动 `payload.signal`、`clear`→重读重试→`pause` 降级、全路径日志。
- [ ] **Step 5: 跑全部测试 PASS**：`node --test packages/dsh-goal-confirm/test/`。
- [ ] **Step 6: 重装 bundle**，`Config.listConfigs name:'@mosire/dsh-goal-confirm'` 核对三字段 schema。
- [ ] **Step 7: Commit**

---

### Task 3: E2E 验收

**Files:**
- Create: `.superpowers/sdd/2026-10-17-goal-confirm/evidence/e2e-*.log`
- Modify: `docs/superpowers/status/2026-10-17-initial-survey.md` 之后续存档（Task 4）

- [ ] **Step 1: 建 goal（maxGoalRounds=3，测试会话）→ 等自动续轮 → 卡片出现 → 选「继续」→ 本轮完成。**
- [ ] **Step 2: 下一轮卡片 → 选「取消并删除 goal」→ 会话 JSONL 出现 `goal/change` clear；不再自动续轮。**
- [ ] **Step 3: 再建 goal → 卡片出现 → 关闭卡片 → 同取消（默认 `cancelOnClose=true`）。**
- [ ] **Step 4: 再建 goal → 临时把 `timeoutSeconds` 配成 5 → 无操作 → 5s 后自动继续；恢复默认 30。**
- [ ] **Step 5: 后台/无浏览器会话验证 30s 不挂死（另开会话跑 goal，切走页面）。**
- [ ] **Step 6: 与功能一联测**：梁神模式会话重复一次功能一 B1/C1 断言，确认无回归。
- [ ] **Step 7: 证据归档 + Commit**

---

### Task 4: 元数据与收尾

**Files:**
- Create: `packages/dsh-goal-confirm/{locale/zh.json,locale/en.json,icon.svg,NOTICE,LICENSE,README.md}`
- Modify: `AGENTS.md`（状态/索引若有变化）、`docs/superpowers/status/2026-10-17-initial-survey.md`

- [ ] **Step 1: 写 locale/icon/NOTICE/LICENSE/README**。
- [ ] **Step 2: 全量自检**：`node --test`、`node --check`、`git status`。
- [ ] **Step 3: 更新状态存档**（含未验证项与 spec 差异）。
- [ ] **Step 4: Commit + push** 并报告。

## Self-Review 记录

- Spec 覆盖：§4 架构→T1；§5 算法→T2；§6 文案→T2；§7 配置→T2；§8 降级→T2 单测；§9 验证→T1/T3；§10 里程碑→T1–T4。
- 类型一致性：`decideOutcome` / `buildQuestion` 在 T2 内一致；`Config` 三字段与 spec 一致。
- 未覆盖输入（写进任务测试）：关闭卡片语义、未知错误码、超时、服务缺失、非 goal 消息、子代理。
