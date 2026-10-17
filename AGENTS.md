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
- **本项目目标（两个功能）**：
  - **功能一 · 梁神模式复刻**：以官方机制把锚定式 v7 重建为可安装的 DSH 插件/preset（Web profile bundle），并做**有对照证据**的优化
    （本轮范围：`promoteOn: either` + `context-gate` + Windows 后台任务；双分支/熔断/事实登记簿留待后续）。
  - **功能二 · goal 续轮确认门**：goal 自动续轮注入时，Web UI 弹显式确认（确认→继续 / 取消→删除 goal / 30s 可配置无操作→继续）。
    调研结论：可用 host 插件在 `agent/pre-step`（prepend）扣住 + 复用官方 `ctx.userQuestions` 卡片 UI，**不改 DSH 源码**。
- 权威顺序：**用户原话 > 最新落盘文档 > 本文件 > `docs/agents/*.md` 长文 > 上游参考（DSH / TUI / dsh-web 的源码与 README）> 旧文档**。
- 「当前状态」不抄在本文件：看 `docs/superpowers/status/` 最新一份 + `git log --oneline`。

## 二、项目铁律（不可协商）

1. **不碰 DSH 源码。** 只用官方机制：bundle patch、`@deepseek-ai/dsh-agent-preset` 声明、`cordis.patch.yml`、官方 `@deepseek-ai/*` peer 依赖；
   行为必须能在官方 DSH 0.2.0-rc.2 上以「装 bundle → 新会话选预设」复现。
2. **首轮锚定是资产。** 新会话第一条请求 = Minimal 精确双工具（持久 `bash` + `str_replace_editor`）+ 零自动注入上下文
   （`skill-catalog` / `agent-instructions` 剥离），除非隔离对照数据证明另一形状更好；**任何优化不得顺手改变首轮 wire**。
3. **系统提示词极简。** persona 一行 + 本模式固定工作纪律 + 一行 cwd；AGENTS.md 类指令**不整段注入**——
   promote 后至多一条非命令式 hint，模型自己读文件。
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

**② 文档系统与台账**

- `docs/AGENTS.md` —— 六层归宿表 · 口径优先级 · 取代关系写作 · `file:line` 与生成命令 · 日期口径 · 上游引用纪律。
- `.superpowers/AGENTS.md` —— SDD 台账/证据落点与形制（不进 git）。

**③ 设计 spec（待用户评审）**

- `docs/superpowers/specs/2026-10-17-liangshen-anchored-design.md` —— 功能一：骨架/承载 M0 决策门/移植矩阵/晋升状态机/验收判据/里程碑。
- `docs/superpowers/specs/2026-10-17-goal-confirm-gate-design.md` —— 功能二：拦截算法/问题文案/配置/降级/验证与 spike。

**④ 状态与交接**

- `docs/superpowers/status/2026-10-17-initial-survey.md` —— 本轮调研存档（**下次开工先读它**）。

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
D-004=沿用「梁神模式」/ order 5 / MIT；D-005=协议级 smoke + 12 会话小矩阵；D-006=基线本地 v7 + 吸收 `promoteOn: either` / `context-gate` / Windows 后台任务。

**功能二（goal 续轮确认门）**：G-001=A 官方提问卡片；G-002=A 全局挂载；G-003=A 关闭卡片=取消并删 goal；G-004=A 独立 bundle。

**当前门禁（必须遵守）**：
1. 两份 spec 已落盘（见 §四③），**等用户评审**；spec 评审通过前**不写实现代码、不进实现计划**。
2. spec 通过后 → `writing-plans` 出实现计划 → 用户确认 → 按里程碑实现（M0 承载 spike 先行）。
3. 任何新增「待裁定」先做口径溯源并落盘，已有裁定不重复问（见 `docs/AGENTS.md` §二）。
4. 不擅自 `git commit`；当前仓库为 `git init` 后未提交状态，提交须用户批准。
