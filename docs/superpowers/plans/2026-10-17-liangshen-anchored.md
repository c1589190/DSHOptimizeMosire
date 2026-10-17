# 锚定式梁神模式复刻 Implementaion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在官方 DSH 0.2.0-rc.2 上，以可安装 Web profile bundle 复刻锚定式梁神模式 v7，并吸收 `promoteOn: either`、`context-gate`、Windows 后台任务三项上游改进。

**Architecture:** 单 bundle 包：`cordis.patch.yml` 静态声明 `@deepseek-ai/dsh-agent-preset`（M0 决策门；不通则改 host 插件运行时声明），preset 组合用 `@deepseek-ai/cordis-plugin-include` 指向包内 `presets/liangshen/agent.cordis.yml`，7 个自定义 `.mjs` 插件随包分发；plain ESM、零构建、零运行时依赖、官方包走 peer。

**Tech Stack:** Node ≥22.19（本机 v22.23.2）、`node --test`、官方 `@deepseek-ai/*`（peer）、bundle patch（YAML/`!!js`）、`plugin_manager` 安装、`cordis_inspect_query` 验证。

**Spec:** `docs/superpowers/specs/2026-10-17-liangshen-anchored-design.md`

## Global Constraints

- **不修改 DSH 源码**；不覆盖官方 bundle/preset 行；只插入自己的行。
- DSH 兼容下限 `0.2.0-rc.2`（本机即此版本）。
- preset：`id: liangshen`、`name: 梁神模式`、`order: 5`；首轮工具面**恰好** `bash` + `str_replace_editor`。
- 首轮零自动注入上下文；`promoteOn: either` 三处（context-gate / tool-bootstrap / instruction-hint）必须一致；`includeSubagents: true` 同步。
- 移植文件优先**逐字节保真**（工具 CLI/API 形状不得顺手改）；只允许：注释、包名兼容修正、`session-events` 自包含导入替换。
- 行为改动必须有证据；未实机验证的项（Windows）在交付说明中明示。
- 提交：用户 2026-10-17 已授权本阶段提交并推送（`git@github.com:c1589190/DSHOptimizeMosire.git`，main 分支）。
- 产物路径：包 `packages/dsh-liangshen-anchored/`；证据 `.superpowers/sdd/2026-10-17-liangshen-anchored/`（不进 git）。

## Review Focus

- 首轮请求被宿主行/第三方插件多塞工具 ⇒ 断言 `request/header` 恰 2 个工具名。
- 首轮自动注入泄漏（skill 目录 / AGENTS.md / 运行时上下文）⇒ 用 context-gate + 首 step 消息 source 断言。
- `promoteOn: either` 未同步（gate 晋升、bootstrap 不晋升或反之）⇒ config-consistency 测试 + 协议断言。
- 压缩后未重锚（epoch boundary 计算错误）⇒ compaction 状态机单测 + `/compact` 实测。
- v7 写于 0.1.x：包名/事件名在 0.2.0-rc.2 已改名 ⇒ M0 全量回核，激活失败必须可见。

---

### Task 1: Bundle 骨架 + M0 承载 spike（静态声明）

**Files:**
- Create: `packages/dsh-liangshen-anchored/package.json`
- Create: `packages/dsh-liangshen-anchored/cordis.patch.yml`
- Create: `packages/dsh-liangshen-anchored/presets/liangshen/preset.yml`
- Create: `packages/dsh-liangshen-anchored/presets/liangshen/agent.cordis.yml`（M0 最小版：persona + 1 个探针插件）
- Create: `packages/dsh-liangshen-anchored/presets/liangshen/probe.mjs`（`export const name='liangshen-probe'; export function apply(){}`，只验证相对 `.mjs` 解析）

**Interfaces:**
- Produces: bundle 包名 `@mosire/dsh-liangshen-anchored`；preset patchId `preset-liangshen`；include 路径表达式 `new URL('./presets/liangshen/agent.cordis.yml', ctx.baseUrl).href`。
- Consumes: 无（首个任务）。

- [ ] **Step 1: 写最小包骨架**

`package.json`（关键字段）：`name:'@mosire/dsh-liangshen-anchored'`、`version:'0.1.0'`、`private:true`、`type:'module'`、`exports:{'.':'./lib/index.js','./package.json':'./package.json'}`、`peerDependencies:{'@deepseek-ai/dsh':'>=0.2.0-rc.2'}`、`dsh:{engines:{dsh:'>=0.2.0-rc.2'},bundle:{patch:'./cordis.patch.yml'}}`。

`cordis.patch.yml` 按 spec §5 的静态声明写（`config: !!js >-` 返回 `{id,name,description,order,plugins}`，plugins 内 include 行）。

M0 最小 `agent.cordis.yml`：persona 行（`complete:true`、`prefix` 等价官方 minimal 文本、`includeRuntimeContext:false`）+ `probe.mjs` 行。

- [ ] **Step 2: 语法检查**

Run: `node --check packages/dsh-liangshen-anchored/presets/liangshen/probe.mjs && node -e "JSON.parse(require('fs').readFileSync('packages/dsh-liangshen-anchored/package.json'))"`
Expected: exit 0，无输出。

- [ ] **Step 3: 安装 bundle（宿主验证）**

`plugin_manager` `action: install_bundle`、`target: /home/cna/DSHOptimizeMosire/packages/dsh-liangshen-anchored`。
Expected：`application: applied`（或 HMR 生效）；`warnings` 如实记录。

- [ ] **Step 4: 验证 preset 声明激活**

`cordis_inspect_query` host `Config.listConfigs`，`name:'@deepseek-ai/dsh-agent-preset'`。
Expected：出现 `patchId=preset-liangshen` 且 `status=schema`；无 diagnostic（若 `failed` ⇒ 记录错误，执行 fallback 设计变更后再继续）。
另查 `plugin_manager list_plugins` 确认行存在且非 failed。

- [ ] **Step 5: 记录 M0 证据**

写 `.superpowers/sdd/2026-10-17-liangshen-anchored/impl-ledger.md`：选择静态声明或 fallback、install/Config 原始输出关键行、包名回核清单（下一步 Task 2 完成）。
写 `.superpowers/sdd/2026-10-17-liangshen-anchored/evidence/m0-spike.log`。

- [ ] **Step 6: Commit**

`git add packages/ && git commit -m "feat(bundle): scaffold liangshen-anchored bundle and verify preset declaration (M0)"`

---

### Task 2: 移植完整组合 + 7 个插件 + 单测

**Files:**
- Modify: `packages/dsh-liangshen-anchored/presets/liangshen/agent.cordis.yml`（v7 425 行 + context-gate 首行 + promoteOn/either）
- Create: `packages/dsh-liangshen-anchored/presets/liangshen/{tool-bootstrap,context-gate,instruction-hint,skill-search,custom-bash,compaction-epoch,session-events}.mjs`
- Create: `packages/dsh-liangshen-anchored/test/epoch.test.mjs`
- Create: `packages/dsh-liangshen-anchored/test/composition.test.mjs`
- Delete: `probe.mjs`（M0 探针不再需要）

**Interfaces:**
- Consumes: Task 1 的 bundle 声明与 include 链路。
- Produces: `createEpochPromotion(promoteEvents: string[], {includeSubagents?: boolean}) -> {status(agent), observe(session,event)}`（`compaction-epoch.mjs` 导出，逐字节保留）；组合文件约定：3 处 `promoteOn: either`、`includeSubagents: true`、context-gate 为第一个 row。

- [ ] **Step 1: 拷贝移植源**

从 `~/.dsh/.agent-presets/liangshen/`（v7）拷贝 instruction-hint / skill-search / custom-bash / compaction-epoch / session-events；从上游 `xiaobright/dsh-anchored-standard` `preset/` 拷贝 tool-bootstrap（301 行）与 context-gate（202 行）。来源写进 `NOTICE`。

- [ ] **Step 2: 写失败测试（epoch 状态机）**

`test/epoch.test.mjs`（`node:test` + `assert`），至少覆盖：
- 无事件 ⇒ `{boundary:-1, promoted:false}`；`tool/call` ⇒ promoted；
- `compaction/end` 在事件中间 ⇒ 只认 boundary 之后信号；
- `assistant/message` + `promoteOn:['tool/call','assistant/message']` ⇒ promoted；
- `includeSubagents:false` + `session.header.delegationDepth=1` ⇒ promoted 直通；
- `includeSubagents:true` ⇒ 子代理 {boundary:-1,promoted:false}。
Fake session：`{id:'s1', header:{delegationDepth:0}, snapshotEvents:()=>[...]}`。

Run: `node --test packages/dsh-liangshen-anchored/test/epoch.test.mjs`
Expected: 初始 FAIL（`createEpochPromotion` 未就绪/文件缺失）。

- [ ] **Step 3: 写组合一致性测试（无 YAML 依赖，文本断言）**

`test/composition.test.mjs`：读取 `agent.cordis.yml` 文本断言：`context-gate` 行在 `tool-bootstrap` 之前；恰好 3 处 `promoteOn: either`；所有 `includeSubagents:` 均为 `true`；`bootstrapTools: [bash, str_replace_editor]` 存在；`suppressedContextSources` 不出现。
Run 同上 Expected: FAIL 至组合改完。

- [ ] **Step 4: 改组合文件（按 spec §6.1 五条）**

写完 `agent.cordis.yml`：v7 20 row + context-gate 首行；包名按 M0 回核清单修正；`persona` 文本与官方 minimal 一致。

- [ ] **Step 5: 跑测试至全绿**

Run: `node --test packages/dsh-liangshen-anchored/test/`
Expected: 全部 PASS。

- [ ] **Step 6: 重装 bundle 并验证激活**

`plugin_manager` `install_bundle`（同 Task 1 target；替换安装可能需要重启才加载新模块——按返回值如实记录）。
`Config.listConfigs`/`list_plugins` 复核 preset 行；用 `cordis_inspect_query` 核对 `preset-liangshen` 的 `plugins` 引用已指向完整组合（或真实验证留 Task 3）。

- [ ] **Step 7: Commit**

`git add packages/ && git commit -m "feat(preset): port anchored liangshen composition and plugins"`

---

### Task 3: 协议级验收（真实会话 + verify-session 工具）

**Files:**
- Create: `tools/verify-session.mjs`
- Create: `packages/dsh-liangshen-anchored/test/verify-session.test.mjs`
- Create: `.superpowers/sdd/2026-10-17-liangshen-anchored/evidence/l2-*.log`

**Interfaces:**
- Produces: `verifySession(events, {mode:'first-request'|'promotion'|'reanchor'}) -> {ok:boolean, failures:string[]}`；CLI：`node tools/verify-session.mjs <session.v4.jsonl.zstd>`。
- Consumes: 会话日志格式 `~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`（Node 22 `zlib.zstdDecompressSync` 解压）。

- [ ] **Step 1: 写失败测试（用固定小样本事件数组）**

断言：首条 `request/header` tools 名集合 = `{bash,str_replace_editor}`；首 step 无 `skill-catalog`/`agent-instructions` source；晋升后 header 工具数 > 2；`compaction/end` 后首条 header 回到 2 工具。
Run: `node --test packages/dsh-liangshen-anchored/test/verify-session.test.mjs` Expected: FAIL。

- [ ] **Step 2: 实现 `tools/verify-session.mjs`** 至测试 PASS。

- [ ] **Step 3: 真实会话 smoke（需用户在 Web GUI 新建「梁神模式」会话）**

步骤：新会话（梁神模式）→ 发一句要求做一次工具调用（如 `ls`）→ 结束一轮 → 再发一条 → `/compact` → 再发一条。
导出并断言：
`node tools/verify-session.mjs ~/.dsh/sessions/--home-cna-<ws>--/session-<id>/session.v4.jsonl.zstd`
Expected: 所有断言 PASS；把命令与输出写 `evidence/l2-*.log`。

- [ ] **Step 4: 子代理/恢复断言**

派发一次子代理并检查子会话首轮；重启 `dsh web` 后恢复主会话检查相位（若重启影响用户，改期并明确标注「未验」）。

- [ ] **Step 5: Commit**

`git add tools/ packages/ && git commit -m "feat(verify): add session log verifier and protocol acceptance evidence"`

---

### Task 4: Windows 后台任务（config-gated，P1）

**Files:**
- Modify: `packages/dsh-liangshen-anchored/presets/liangshen/custom-bash.mjs`
- Create: `packages/dsh-liangshen-anchored/test/custom-bash-config.test.mjs`

**Interfaces:**
- Produces：`config.backgroundJobs: boolean`（默认 `false`）；开启时工具 schema 增加 `run_in_background?: boolean`，并在 Windows 进程池不可用时报错而非静默。
- Consumes：`@deepseek-ai/dsh-tool-jobs` 的 job registry（宿主行已在组合中）。

- [ ] **Step 1: 写失败测试**：`apply()` 在 `backgroundJobs:false` 时不注册 job 相关参数；`true` 时注册（fake ctx 捕获 `ctx.tools.register` 的 schema）。
- [ ] **Step 2: 跑测试确认 FAIL**。
- [ ] **Step 3: 实现 config 扩展**（参数校验 + schema 分支 + 文档注释）。
- [ ] **Step 4: 跑测试 PASS**；**明确记录：本机 linux 无法实机验证 Windows 行为**。
- [ ] **Step 5: Commit**

---

### Task 5: 元数据、许可证与收尾

**Files:**
- Create: `packages/dsh-liangshen-anchored/{locale/zh.json,locale/en.json,icon.svg,NOTICE,LICENSE,README.md}`
- Modify: `docs/superpowers/status/2026-10-17-initial-survey.md`（存档）与 `AGENTS.md`（若索引变化）

- [ ] **Step 1: 写 locale/icon/NOTICE/LICENSE/README**（NOTICE 列：DSH minimal/standard/ptc MIT、TUI v7 MIT、anchored-standard MIT）。
- [ ] **Step 2: 全量自检**：`node --test packages/dsh-liangshen-anchored/test/`、`node --check` 所有 `.mjs`、`git status` 干净。
- [ ] **Step 3: 更新状态存档**（完成/未完成/未验证清单）并与 spec 差异回填。
- [ ] **Step 4: Commit + push**，报告交付与证据路径。

## Self-Review 记录

- Spec 覆盖：§4 骨架→T1；§5 承载→T1；§6 移植矩阵→T2；§7 状态机→T2/T3；§8 降级→T2 单测；§9 验证→T3；§10 里程碑→T1–T5；§11 风险→T1/T4/收尾。
- 类型一致性：`createEpochPromotion`/`verifySession` 名称在 T2/T3 一致。
- 未覆盖输入（写进任务测试）：首轮工具数、注入泄漏、promoteOn 同步、压缩重锚、包名漂移（T1/T2/T3 覆盖）。
