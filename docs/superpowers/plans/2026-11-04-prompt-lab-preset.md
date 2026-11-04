# 极简模式·提示词实验（prompt-lab）实现计划 · 功能九

> 对应 spec：`docs/superpowers/specs/2026-11-04-prompt-lab-preset-design.md`（已定，2026-11-04）。
> 原则：官方 Minimal 基底零改动（除 persona 行）；状态只从 session log 重建；切换 = 硬替换（B）；未实机的层不写「通过」。

## Global Constraints

- 预设：id `minimal-prompt-lab`、name `极简模式·提示词实验`、order 4；现有 5/6 两个预设零改动。
- 工具面 = `bash` + `read_image`；不启用 read/write/edit，不引入 skills/goal/todo/web/delegation。
- 系统提示词 = 官方 persona 行（未 `/sp`）/ 文件 / 内联文本 / 单个空格；`complete:true` 唯一段。
- `/sp` 只在本预设会话可见；命令 handler 不写 session；不写任何旁路状态文件/全局默认。
- 状态 key `prompt-lab`、stateVersion 1；包无运行时依赖（只用 node: 内置模块）。
- 文件上限 256 KiB；UTF-8、去 BOM、拒 NUL/空文件；sha256 对去 BOM 文本。
- 真实 wire 未跑前只声称「单测/组合/注册」层。

## Task 1: 状态模块（TDD）

**Files:** `packages/dsh-liangshen-anchored/lib/prompt-lab-state.js`（新）；
`packages/dsh-liangshen-anchored/test/prompt-lab-state.test.mjs`（新）。

- [x] Step 1: 写失败测试：`parsePromptLabInput`（file/text/blank/clear/show/未知/空/路径含空格）、`resolveSelectionPath`（绝对/相对/无 cwd）、`readPromptFile`（BOM/空/纯 BOM/NUL/超限/正常）、`applyPromptLabEvent`（run→done success 生效、done error 丢弃、半截 run 不生效、system/message 更新快照、非 sp 事件忽略）、`isSwitchPending`（空白会话/已冻结/无选择/clear）、`resolveLabPrompt`（无状态→persona；pending file→文本；冻结→快照；文件坏→快照/ persona + error；pending default→persona）。
- [x] Step 2: 实现常量、parse、路径、文件读取、状态折叠、pending、resolve、`makeSwitchGuard`、`makePromptLabProjection`、轻量 schema。
- [x] Step 3: 运行 `node --test packages/dsh-liangshen-anchored/test/prompt-lab-state.test.mjs` 直至全过。

## Task 2: `/sp` 命令插件

**Files:** `packages/dsh-liangshen-anchored/presets/minimal-prompt-lab/prompt-lab-command.mjs`（新）；
`test/prompt-lab-command.test.mjs`（新，纯函数格式化 + 假 ctx 注册）。

- [x] Step 1: 失败测试：`inject=['commands']`；`apply` 注册 `name='sp'`；`formatShow` 三种状态；handler 对空文件/坏文件返回 error、对 file 返回路径+字节+sha、对 text 不回声全文。
- [x] Step 2: 实现 `apply`（`ctx.effect(() => ctx.commands.register(definition))`）+ handler（读 projection state，校验，返回 `{kind,text}`）。
- [x] Step 3: 测试全过。

## Task 3: persona provider 插件

**Files:** `presets/minimal-prompt-lab/prompt-lab-persona.mjs`（新）；`test/prompt-lab-persona.test.mjs`（新，假 ctx）。

- [x] Step 1: 失败测试：`inject=['systemPrompt']`；section 参数 `name='deployment:persona-prefix'`、`complete:true`、`interpolate:false`、`order=getSectionOrder(...)`；`suppressRuntimeContext` 被调用；provider 无 agent/projection 时返回官方 persona；有 agent 时按 state 返回文件/快照。
- [x] Step 2: 实现。
- [x] Step 3: 测试全过。

## Task 4: 组合 + 预设声明

**Files:** `presets/minimal-prompt-lab/agent.cordis.yml`（新）、`preset.yml`（新）；
`lib/index.js`（加第三预设 + `root` 支持）；`test/presets.test.mjs`（改 3 个）；`test/prompt-lab-composition.test.mjs`（新）。

- [x] Step 1: 写组合：官方 minimal 的 rows（tool-fs / compaction group / persistent-shell group）+ 本地 persona/command 两行 + 头注释（来源/漂移警告）。
- [x] Step 2: 写 `preset.yml`（name/description/order 4）。
- [x] Step 3: 改 `lib/index.js`：`PRESETS` 第三项 `{root}`；`readMetadata(spec, root)` / `declareOne` 用 `spec.root ?? PRESET_ROOT`。
- [x] Step 4: 更新 `presets.test.mjs`（3 个、order 4/5/6、URL 存在、status.presets 长度 3）；新增组合测试（rows/config、工具面、本地文件存在、无 `@deepseek-ai/dsh-persona` 行）。
- [x] Step 5: 测试全过；`node --check`。

## Task 5: Host 注册（projection + pre-step 守卫）

**Files:** `lib/index.js`（`apply` 里注册 projection 与守卫）；`test/prompt-lab-guard.test.mjs`（新）。

- [x] Step 1: 失败测试：`makeSwitchGuard` 在 pending+enter 时返回 `startsRequestSeries:true`；pending 但 reject 不改；非 pending 不改。
- [x] Step 2: 实现 `installPromptLab(ctx)`：`ctx.get('sessionProjections')` 可用 → `register(makePromptLabProjection())`；否则 `ctx.inject(['sessionProjections'], ...)`；`ctx.on('agent/pre-step', makeSwitchGuard(...), {prepend:true})`。
- [x] Step 3: 测试全过；确认 `declarePresets` 单测不受影响（apply 未被测试调用）。

## Task 6: 验证器扩展

**Files:** `tools/verify-session.mjs`、`test/verify-session.test.mjs`。

- [x] Step 1: 失败测试：`--preset minimal-prompt-lab --system-sha256 <hex>` 通过；sha 不匹配失败；`minimal-prompt-lab` 不要求 liangshen 的 bootstrap 双工具。
- [x] Step 2: 实现：新增 `--system-sha256 <hex>`（独立断言，任意 preset）；`minimal-prompt-lab` 的默认 mode 为 `free`（只断言非空 system + 无 harness identity），工具检查改为「bash 必须在，read_image 必须在」。
- [x] Step 3: 测试全过。

## Task 7: 实机 E2E（临时 Host）

- [ ] Step 1: 临时 `DSH_HOME=/tmp/dshhome-prompt-lab` + 3099 Host 装载 bundle；状态文件三预设 `broken:null`。
- [ ] Step 2: 空白会话先 `/sp file /tmp/exp-a.md` → 首请求 system == 文件；改文件再发 → 冻结。
- [ ] Step 3: 中途 `/sp file /tmp/exp-b.md` → 下一请求第一条 system 换成 B，A 不在 surface；`/sp clear` → persona。
- [ ] Step 4: `--system-sha256` 断言；证据写 `.superpowers/sdd/2026-11-04-prompt-lab/`。
- [ ] Step 5: 若临时 Host 不可行：记录未跑，给用户 3080 重启后的验收命令。


> **执行记录（2026-11-04）**：临时 3099 Host 以 in-process `runProfile` 启动（web profile、live `~/.dsh`，未用临时 `DSH_HOME`）；preset 列表含 `minimal-prompt-lab`；空白会话 `/sp file A` → 首条 `system/message` == A（B1 ✓）；中途 `/sp file B` → 头部被 `surfaceOp {op:'replace'}` 替换、surface 只剩一个非空节点（C1 ✓）；官方 `minimal` 对照工具目录同为 56 个、`runtime-context` 基线相同；持久化会话 verifier exit 0；证据 `.superpowers/sdd/2026-11-04-prompt-lab/evidence/`。
> **未真机**：文件改动后的冻结（B2）、`/sp clear`（C2）、`/sp text`/`/sp blank`（D1）、其他预设隔离（E1）、fork/resume（E2）、请求前删文件（F1）——仅单测。
## Task 8: 收尾

- [x] Step 1: 全量测试 `node --test packages/*/test/*.test.mjs`（0 失败）。
- [x] Step 2: 更新根 `AGENTS.md`（功能九 + D-026..D-029 + 当前门禁）、状态文档、决策记录 `.agents/notes/implemented/2026-11-04-prompt-lab-preset.md`。
- [x] Step 3: `git status` 自查完成；commit/push 等用户批准（未提交）。
