# AGENTS.md —— DSHOptimizeMosire：梁神模式复刻 + 功能优化（常驻：项目简介 + 铁律 + 文档索引）

<!-- 加载时机：DSH 会把工作区 AGENTS.md 链以 user 角色消息自动送达模型；本文件是常驻口径。
     定位：只做「项目简介 + 项目铁律 + 文档索引」；纪律长文放 docs/agents/，不要往本文件堆长文。
     本文件不要用 `@` 导入任何文档。 -->

> ★ **本文件是索引不是全集**：细节以 `docs/agents/*.md` 原文为准；**冲突时以本文件（常驻口径）为准**，其次看最新落盘文档。
> ★ **不要在项目里用 `@` 导入文档**：导入会在启动时把文件展开进上下文，白载几千行。

## 一、这是什么

**DSHOptimizeMosire（dshom）＝「梁神模式」的现代复刻 + 功能优化。**

- 「梁神模式」是社区做给 **DeepSeek Harness（DSH）** 的 agent preset（**不是官方内置**），核心三件事：
  **首轮锚定**（第一条请求只暴露 Minimal 精确双工具 `bash` + `str_replace_editor`，并剥离 skill 目录 / AGENTS.md 摘要等自动注入）
  → **首调晋升**（首次持久工具调用后一次性放开完整组装目录）
  → **压缩重锚**（`compaction/end` 之后 epoch 感知地回到受控态，等新的工具调用再晋升）。
- **被删掉的是哪一版（2026-10-17 已查清）**：用户记忆中「好用的」是**锚定式（anchored standard）**那一版。
  根因：DSH 0.1.7 起移除 `$DSH_HOME/.agent-presets/<id>/` 目录发现（官方技能原文「Nothing reads that directory any more」），
  本机残留的 `~/.dsh/.agent-presets/liangshen/` 因此不再被任何会话读取；dsh-web 插件版后来又在 v0.3.23 重构为「极简 persona + PTC/both」，锚定被退役。
- **一手复刻材料**：本机 legacy 目录里的 v7 源码（9 文件 / 1451 行）+ TUI 0.15.0 包内同源副本
  （`@deepseek-harness-tui/dsh-tui/presets/liangshen/`）。现代承载形态必须改成 **bundle patch + `@deepseek-ai/dsh-agent-preset` 声明**。
- **本项目目标（五个功能）**：
  - **功能一 · 梁神模式复刻**：以官方机制把锚定式 v7 重建为可安装的 DSH 插件/preset（Web profile bundle），并做**有对照证据**的优化
    （本轮范围：`promoteOn: either` + `context-gate` + Windows 后台任务；双分支/熔断/事实登记簿留待后续）。
  - **功能二 · goal 续轮确认门**：goal 自动续轮注入时，Web UI 弹显式确认（确认→继续 / 取消→删除 goal / 30s 可配置无操作→继续）。
    调研结论：可用 host 插件在 `agent/pre-step`（prepend）扣住 + 复用官方 `ctx.userQuestions` 卡片 UI，**不改 DSH 源码**。
  - **功能三 · 子 Agent 访问（父 → 子控制面）**：Web profile 顶层会话的 Team 同名工具遮蔽了普通子会话的控制面
    （E2E 证据见 `docs/agents/03-…`）。独立 host 插件补 `subagent_list` / `subagent_message` / `subagent_interrupt`
    三个工具，只调官方 `ctx.subagents` / `ctx.agents`；M2（liangshen 子 Agent 锚定语义）只做实验设计。
  - **功能四 · 空系统提示词预设**：新增第二预设 `liangshen-empty-system`——梁神模式但系统提示词替换为单个 ASCII 空格，其余完全一致。
  - **功能五 · 压缩后恢复 hint**：`compaction/end` 后额外注入一条恢复 hint（提醒重读 AGENTS.md/CLAUDE.md、定位仓库根、恢复 status/handoff、
    用 `skill_search`/`skill_load` 恢复技能环境）；纯提示、不注入文件内容、不回挂官方注入源。裁定见 D-011~D-014。
- 权威顺序：**用户原话 > 最新落盘文档 > 本文件 > `docs/agents/*.md` 长文 > 上游参考（DSH / TUI / dsh-web 的源码与 README）> 旧文档**。
- 「当前状态」不抄在本文件：看 `docs/superpowers/status/` 最新一份 + `git log --oneline`。

## 二、项目铁律（不可协商）

1. **不碰 DSH 源码。** 只用官方机制：bundle patch、`@deepseek-ai/dsh-agent-preset` 声明、`cordis.patch.yml`、官方 `@deepseek-ai/*` peer 依赖；
   行为必须能在官方 DSH 0.2.0-rc.2 上以「装 bundle → 新会话选预设」复现。
2. **首轮锚定是资产。** 新会话第一条请求 = Minimal 精确双工具（持久 `bash` + `str_replace_editor`）+ 零自动注入上下文
   （`skill-catalog` / `agent-instructions` 剥离），除非隔离对照数据证明另一形状更好；**任何优化不得顺手改变首轮 wire**。
3. **系统提示词极简。** 与官方 Minimal 逐字节一致的 persona 块（v7 = 单行 persona；不追加工作纪律/cwd——那是 dsh-web 版做法）；
   AGENTS.md 类指令**不整段注入**——promote 后至多一条非命令式 hint，模型自己读文件；
   **每个压缩纪元（`compaction/end` 后）可再注入一条恢复 hint（纯提示，见功能五 / D-014）**。
4. **工具面渐进披露，且「目录宣告面 = 请求 wire 面」。** 首轮双工具 → 首调后放开完整目录（或按模型/档位分支）→ 压缩后重锚；
   分页只允许「扣留并显式宣告摘要」，不允许静默删能力；两边永不矛盾。
5. **证据先行。** 行为改动必须有真实会话 header / 事件流证据或隔离对照矩阵；**单次 smoke ≠ 模式集成通过 ≠ 统计提升**；
   没跑就写「没跑」，不许写「通过」。

## 三、目录与产物（约定）

| 路径 | 放什么 |
|---|---|
| `AGENTS.md`（本文件） | 项目简介 + 五条铁律 + 文档索引（常驻） |
| `docs/AGENTS.md` | 文档系统本身的用法（放哪层 / 谁说了算 / 取代关系 / 日期口径） |
| `docs/agents/*.md` | 人读的纪律与调研长文（按索引读） |
| `docs/superpowers/{specs,plans,status}/` | 设计书 / 实现计划 / 状态与交接（**跨会话唯一开工入口**） |
| `.agents/notes/{proposed,implemented,archived}/` | 决策记录（为什么这么定、被谁取代） |
| `.agents/skills/<name>/SKILL.md` | 可复用技术/纪律（跨运行时：Codex / Copilot CLI / Gemini CLI 也认） |
| `.superpowers/sdd/<topic>/` | SDD 台账与证据（**本机留痕，不进 git**） |
| `tools/` | 门禁脚本 / 验证脚本（**能机器拦的别只写文档**） |

- **不擅自 `git commit` / `git push`**：提交由用户批准（沿用隔壁项目纪律）。
- 一个责任区 = 一个写作用域；动多个文件前先声明写作用域，不要和别人（含 Agent Teams 队友）抢同一文件。

## 四、文档索引

**① 调研长文（先读）**

| 文件 | 覆盖什么 |
|---|---|
| `docs/agents/00-调研-梁神模式谱系.md` | 梁神模式是什么 / 四代谱系 / 锚定 v7 逐文件拆解 / 为什么锚定有效（一手数据）/ 优化候选 / 本机资产清单与复核命令 / 待裁定 |
| `docs/agents/02-调研-goal续轮确认门.md` | 功能二：goal 自动续轮驱动机制 / `agent/pre-step` 拦截点 / 复用官方提问卡片 / 三个方案对比 / v1 语义表 / spike 清单 / 待裁定 |
| `docs/agents/03-调研-子Agent访问.md` | 子 Agent 访问现状：预设强制继承 / 父→子控制面被 Team 遮蔽（含 E2E 证据）/ 上下文接力断层 / 427 子会话实测 / 优化候选 R1–R4 / 待裁定 |
| `docs/agents/04-调研-通用基础设施补位.md` | 功能五调研：梁神模式缺 AGENTS.md/skill 基础设施的会话证据（压缩后 hint 断档、cwd 父目录静默、skill 0 调用）/ 上游三阶段注入史 / A/B/C 方案对比与裁定 |

**② 文档系统与台账**

- `docs/AGENTS.md` —— 六层归宿表 · 口径优先级 · 取代关系写作 · `file:line` 与生成命令 · 日期口径 · 上游引用纪律。
- `.superpowers/AGENTS.md` —— SDD 台账/证据落点与形制（不进 git）。

**③ 设计 spec 与实现计划（已获用户批准，2026-10-17）**

- `docs/superpowers/specs/2026-10-17-liangshen-anchored-design.md` —— 功能一：骨架/承载 M0 决策门/移植矩阵/晋升状态机/验收判据/里程碑。
- `docs/superpowers/specs/2026-10-17-goal-confirm-gate-design.md` —— 功能二：拦截算法/问题文案/配置/降级/验证与 spike。
- `docs/superpowers/specs/2026-10-17-subagent-access-design.md` —— 功能三：父→子控制面三工具/Team 共存/验收判据；§8 为 M2 锚定语义实验设计。
- `docs/superpowers/specs/2026-10-17-empty-system-prompt-design.md` —— 功能四：空系统提示词预设（生成器+产物、多预设注册、verifier 扩展）。
- `docs/superpowers/specs/2026-10-17-compaction-recovery-hint-design.md` —— 功能五：压缩后恢复 hint（epoch 感知注入/gate allowKinds/验收判据）。
- `docs/superpowers/plans/2026-10-17-liangshen-anchored.md`、`…-goal-confirm-gate.md`、`…-subagent-access.md`、`…-empty-system-prompt.md`、`…-compaction-recovery-hint.md` —— 逐任务实现计划。

**④ 状态与交接**

- `docs/superpowers/status/2026-10-17-initial-survey.md` —— 本轮调研与实现进度（**下次开工先读它**）。

## 五、交叉纪律要点（每条只是概述 + 指针）

1. **先调查、后动手**：动手前把现状写成 `file:line` 落盘；待裁定问题先做口径溯源，不重复问已裁定过的（见 `docs/AGENTS.md` §二）。
2. **DSH 官方技能必读**：写 preset / 插件前先 `skill` 加载 `cordis-plugin-development`、`editing-cordis-compositions`、
   `cordis-composition-reference`、`agent-experience`；API 面用 `cordis_inspect_list` / `cordis_inspect_query` 查，**不要猜包名/事件名**。
3. **验证分层**：真实推理探针（链路通）≠ 模式集成通过（header / 呈现 / 晋升 / 压缩全对）≠ 统计提升
   （隔离多轮对照 + 记录 route / 源码 hash）；只声称你做出证据的那一层。
4. **上游引用纪律**：转抄 README / issue 的结论标「转抄，未回核」；二次来源（知乎 / 博客 / 视频 / 营销数字）一律标二次转述、不作验收依据。
5. **安全**：不把密钥写进仓库 / 文档；不执行破坏性 git 操作；安装 bundle 会在 Host 进程执行插件代码，只信本仓自产或已审阅的上游包。
6. **语言**：与用户交流用中文；代码、标识符、提交信息用英文（与上游一致）；文档中文。

## 六、环境事实（本机，2026-10-17）

- DSH 本体：`0.2.0-rc.2`，安装于 `/home/cna/.npm-global/lib/node_modules/@deepseek-ai/dsh/`（**只读参考，不改**）。
- 当前 profile：`web`；GUI：http://127.0.0.1:3080。
- 本机 legacy 快照：`~/.dsh/.agent-presets/liangshen/`（9 文件 / 1451 行；**已不被任何会话读取**，只作移植素材）。
- 上游仍在维护的同源实现：`@deepseek-harness-tui/dsh-tui@0.15.0` → `presets/liangshen/`（registry 声明）；
  `@linxin666/dsh-liangshen@0.4.6`（dsh-web `dev`，已重构掉锚定）。
- 官方 preset 模板：`@deepseek-ai/dsh-web-app` 的 `presets/{standard,ptc,minimal,cordis}.patch.yml`（随 DSH 安装）。
- 官方技能路径：`…/node_modules/@deepseek-ai/dsh-agent-preset/skills/`。
- goal 链路（功能二相关）：`@deepseek-ai/dsh-goal`（`ctx.goals` 生命周期）+ `@deepseek-ai/dsh-goal-round-driver`（自动续轮，无配置）+
  `@deepseek-ai/dsh-tool-goal` + `@deepseek-ai/dsh-command-goal` + `@deepseek-ai/dsh-client-ui-goal`；
  人工提问面：`ctx.userQuestions`（`@deepseek-ai/dsh-user-questions`）+ `@deepseek-ai/dsh-client-ui-user-questions`（Web 卡片 UI）。

## 七、已裁定与当前门禁

**功能一（梁神模式复刻）**：D-001=A 锚定式 v7 保真复刻；D-002=A Web profile 插件 bundle；D-003=B 复刻 + 上游小改进；
D-004=沿用「梁神模式」/ order 5 / MIT；D-005=协议级 smoke + 12 会话小矩阵；D-006=基线本地 v7 + 吸收 `promoteOn: either` / `context-gate` / Windows 后台任务；D-010（2026-10-17）=子 Agent 支持按次模型/档位选择（`modelSelectionSettings: true`），默认档位 `high`（主预设与空提示词变体同配）。

**功能二（goal 续轮确认门）**：G-001=A 官方提问卡片；G-002=A 全局挂载；G-003=A 关闭卡片=取消并删 goal；G-004=A 独立 bundle。

**功能三（子 Agent 访问）**：S-001=M1 只做父→子控制面三工具（M2 锚定语义实验只设计）；S-002=独立 bundle `@mosire/dsh-subagent-access`；
S-003=三工具 `subagent_list`/`subagent_message`/`subagent_interrupt`、默认只装 root、不加 prompt section；
S-004=只调官方 `ctx.subagents`/`ctx.agents`，不改 Team、不复制 DSH 源码；S-005=v1 不做 Team 成员过滤（已知限制，M2 再定）。

**功能四（空系统提示词预设）**：D-007=新增独立第二预设 `liangshen-empty-system`（order 6），主预设零改动；
D-008=生成器（`tools/sync-preset-variant.mjs`）+ 提交产物、单测防漂移；D-009=「空」= 单个 ASCII 空格，真实 wire 以实测为准。

**功能五（压缩后恢复 hint）**：D-011（2026-10-17 用户「开始吧」）=压缩后**额外注入一条纯提示 recovery hint**（不注入 AGENTS 内容、
不回挂官方 `agent-instructions`/`tool-skill`）；D-012=主预设+空预设都启用；D-013=时机为压缩后第一条请求（工具面仍 2 工具，
`context-gate.allowKinds` 放行 `recovery-hint`）；D-014=铁律 3 修正为「每个压缩纪元可再注入一条恢复 hint」；D-015=若实测 hint 仍被忽略，
再评估升级为「带内容版/方案 A」（本轮不做）；D-016=`complete:true` 永久缺口（runtime-context/plan policy/tool guidance）另立、不捆绑。

**当前门禁（必须遵守）**：
1. 功能一/二 spec 与计划已获用户批准并已提交；功能三/四 设计已定（用户 2026-10-17「出设计，提交并推送，然后开始实现」授权直接实现）。
2. 进度（2026-10-17 深夜）：功能一 **M0/T1/T2/T3/T4/T5 完成**（未验：Windows 实机、子代理锚定 E1、resume F1）；
   功能二 **实现+单测 30/30、bundle 已装、真实会话 E2E 成功**（取消并删 goal 路径，状态文件 action=cancel/cleared=true）；
   功能三 **M1 已实现并真实 E2E 通过**（三工具 list/message/interrupt；证据 `.superpowers/sdd/2026-10-17-subagent-access/evidence/e2e-live.md`；
   M2 锚定语义实验未开始）；
   功能四 **A1+B1/B2/B3 已实机验证**（用户重启 DSH 后：两预设 `broken:null`；新会话 `session-c57e32e7…` 选空预设，
   verifier exit=0：system 恰好一个空格、首请求双工具、零注入、晋升 48 工具）；仅空预设的**压缩重锚**未验（需 /compact）。
   功能一追补 **D-010**：liangshen 两预设的 `tool-subagent` 行已开 `modelSelectionSettings: true` + `agentOptions.reasoningEffort: high`，
   重挂载后 `broken:null`；真实「新会话按次换模型/档位」wire 待新会话验证（旧会话不追溯）。
   功能五（2026-10-17）：**已实现并实机通过**（`instruction-hint` epoch 感知 recovery + `context-gate.allowKinds`；单测 liangshen 76/76）；用户重启后会话 `session-aa65c681…`：压缩@104 → recovery-hint@111 → 首请求 tools=2 → 模型重读 AGENTS.md@116，verifier exit=0。证据本机 `.superpowers/sdd/2026-10-17-compaction-recovery-hint/`；空预设未单独跑 recovery。
3. 任何新增「待裁定」先做口径溯源并落盘，已有裁定不重复问（见 `docs/AGENTS.md` §二）。
4. 用户 2026-10-17 已授权本阶段 `git commit` + push 到 `git@github.com:c1589190/DSHOptimizeMosire.git`（main）。
