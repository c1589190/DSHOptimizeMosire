# 2026-10-17 功能五设计：压缩后恢复 hint（compaction recovery hint）

> **性质**：已获用户批准（2026-10-17 用户「开始吧」）。本文是 `docs/agents/04-调研-通用基础设施补位.md` §五方案对比的**裁定结果**（D-011~D-014），不取代该调研文档。
> **用户原话（2026-10-17）**：「我的意思是，压缩之后，额外再注入一条hint，懂我意思吗？」「开始吧」
> **范围**：只做「压缩后额外一条纯提示 hint」；**不**注入 AGENTS.md 内容、**不**回挂官方 `agent-instructions` / `tool-skill`、**不**改首轮 wire、**不**动工具目录。

## 一、问题

梁神模式的 `instruction-hint` 是「每会话一次」：晋升后注入一条提示列出 AGENTS.md，模型据此读文件（实测 12–13/15 会读）。但它在 `compaction/end` 后**不重注**，而压缩会把 hint 与 AGENTS.md 内容一起挤出可见上下文。真实故障（`session-74bc67ff`）：

1. hint@39 → 模型 read AGENTS.md@44（前半段有效）；
2. `compact-checkpoint`@838（7,428 字符，不含 AGENTS/hint）→ `compaction/end`@839；
3. 重锚@846（2 工具）→ 再晋升@856（49 工具），**没有任何 hint**；
4. turn2 从 checkpoint 直接开工（git status → D1/D2 文档 → 工资源码），直到用户两次质疑后才 grep 找回「派单」规则。

通用模式靠官方 `agent-instructions` 的投影自愈解决（对照 `46cd9e91`：压缩后 10,411 chars 基线重注@1385）。本设计用一条**恢复 hint**达到「提醒模型重建环境」的目的，成本只落在压缩过的会话。

## 二、目标 / 非目标

**目标**：每个 `compaction/end` 之后，在压缩后的**第一条请求**注入一条 recovery hint，明确告诉模型：上下文刚压缩，需重读 AGENTS.md/CLAUDE.md 并遵循、必要时先定位仓库根、按 AGENTS.md 索引恢复 status/handoff、用 `skill_search`/`skill_load` 恢复技能环境。

**非目标**：
- 不注入指令文件内容（用户明确要「额外一条 hint」；若实测不够再升级，见 §七）；
- 不恢复官方 `agent-instructions` / `tool-skill`（方案 A/B 不做）；
- 不改初始 hint 语义、不改首轮 wire、不改晋升/压缩重锚工具面；
- 不处理 `complete:true` 的永久缺口（runtime-context、plan policy、tool guidance）—— 归 D-016 另记。

## 三、行为规格

### 3.1 初始 hint（保持不变）

- 条件：epoch `boundary === -1` 且已晋升（`promoteOn` 默认 `either`）且本会话尚未注入；
- 内容：现有文本「Workspace instruction files exist: … Do NOT assume their content. …」；
- 一次性（进程内 Set + durable 事件去重），与现状完全一致。

### 3.2 压缩恢复 hint（新增）

- **触发**：`promotion.status(agent).boundary >= 0`（发生过 `compaction/end`）后的第一个 `agent/pre-step`；**即使该纪元尚未晋升也注入**（压缩后第一条请求就要看到）。
- **每纪元一次**：`sessionId → Set<boundary>` 记忆 + durable 事件扫描双保险；消息 id `recovery-hint-<sessionId>-<boundary>`；source `{ kind: 'recovery-hint', form: 'hint', boundary }`。
- **探测**（复用现有 `instruction-hint` 的 fs 探测代码）：
  - project root：cwd 向上找 `.git/.hg/.svn`，无 marker 回退 cwd；
  - 候选：`AGENTS.md` / `CLAUDE.md` / `AGENTS.local.md` / `CLAUDE.local.md`；
  - user-global：`$DSH_HOME/AGENTS.md`（`DSH_HOME` 未设时 POSIX 回退 `~/.dsh`）。
- **文本模板**（一个 user/message，非命令式，约 400–700 chars）：
  - 「上下文刚被压缩，之前的工作环境/纪律可能已不可见，继续前先恢复」；
  - 有指令文件：「Read the workspace instruction files and follow them: <files> (project root: <root>).」；
  - 无指令文件：「No AGENTS.md/CLAUDE.md was found near <root>; if the workspace lives in a parent or subdirectory, locate the repository root first (e.g. `git rev-parse --show-toplevel`) and read its instruction files before continuing.」；
  - 有 user-global 文件：「A user-global instruction file exists: AGENTS.md.」；
  - 「If the instruction files point to a status or handoff document, re-read it to restore progress.」；
  - 「This session keeps no skill catalog: use `skill_search` to discover skills and `skill_load` to activate one when the task matches.」
- **降级**：
  - `ctx.fs` 缺失 / 探测抛错：仍注入通用文本（不含文件清单），不跳过；
  - 注入逻辑自身异常：不注入、不抛、`warn` 一次（与现有 hint 的 fail-open 一致）。
- **配置**：`recoveryHint: boolean`（默认 `true`）；`false` = 回滚到旧行为（每会话仅初始 hint）。
- **子代理**：跟随 `includeSubagents`；每个子会话按自己的 `compaction/end` 纪元判定。
- **resume/重启**：冷启动从 durable 事件重建 boundary（`createEpochPromotion` 已具备）；durable 扫描发现该 boundary 的 recovery-hint 已存在则不重复注入。

### 3.3 context-gate 放行（唯一 wire 例外）

- `context-gate.config.allowKinds` 增加 `recovery-hint`：压缩后第一条请求**工具面仍是 2 工具**，仅这一条消息可穿过未晋升期的注入剥离。
- 这是对「压缩后首请求零注入」的**明确例外**，仅作用于有 `compaction/end` 的会话；首轮（boundary=-1）wire 不变。
- `tool-bootstrap.suppressedContextSources` 不变（只剥 `agent-instructions`/`skill-catalog`，不含 recovery-hint）。

## 四、文件改动

| 文件 | 改动 |
|---|---|
| `packages/dsh-liangshen-anchored/presets/liangshen/instruction-hint.mjs` | 新增 epoch 感知的 recovery 分支：`createEpochPromotion` 的 `boundary` 判定、durable 去重、探测/文本/配置/降级 |
| `packages/dsh-liangshen-anchored/presets/liangshen/agent.cordis.yml` | `context-gate.allowKinds: [skill-invocation, recovery-hint]`；`instruction-hint.config.recoveryHint: true` + 注释更新 |
| `packages/dsh-liangshen-anchored/presets/liangshen/agent.empty-system.cordis.yml` | `node tools/sync-preset-variant.mjs --write` 重新生成 |
| `packages/dsh-liangshen-anchored/test/instruction-hint.test.mjs` | 新增单测（见 §六） |
| `packages/dsh-liangshen-anchored/test/composition.test.mjs` | 断言 allowKinds 含 recovery-hint、instruction-hint 配置、生成器同步 |
| `tools/verify-session.mjs` | 每个 `compaction/end` 后断言 recovery-hint 存在（boundary 匹配）；首轮检查不变 |
| `docs/agents/04…`、`AGENTS.md`、`.agents/notes/implemented/…`、`README.md` | 裁定记录/文档 |

不新增依赖，不改 DSH 源码。

## 五、算法（伪代码）

```
on agent/pre-step(agent, next):
  decision = await next()
  session = agent.session; if none: return decision
  status = promotion.status(agent)            # { boundary, promoted }
  if recoveryHint && status.boundary >= 0:
      key = (session.id, status.boundary)
      if key in memory: return decision
      memory.add(key)
      if durableHas('recovery-hint', boundary, session): return decision
      text = composeRecoveryText(probe(session))   # fs 缺失也返回通用文本
      append user/message{ id: recovery-hint-<sid>-<b>, source:{kind:'recovery-hint', form:'hint', boundary:b} }
      return decision
  # 初始 hint（现状）
  if not status.promoted: return decision
  if session.id in initialHinted: return decision
  ... existing probe/text/inject (kind 'instruction-hint') ...
```

顺序保证：`context-gate`（注册最早、prepend）在 after-next 阶段过滤，`recovery-hint` 因在 allowKinds 中而保留。

## 六、测试与验收

**单测**（`node --test packages/dsh-liangshen-anchored/test/*.test.mjs`）：
1. 初始纪元：晋升后注入一次初始 hint；同会话第二次调用不重复；
2. 压缩纪元：`compaction/end` 后**未晋升**也注入 recovery hint（source.kind/boundary/id 正确，文本含 AGENTS.md 与 skill_search）；
3. 同一 boundary 第二次调用不重复；第二个 `compaction/end` 后产生第二条（不同 id/boundary）；
4. resume 场景：durable 事件已有该 boundary 的 recovery-hint → 不再注入；
5. 无指令文件：文本走「locate the repository root」降级分支；
6. `recoveryHint: false`：不注入 recovery hint，旧行为不变；
7. 探测异常/fs 缺失：仍注入通用文本，不抛。

**组合/生成器**：`allowKinds` 断言、`recoveryHint` 配置断言、空预设生成器同步、21 rows 不变。

**真实会话 E2E（需用户配合）**：
- 新会话（主预设 + 空预设各一）：首轮 `tools=2` 且零注入（verifier）；
- 晋升后工具面变宽（verifier）；
- 执行 `/compact` 后：出现 `source.kind='recovery-hint'` 且 `boundary` 匹配；压缩后第一条请求 `tools=2`；hint 文本含 `AGENTS.md` / `skill_search`；
- 模型在 hint 之后实际 `read AGENTS.md`（工具调用证据）；
- 未压缩会话只出现初始 hint（无双份）。

> DSH 会缓存已加载插件模块：插件 JS 改动需要**重启 DSH** 才生效（YAML/生成器改动可随 bundle 重挂载生效）。

## 七、风险 / 回滚 / 后续

- **纯 hint 可能被忽略**：既有证据 12–13/15 会读、2/15 忽略；若 `/compact` 实测模型仍不读，下一步升级为「恢复消息带 AGENTS 内容 + skill 名单」（调研文档方案 A/内容版），插件留有扩展点。
- **压缩后首请求不再严格零注入**：这是有意例外，验收时需记录该请求的 wire 形状（tools=2 + 1 条 recovery-hint）。
- **回滚**：`recoveryHint: false`（配置）或移除 `allowKinds` 中的 `recovery-hint`。
- 不追溯旧会话；只对改动后新建（或之后发生压缩）的会话生效。

## 八、实现与实机结果（2026-10-17 深夜）

- 已实现并推送（`6ae5cb6`）：`instruction-hint.mjs` epoch 感知 recovery 分支；`context-gate.allowKinds` 加 `recovery-hint`；
  空预设生成器同步；`tools/verify-session.mjs` 新增「compaction recovery hint」检查；单测 liangshen 76/76（goal-confirm 30/30、subagent-access 28/28）。
- **实机通过**（DSH 重启后 host pid 180597；用户会话 `session-aa65c681…`，effective `liangshen`）：
  首轮 tools=2/零注入；初始 hint@31 → 模型 `cat AGENTS.md`@36；`/compact` → `compaction/end`@104 →
  **recovery-hint@111（boundary=104）** → 压缩后首请求@112 **tools=2** → 模型 `cat AGENTS.md`@116 → 再晋升@122 tools=48；
  `verify-session` exit=0，failures=[]。证据见 `.superpowers/sdd/2026-10-17-compaction-recovery-hint/evidence/e2e-live.md`（本机留痕，不进 git）。
- 未验证：空预设未单独跑 recovery 实机（同源插件/组合 + 生成器 + 单测覆盖）；旧会话不追溯；D-016（complete 缺口）不在本轮；
  D-015 升级条件（若 hint 仍被忽略 → 带内容版）保留为后备。
