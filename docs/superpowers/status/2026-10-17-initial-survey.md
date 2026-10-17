# 2026-10-17 初始调研存档（下次开工的唯一入口）

> **状态**：调研完成，设计与实现未开始。本文档取代：无（首份）。
> 加载：本文件不会自动注入；下次开工先读本文件 + 根 `AGENTS.md` + `docs/agents/00-调研-梁神模式谱系.md`。

## 一、本轮做了什么（2026-10-17）

1. 检索「梁神模式」上游资料：dsh-web（原 dsh-web-ui）、dsh-TUI、npm 生态、GitHub issue/discussion、知乎/博客/视频；
2. 定位本机一手材料 `~/.dsh/.agent-presets/liangshen/`（锚定式 v7，9 文件 1451 行，md5 见调研长文 §六）；
3. 查清「被删掉」根因：**DSH 0.1.7 起移除 legacy preset 目录发现**（官方技能原文 + TUI 源码注释双重证据），
   叠加 dsh-web v0.3.23 重构掉锚定（`anchorTools` 退役）；
4. 建立项目上下文：`AGENTS.md` / `docs/AGENTS.md` / `.superpowers/AGENTS.md` / 决策记录 / 本状态存档 / `.gitignore`；
5. 2026-10-17 追加：调研**功能二（goal 续轮确认门）**——摸清 `dsh-goal-round-driver` 自动续轮链路、`agent/pre-step` 瀑布拦截点、
   官方 `ctx.userQuestions` + Web 提问卡片复用可行性，产出 `docs/agents/02-调研-goal续轮确认门.md` 与对应决策记录；
6. **未写任何实现代码、未安装任何 bundle、未改 DSH 源码、未提交 git。**

## 二、已确认事实（详见调研长文）

> 2026-10-17 追加：原始出处 `xiaobright/dsh-anchored-standard`（MIT / 3754 stars）仍在线但 2026-09-10 冻结（V4 Pro 退役）；
> 本机 v7 ≈ TUI 0.15.0 包内副本（仅 2 文件各 3 行差异）；上游 `preset/` 多 `context-gate.mjs` / `dev-tool-search.mjs`（本地为更早简化派生）。

- 梁神模式是社区 preset，不是 DSH 官方内置（本机 0.2.0-rc.2 全量 grep 无命中）。
- 用户记忆中的版本 = 锚定式 v7：首轮 Minimal 精确双工具（持久 `bash` + `str_replace_editor`）、剥 `skill-catalog`/`agent-instructions`、
  首调晋升全目录、压缩后 epoch 重锚；本机源码与 TUI 0.15.0 包内副本逐字节相同。
- Web 侧现行 liangshen 0.4.6 已无锚定（极简 persona + `presentation: both` + tool-catalog + guard + fact_register + 分页）。
- 现代承载 = bundle patch + `@deepseek-ai/dsh-agent-preset` 声明（legacy 目录不再被读取，这也是「被删掉」的根因）。
- 功能二可行性：续轮由 `dsh-goal-round-driver` 在 `agent/pre-step` 先校验再放行；`prepend` 监听可先扣住；官方 `ctx.userQuestions`
  可发起匿名确认请求，Web 端已有卡片 UI（关闭=`ASK_CANCELLED`）；子代理不允许人工交互 ⇒ 自动放行。**不改 DSH 源码即可实现**。

## 三、当前仓库状态

- 目录骨架已建：`docs/{agents,superpowers/*}`、`.agents/{notes,skills}`、`.superpowers/{sdd}`、`tools/`；
- `git init` 已执行；**尚未 git commit**（等用户批准）；
- 文件清单以 `git status --short` 为准。

## 四、待用户裁定（阻塞设计）

- **D-001 已裁定（2026-10-17）= A 锚定式 v7 保真复刻**（用户选择）。
- **D-002 = A（Web profile 插件 bundle）**、**D-003 = B（复刻 + 上游小改进）**（2026-10-17 用户选择）。
- **D-006 随 D-003 确定**：基线 = 本地 v7；吸收上游小改进（`promoteOn: either`、`context-gate`、Windows 后台任务），不吸收 `dev_tool_search`/`prefab`。
- 待定：D-004 命名/order/包名/license（建议沿用「梁神模式」、order 5、MIT）；D-005 验证预算（建议协议级 smoke + 12 会话小矩阵）。
- **功能二待裁定**：G-001 UI 形态；G-002 挂载范围；G-003 关闭卡片语义；G-004 交付形态（详见 `docs/agents/02-调研-goal续轮确认门.md` §七）。
- **功能一设计已批准（2026-10-17）**、功能二四项裁定已定；两份 spec 已落盘待用户评审：
  - `docs/superpowers/specs/2026-10-17-liangshen-anchored-design.md`
  - `docs/superpowers/specs/2026-10-17-goal-confirm-gate-design.md`
- 下一步：**用户评审 spec** → 通过后 `writing-plans` 出实现计划 → 按里程碑实现（M0 承载 spike 先行）。

## 五、下一步（裁定落盘后）

1. brainstorming：分类（本项目=architectural）→ 澄清设计问题 → 出设计（架构/组件/数据流/错误处理/验证）→ **用户批准**；
2. 写 spec 到 `docs/superpowers/specs/2026-10-17-…-design.md` → 用户评审 → `writing-plans` 出实现计划；
3. 实现（TDD，按 P0 顺序）：bundle 骨架 → 移植 4 个自定义插件（tool-bootstrap / instruction-hint / skill-search / Windows bash）→
   `agent.cordis.yml` 组合 → preset 声明 + 注册 → 官方 DSH 0.2.0-rc.2 实机验证（新会话 header / 晋升 / 压缩 / 子代理 / 恢复）；
4. 优化项按 P1/P2 分期外挂（双分支、winbash 后台任务、guard、fact_register、working-context、maxResidentTokens）；
5. 验证基建（隔离 runner + 矩阵）与兼容回归（事件 kind / preset id / 恢复）。

## 六、未做 / 未验证（如实清单）

- 未在真实会话里跑过任何「复刻」；本文所有上游数字（5/5、~81%、72.6%、98.5 等）均为**转抄，未回核**。
- 未验证 DSH 0.2.0-rc.2 下「bundle 内 preset 声明 + `@deepseek-ai/cordis-plugin-include` 指向包内 `agent.cordis.yml` + 相对 `.mjs` 解析」的完整链路
  （TUI 源码显示同款做法，但本机未实装验证）。
- 未核 TUI 包与早期锚定版 preset 的许可证（dsh-web Apache-2.0、DSH MIT 已知；`presets/liangshen` 基于官方 Minimal/Standard/PTC 的 MIT 修改，需在 spec 里写清合规路径）。
- 未测算双分支 / guard 等优化项的实际收益；issue #266 的 22/22 是作者自测，非隔离对照。

## 七、实现进度（2026-10-17 下午，用户批准"开始吧"后）

### 已完成
- **M0 承载 spike**：静态 bundle patch 声明 `preset-liangshen` 可用；`include` 相对路径
  `./presets/liangshen/agent.cordis.yml` 在安装包内解析成功；行 `fiberPhase: active`。
  （坑：bundle patch 顶层 `config` 的 `!!js` 不求值 → 必须纯静态 config。）
- **T1/T2 移植**：21 row 组合（v7 20 row + context-gate 首行）；7 个 `.mjs` 插件随包；
  `promoteOn: either` 三处同步；`includeSubagents: true` 三处同步。安装 `application: applied`、无 warnings。
  单测 25/25（epoch 状态机 8、组合一致性 6、verify-session 11）。
- **T3 工具**：`tools/verify-session.mjs`（多帧 zstd 帧游走 + 协议断言），真实 16MB 大会话解析通过。
- **T5 元数据**：locale/icon/NOTICE/LICENSE/README；`node --check` 全绿。

### 进行中 / 待验证
- **M0 修正（16:20）**：静态声明不可用（include 相对路径以 profile 目录为 base）→ 改 host 插件声明；
  又遇官方裸包名从 workspace 包内不可解析（行 "never started"）→ `tools/link-dsh-peers.mjs` symlink 26 个官方包。
  修复后 `~/.dsh/liangshen-anchored-status.json` = `broken: null`（21 行全激活）。
- **T3 真实会话协议证据：已完成（2026-10-17 16:21）**。会话 `session-d3ee6e14…`（workspace /home/cna/tp/1）：
  `verify-session --preset liangshen` → **failures: []**；B1/B2/B3/C1/D1 全过（首轮双工具、单行 persona、零注入、
  晋升 45 工具、压缩后回 2 工具再晋升）。证据：`.superpowers/sdd/2026-10-17-liangshen-anchored/evidence/l2-real-session.log`。
  未验证：E1 子代理、F1 resume 重启、H Windows 实机。
- **T4 Windows 后台任务**（config-gated，默认关；本机 linux 只能单测 + 标注未实机）—— 进行中。
- 功能二（goal 确认门）尚未开工；开工前建议先完成功能一 T3 证据，避免两个新 bundle 同时干扰运行时。

### 仓库
- 远程：`git@github.com:c1589190/DSHOptimizeMosire.git`（main）；已推送至 `485b067` 之后若干提交。
- 证据：`.superpowers/sdd/2026-10-17-liangshen-anchored/`（本机留痕，不进 git）。

## 八、实现进度（2026-10-17 晚）

### 已完成
- **功能一 T4 Windows 后台任务完成**：`custom-bash.mjs` 增加 `backgroundJobs`（默认 false，开启时 `run_in_background`
  经 `ctx.jobs` 注册、`job_output`/`job_kill` 消费、apply 期 fail-fast）；新增 18 项单测，包内 45/45 通过。
  **Windows 行为未实机验证**（本机 Linux），代码/README 已标注；默认关闭，锚定首轮 wire 不受影响。
- **功能二实现 + 真实 E2E 成功**：host 插件 `packages/dsh-goal-confirm`（286 行）+ 30/30 单测；
  bundle 已安装并激活（`~/.dsh/goal-confirm-status.json` `activated:true`）。
  真实 E2E（本次会话 2026-10-17）：goal 自动续轮时 Web 端出现官方确认卡片，用户点「取消并删除 goal」→
  状态文件 `{"round":1,"action":"cancel","outcome":"answer","cleared":true}`，goal 被清除、驱动丢弃本轮。
  用户反馈：「goal机制的测试很成功，留着吧」。未验：30s 超时自动继续、关闭卡片路径、后台会话路径。
- **功能三调研完成**：`docs/agents/03-调研-子Agent访问.md`（427 个子会话实测 + 父→子控制面被 Team 遮蔽的
  E2E 铁证 + 优化候选 R1–R4）；设计/计划已落盘（spec/plan + 决策记录 S-001…S-005）。
- **功能四设计完成**：空系统提示词预设设计/计划（D-007…D-009），待实现。
- 三个子 Agent 交付：goal-confirm 实现+单测（30/30）、goal-confirm 元数据文档、T4（45/45）；Lead 已集成验证。

### 未验证 / 待做
- 功能一：E1 子代理锚定、F1 resume 重启、H Windows 实机（三项仍未验，如实保留）。
- 功能二：30s 超时自动继续 / 关闭卡片 / 后台无浏览器连接三条路径未实测。
- 功能三：M1 三工具尚未实现；M2（liangshen 子 Agent 锚定语义 A/B/C 实验）未开始。
- 功能四：待实现 + 真实 wire 验证（需用户新建会话选择预设）。
- 本机 427 个子会话语料中**没有 liangshen 子会话**，功能一子代理证据需新会话补齐。

### 仓库
- 2026-10-17 晚本轮提交：功能二 bundle + 功能一 T4 + 调研 03 + 功能三/四 spec/plan/决策记录（随本轮 commit 推送）。

## 九、实现进度（2026-10-17 深夜 · 功能三 M1 + 功能四代码）

### 功能三 · 子 Agent 访问（M1 已实现并真实 E2E 通过）
- 新 bundle `packages/dsh-subagent-access/`（`@mosire/dsh-subagent-access`）：host 插件向 root 会话
  （`delegationDepth===0`）安装三个模型工具 `subagent_list` / `subagent_message` / `subagent_interrupt`，
  只调官方 `ctx.subagents.listChildren/sendMessage/interrupt` + `ctx.agents` 状态；默认不装到子会话，
  `includeDelegatedAgents` 可开；无 prompt section、工具名不与 Team 冲突。
- 单测 28/28（catalog 10 + plugin 18）；`tools/link-dsh-peers.mjs` 泛化为多包扫描（26→25 链接，仍只缺 DSH 未安装的
  `dsh-workflow-worker-thread`）；三包回归 58 + 30 + 28 全绿。
- 安装 `application: applied`；`~/.dsh/subagent-access-status.json` 已写出（本会话在 installed 列表）；
  `Tool.listTools` 可见三工具（B1 通过）。
- **真实 E2E 通过**（证据 `.superpowers/sdd/2026-10-17-subagent-access/evidence/e2e-live.md`）：
  派发 `sleep` 子会话 → `subagent_list` 显示 running → `subagent_interrupt` 返回 previousStatus=running 且子会话被停 →
  `subagent_message` 返回 messageId、子会话唤醒新回合并回报 `ACCESS-E2E-OK`；Team 的 `list_agents` 行为不变。
- 未验：one-shot NOT_RESUMABLE（仅单测）、冷恢复、父离线、跨进程、Windows。

### 功能四 · 空系统提示词预设（代码完成，激活待 DSH 重启）
- `tools/sync-preset-variant.mjs`（生成器 + `--write`/校验）；产物 `agent.empty-system.cordis.yml`
  （463 行 = 458 + 生成头；唯一语义差异 `const persona = ' '`）；`preset.empty-system.yml`（order 6）。
- host 插件 `lib/index.js` 改为多预设注册（状态文件 schema v2）；单测 `test/presets.test.mjs` 4/4。
- verifier 增加 `space` 模式：首条 system message 必须**恰好一个 ASCII 空格**；组合一致性/元数据测试 58/58 全绿。
- **已知阻塞**：plugin_manager 关/开 bundle 只重新 apply 已缓存的旧模块，新 `lib/index.js` 需 **DSH 重启**才会加载；
  因此 `~/.dsh/liangshen-anchored-status.json` 仍是单预设旧 schema。重启后验证：roster 两个预设 `broken:null`（A1），
  然后用户新建会话选「梁神模式·空系统提示词」跑一次真实 wire（B1–B3）。

### 仓库
- 本轮提交（features 3 + 4 + docs）随 2026-10-17 深夜提交推送。

## 十、收尾验证（2026-10-17 深夜 · DSH 重启后）

- **功能四 A1 通过**：用户重启 DSH（host pid 853 → 14417）→ 新 host 插件代码加载。
  `~/.dsh/liangshen-anchored-status.json`（schema v2）：`liangshen` 与 `liangshen-empty-system` 均 `declared:true`、`broken:null`。
- **功能四真实 wire 通过**（用户新建会话 `session-c57e32e7…`，workspace /home/cna/tp/1，选「梁神模式·空系统提示词」后发「说话」）：
  `node tools/verify-session.mjs <session> --preset liangshen-empty-system` → **exit=0，failures: []**：
  首请求 `[bash, str_replace_editor]`、首步零自动注入、首条 system message **恰好一个 ASCII 空格**、
  首个持久信号后晋升 **48 工具**（= 原 45 + 本次安装的 subagent-access 3 工具）；compaction re-anchor 因该会话未压缩 → skipped。
  无 `--preset` 的自动模式同样 exit=0。证据：`.superpowers/sdd/2026-10-17-empty-system/evidence/real-wire.md`。
- **功能一回归**：T3 主预设真实会话（`session-d3ee6e14…`）`--preset liangshen` 仍 `failures: []`。
  这也证明安装 subagent-access 后 `liangshen` **首轮锚定 wire 未变**（只影响晋升后的工具面 45→48，铁律 2 实机证据）。
- **功能三**：重启后 subagent-access（pid 14417）重新激活，三工具在工具面。
- 剩余未验：功能四的**空预设压缩重锚**（需在该会话 `/compact`）、功能二的三条未测路径（30s 超时/关闭卡片/后台无浏览器）、
  功能一 E1/F1/H、功能三 M2 实验。

## 十一、追加：子 Agent 模型/思考档位选择（2026-10-17 深夜，D-010）

- 用户已开启 GUI「Subagent → Model selection」并确认「默认档位选择 high」。
- 改动：`presets/liangshen/agent.cordis.yml` 的 `tool-subagent` 行加 `modelSelectionSettings: true` +
  `agentOptions: { reasoningEffort: high }`；生成器同步空提示词变体（两组合一致性测试覆盖）。
- 效果（新会话）：`subagent`（spawn）可选 `provider` / `model` / `reasoning_effort`，并新增 `list_subagent_models`；
  不传参数时子 Agent 默认思考档位 `high`。旧会话不追溯（策略在会话创建时记录）；fork/Team 不支持。
- 本机验证：单测 59/59；`high` 为 deepseek 模型广告档位（off/low/high/max）；bundle 关/开重挂载后两预设 `broken:null`
  （配置被接受）。**真实「新会话换档位派单」wire 待验**：需新建 liangshen/空预设会话后检查工具面并实际派单。

## 十二、功能五：压缩后恢复 hint（2026-10-17 深夜，D-011~D-014）

- **裁定**（用户「开始吧」）：压缩后**额外注入一条纯提示 recovery hint**（不注入 AGENTS 内容、不回挂官方注入源）；
  主预设 + 空预设都启用；时机 = 压缩后的第一条请求（工具面仍 2 工具，经 `context-gate.allowKinds` 放行）。
- **设计/计划**：`docs/superpowers/specs/2026-10-17-compaction-recovery-hint-design.md`、
  `docs/superpowers/plans/2026-10-17-compaction-recovery-hint.md`、决策记录 `.agents/notes/implemented/2026-10-17-compaction-recovery-hint.md`。
- **实现**：`instruction-hint.mjs` 增加 epoch 感知 recovery 分支（`boundary` 判定、durable 去重、探测/降级、`recoveryHint:false` 开关）；
  `context-gate.allowKinds` 加 `recovery-hint`；空预设生成器同步；`tools/verify-session.mjs` 新增「compaction recovery hint」检查。
  单测 **liangshen 76/76**（新增 instruction-hint 10、gate+hint waterfall 集成 3、verifier 3）；goal-confirm 30/30、subagent-access 28/28。
- **实机（用户测试；DSH 重启后 host pid 180597）**：会话 `session-aa65c681-f842-4ad2-8199-a08ba06226a3`（effective `liangshen`）：
  首轮 tools=2/零注入；`instruction-hint`@31（213 chars）→ 模型 `cat AGENTS.md`@36；`/compact` → checkpoint@103、`compaction/end`@104
  → **`recovery-hint`@111（boundary=104，483 chars）** → 压缩后首请求@112 **tools=2** → 模型 `cat AGENTS.md`@116 → 再晋升@122 tools=48。
  `node tools/verify-session.mjs <session>` → **exit=0，failures: []**（含新检查 `compaction recovery hint`）。
  证据：`.superpowers/sdd/2026-10-17-compaction-recovery-hint/evidence/e2e-live.md`（本机留痕，不进 git）。
- **提交**：`831d059`（docs，设计+调研）与 `6ae5cb6`（feat，实现+测试），均已推送远程 `main`。
- **未验证 / 备注**：空预设未单独跑 recovery 实机（插件/组合同源 + 生成器同步 + 单测覆盖）；旧会话不追溯；
  D-015（若 hint 仍被忽略则升级为带内容版）保留为后备。
