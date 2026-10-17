# 空系统提示词预设设计 · 功能四（梁神变体）

> **状态**：设计已定；用户 2026-10-17 授权实现。
> **用户原话（2026-10-17，逐字）**：「顺别再加一个模式，空系统提示词模式，就是梁神模式但是把系统提示词替换成一个空格」
>
> 关联：`docs/superpowers/specs/2026-10-17-liangshen-anchored-design.md`（主预设设计）；决策记录
> `.agents/notes/implemented/2026-10-17-empty-system-prompt-scope.md`。
> 本文不含实现代码；实现按 `docs/superpowers/plans/2026-10-17-empty-system-prompt.md` 执行。

## 1. 目标

新增**第二个 agent preset**：`liangshen-empty-system`，是梁神模式（锚定式）的**对照变体**——
组合、工具面、锚定/晋升/压缩重锚、instruction hint、includeSubagents 全部与主预设一致，
**唯一差异：系统提示词（persona）替换为单个 ASCII 空格（U+0020）**。

用于：对照实验 / 特殊模型的「无系统提示词」基线；用户可在 Web 会话创建时选择。

## 2. 成功判据（验收）

| ID | 判据 | 验证方式 |
|---|---|---|
| A1 | bundle 激活后 roster 出现两个预设：`liangshen`（order 5）与 `liangshen-empty-system`（order 6），两者 `broken` 均为 null | `~/.dsh/liangshen-anchored-status.json` + `agentPresets.list()`（经 registry/状态文件） |
| B1 | 真实会话（用户新会话选该预设）首请求 header 工具 = `[bash, str_replace_editor]`；首条 system message 内容**恰好为一个空格** | `node tools/verify-session.mjs <session> --preset liangshen-empty-system` |
| B2 | 首步零自动注入（skill-catalog / agent-instructions 等不出现） | 同上（verifier A/B/C 断言） |
| B3 | 首个持久信号后晋升到完整目录；`compaction/end` 之后重锚回双工具 | 同上（verifier C/D 断言） |
| B4 | 主预设 `liangshen` 行为零回归（同一 verifier 对主预设仍全过） | 回归验证 |
| C1 | 组合一致性：空预设组合文件 == 生成器从主组合生成的结果；两份各 21 行；唯一语义差异为 persona 字面量（+生成头注释） | 单测 |
| C2 | 版本自适应 persona 配置（`prefix`/`text` 键探测）在变体中同样保留 | 单测（文件内容断言）+ 安装激活 |
| D1 | 若真实 wire 中该空格被 API/适配层 trim 成空串：记录实测偏差并在状态文档回报；判据改为「system 文本为空白且长度 ≤ 1」需用户确认 | 真实会话日志 + 证据记录 |

**负向用例**：选择主预设的会话不受空变体影响；空变体不是默认预设；两预设可并存切换（新建会话时选择）。

## 3. 非目标

- 不修改主预设 `liangshen` 的任何行为/元数据；
- 不改变 profile 默认预设、不做 UI 定制（预设名/描述为中文，与主预设一致）；
- 不引入运行时生成/构建步骤（组合产物提交在仓库内）；
- 不做英文 preset 名（DSH preset 名无 i18n 机制）。

## 4. 架构与实现方案

### 4.1 组合来源：生成器 + 提交产物（D-008）

主组合 `presets/liangshen/agent.cordis.yml`（458 行，21 row）与空变体只差 persona 文本。
为避免手抄 458 行漂移，采用：

- `tools/sync-preset-variant.mjs`：读取主组合，做确定性替换 → 输出变体组合文本；
  - 替换 1：`const persona = 'You are a helpful software engineer assistant.'` → `const persona = ' '`
  - 替换 2：persona 上方注释行标注为「EMPTY-SYSTEM VARIANT（generated）」并保留「由主组合生成、勿手改」；
  - CLI：默认打印/校验；`--write` 写回产物文件；
- 产物提交：`presets/liangshen/agent.empty-system.cordis.yml`（与主组合同目录，使 `./*.mjs` 相对引用继续有效）；
- 单测：`readFileSync(产物) === renderEmptySystemComposition(readFileSync(主组合))`（C1/C2 同时覆盖）。

> 理由：不复制 7 个 `.mjs`、不引入运行时写文件；生成器只有一处「差异定义」，主组合改动后跑一次脚本即同步，
> 单测会拦截遗漏。

### 4.2 预设声明：host 插件支持多预设（改造现有 `lib/index.js`）

现状：`declarePreset()` 硬编码单个 `id: 'liangshen'` 与 `preset.yml`/`agent.cordis.yml`。
改为规格表：

```js
const PRESETS = [
  { id: 'liangshen',             metadata: 'preset.yml',             composition: 'agent.cordis.yml' },
  { id: 'liangshen-empty-system', metadata: 'preset.empty-system.yml', composition: 'agent.empty-system.cordis.yml' },
]
```

- 逐个 `registry.register({ id, name, description, order, plugins: [include(absolute file URL)] })`；
- 每个注册结果写状态文件（schema v2）：

```json
{"declared":true,"pid":123,
 "presets":[{"id":"liangshen","composition":"file://…/agent.cordis.yml","broken":null},
            {"id":"liangshen-empty-system","composition":"file://…/agent.empty-system.cordis.yml","broken":null}]}
```

- 单个预设注册失败不阻塞另一个（各自 try/catch，状态文件记录 error）；
- 元数据：`presets/liangshen/preset.empty-system.yml`：
  `name: 梁神模式·空系统提示词`、`description`（说明唯一差异）、`order: 6`。

### 4.3 persona 配置（变体内）

沿用主组合的版本自适应 `!!js` 块（探测 `@deepseek-ai/dsh-persona` 版本决定 `prefix`/`text` 键），
只把 `const persona = '…'` 变成 `const persona = ' '`；`complete: true`、`includeRuntimeContext: false` 不变。
一个空格是合法非空字符串（`prefix: z.string().required()`），`complete` 语义保证它是**唯一** system prompt 段
（`dsh-system-prompt/lib/index.js:335-360`：complete 段在 assembly 后被恢复为唯一 section，
渲染时 `text.length > 0` 保留空格段）。

### 4.4 验证器扩展

`tools/verify-session.mjs`：

- `analyzeSession(events, { preset, systemPrompt })`：`systemPrompt: 'persona' | 'space'`（默认 persona）；
- CLI `--preset liangshen-empty-system` 自动选 `space`；
- `space` 模式断言：首条 system message 文本 === `' '`（恰好一个空格；若实测 trim 则按 D1 记录偏差），
  且仍无 harness identity。

## 5. 验收与验证步骤

1. 生成器 + 产物 + 单测（C1/C2）；
2. 安装 bundle（`plugin_manager install_bundle`，覆盖/重装 `@mosire/dsh-liangshen-anchored`）→
   状态文件两预设 `broken:null`；
3. **真实会话 wire 验证**：用户在 Web 新建会话 → 预设选择「梁神模式·空系统提示词」→ 发一条会触发 bash 的任务 →
   取新会话日志跑 `node tools/verify-session.mjs <log> --preset liangshen-empty-system`；
   主预设同日再跑一次回归（B4）；
4. 证据归档 `.superpowers/sdd/` 并更新状态文档。

## 6. 未验证 / 风险

- **真实 wire 断言（B1/B2/B3）必须真实会话**：本设计完成时只能保证组合文件、注册与单测；
  若模型适配层对 system prompt 做 trim/省略，D1 记录并回报，不擅自改判据。
- persona 版本自适应块依赖安装的 `@deepseek-ai/dsh-persona` 版本探测；与主预设同源风险一致。
- 组合生成器是新增维护点：主组合改动若忘记跑生成器，单测会红（可机器拦，符合项目纪律）。
