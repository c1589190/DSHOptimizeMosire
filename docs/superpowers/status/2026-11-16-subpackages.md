# 2026-11-16 子包化：功能独立 bundle + 预设独立开关

## 触发

用户 2026-11-16：「现在能不能把几个预设、几个功能分别做成可独立开关的子包？让插件更加规范。」
经口径确认，用户选择 **A：功能拆独立 bundle + 预设加开关**（不拆预设包）。

## 调研（官方形态，回代码核过）

- `@deepseek-ai/dsh-web-app@0.2.2-rc.3`：**一个包带 4 个预设**（`standard/ptc/minimal/cordis`），
  `dsh.bundle.patch` 是**数组**（`./cordis.patch.yml` + `presets/*.patch.yml`）。
  官方预设由 `@deepseek-ai/dsh-agent-preset` 行内联 `config.plugins` 声明；多预设同包是官方常态。
- 第三方 bundle（`dsh-deja@0.21.7`、`superpowers-dsh@0.4.0`、`dsh-plugin@2.3.9`）：单包 + 单 `cordis.patch.yml` 多行。
- 因此「预设拆独立包」不是规范要求；真正的缺口是 **4 个功能包没有自己的 bundle patch**，以及 dshom
  用相对路径跨包 import（本仓无 workspace 根，发布前需收包）。
- 功能拆包有一个硬约束：`dsh-job-tools` / `dsh-prompt-lab-session` / `dsh-session-inspect` /
  `dsh-subagent-access` 的 `apply(ctx, config, gate)` 依赖 dshom 传入的共享 **tool-gate**
  （锚定预设首轮不挂载这些工具组）；单独安装时第三参为空，会直接泄漏首轮工具。

## 改动

1. **4 个功能包补独立 bundle**
   - 新增 `cordis.patch.yml`：`dsh-job-tools`（`job-tools`）、`dsh-session-import`（`session-import`）、
     `dsh-prompt-lab-session`（`prompt-lab-session`）、`dsh-session-inspect`（`session-inspect`）。
   - `package.json` 增加 `dsh.bundle.patch` 与 `files: [..., "cordis.patch.yml"]`。
   - `dsh-goal-confirm` / `dsh-subagent-access` / `dsh-liangshen-anchored` 原有 patch 保留。
2. **独立安装时的 gate 兜底**
   - `dsh-job-tools`、`dsh-prompt-lab-session`、`dsh-session-inspect`、`dsh-subagent-access`：
     `apply(ctx, config, gate)` 在没有外部 gate 时自建 `createToolGate(ctx)`（`../../dshom/tool-gate.js`），
     锚定预设首轮仍不挂载、晋升后再挂载。
3. **独立安装时的服务时序**
   - 四个包补 `export const inject`（job-tools→`agents/jobs`；prompt-lab-session→`agents/sessionController/commands/workspaceRegistry`；
     session-inspect→`agents/sessionQuery`；session-import→`commands/sessionPersistence`）。
     单独作为 bundle 行时由 Loader 等到服务就绪再 apply；经 dshom 手动调用时不受影响。
     （实机证据：加 `inject` 前 job-tools 以 `missing-services` 空跑，加后正常安装。）
4. **预设独立开关**
   - `packages/dsh-liangshen-anchored/lib/index.js`：`config.presets`（键 `liangshen` / `emptySystem` / `promptLab`，
     缺省全 `true`）；`normalizePresetSelection()` 校验未知键/非布尔值；`declarePresets` 只声明启用的预设；
     `promptLab: false` 时连 Host half（`prompt-lab` 投影 + 切换守卫）也不安装；状态文件新增 `enabled`。
   - `packages/dshom/index.js`：把 `source.presets` 透传给预设模块。
5. **文档**
   - `packages/dshom/README.md`：功能/预设开关表 +「独立子包」清单 + 混用警告。
   - `packages/dsh-liangshen-anchored/README.md`：`config.presets` 用法。
   - 根 `README.md`：配置示例加 `presets`，并指向独立子包说明。

## 验证

- 单测（`node --test test/*.test.mjs`，逐包）：

  | 包 | 结果 |
  |---|---|
  | dsh-liangshen-anchored | 127/127 |
  | dsh-goal-confirm | 53/53 |
  | dsh-subagent-access | 32/32 |
  | dsh-job-tools | 19/19 |
  | dsh-session-import | 28/28 |
  | dsh-prompt-lab-session | 12/12 |
  | dsh-session-inspect | 14/14 |
  | dshom | 14/14 |

  合计 **299/299**。空预设变体 `node tools/sync-preset-variant.mjs --check` → `in sync`。
- 真实 E2E（in-process `runProfile`，web profile，3099，live `~/.dsh`）：
  1. **默认 GUI 流程回归**：`create`（无 preset）→ `select liangshen` → 首请求 `["bash","str_replace_editor"]`、
     feature 工具 0 个、零注入；晋升后 73 工具。`analysis.ok=true`。证据
     `.superpowers/sdd/2026-11-16-preset-switch-anchor/evidence/verify-switch.json`。
  2. **预设开关**：overlay `dshom.config.presets = {emptySystem:false, promptLab:false}` →
     本仓预设只剩 `liangshen`，官方 `standard/ptc/minimal/cordis` 不受影响，`broken` 为空。
     证据 `.superpowers/sdd/2026-11-16-subpackages/evidence/verify-preset-switch.json`。
  3. **独立 bundle 组合**：overlay 关闭 `dshom`，只启用 `@mosire/dsh-liangshen-anchored` + `@mosire/dsh-job-tools`
     （临时把 job-tools link 进 profile，测试后删除）→ 首请求仍为 Minimal 双工具、`job_*` 不在首请求；
     晋升后 64 工具且包含 `job_wait`/`job_read`。证据
     `.superpowers/sdd/2026-11-16-subpackages/evidence/verify-standalone-bundle.json`。

## 未验证 / 注意

- **不要混用** `@mosire/dshom` 与独立功能 bundle：两者都会 `apply()`，工具会重复注册；当前没有自动检测，只写在 README。
- 独立 bundle 需要把包加进 profile（本机为 `link:`）；本轮 E2E 用临时 symlink，测试后已删除，profile 未切换。
- 本仓没有 pnpm workspace 根，包之间仍是相对路径 import（例如功能包引用 `../dshom/tool-gate.js`）；
  发布 npm 前需要建 workspace 或把实现收进各自包。
- 3080 Host 未重启；默认 `@mosire/dshom` 行为不变（全开）。要用 `config.presets` / 独立 bundle 需改 profile 后重启。
- 子 Agent 首轮 4 工具（`job_wait`/`job_read` 泄漏）这一已知缺口本轮未动，见
  `docs/superpowers/status/2026-11-15-plugin-inventory.md`。

## 2026-11-16 收尾：profile 切到 7-bundle 布局（用户反馈「不还是只有一个包」）

用户看到插件页「包含的组件 共 1 个」，指出代码拆包没有反映到**安装形态**。处理：

- **预设 bundle patch 改为 3 行**：每行只声明一个预设（`config.presets` 子集 + `statusMode: merge`），
  插件页因此显示 3 个可独立开关的预设组件。`writeStatus` 增加 merge 模式（按 `$DSH_HOME` 路径合并，
  三行不会互相覆盖诊断文件），peer farm 改为进程内只重建一次。
- **本机 web profile**（`~/.dsh/profiles/web/package.json`，不在 git 内）：
  - `dsh.profile.bundles` 用 7 个 bundle 替换 `@mosire/dshom`：
    `liangshen-anchored` + `goal-confirm` + `subagent-access` + `job-tools` + `session-import` + `prompt-lab-session` + `session-inspect`；
  - dependencies 补 7 个 `link:`，4 个新包补了 `node_modules/@mosire/*` 符号链接；
  - 备份：`package.json.bak-subpackages-2026-11-16` / `cordis.patch.yml.bak-subpackages-2026-11-16`。
- **`tools/doctor.mjs` 支持两种布局**：拆分布局下逐个校验已列 bundle 的依赖/link/patch，
  不再把 `@mosire/dshom` 强行加回（之前会误判并破坏拆分布局）。
- 文档：dshom README 增「两种装配布局」；preset README 说明 patch 3 行；根 README 标注当前 profile 布局。

### 验证

- `dsh --profile web --dump-config`：出现 3 个 preset 行（`preset-liangshen` / `preset-liangshen-empty-system` /
  `preset-minimal-prompt-lab`）+ 6 个功能行；无 `@mosire/dshom` 行。
- 真实 3099 E2E（拆分布局）：
  - 预设列表含本仓 3 个且 `broken:null`；GUI「创建→切 liangshen」首请求仍 `["bash","str_replace_editor"]`、零注入，
    晋升后含全部 feature 工具；
  - profile patch `- id: preset-liangshen-empty-system disabled: true` → 本仓预设剩 `liangshen` + `minimal-prompt-lab` 两个；
  - `node tools/doctor.mjs` → **OK**（拆分布局，3 个未列 bundle 记为 disabled note）。
- 单测：`dsh-liangshen-anchored` **128/128**（新增 merge 状态测试）；其余同前，合计 **300/300**。
  空预设变体 `in sync`。
- 证据：`.superpowers/sdd/2026-11-16-preset-switch-anchor/evidence/verify-switch.json`（拆分布局回归）、
  `.superpowers/sdd/2026-11-16-subpackages/evidence/verify-preset-switch.json`（行级关闭）。

### 注意

- profile 的 7-bundle 改动是**本机环境**，不在 git 内；3080 必须重启才会在插件页看到 7 个条目 / 3 个预设组件。
- 单 bundle 布局（`@mosire/dshom`）仍可用，配置开关见 dshom README；两种布局不要同时启用。
- 预设 3 行的诊断文件是合并写入（下一个 tick），重启后 `liangshen-anchored-status.json` 应显示 3 个 `broken:null`。
