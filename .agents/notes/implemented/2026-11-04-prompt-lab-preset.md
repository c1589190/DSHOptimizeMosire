# 2026-11-04 提示词实验预设（prompt-lab）实现记录

- 状态：已实现；临时 3099 Host 真实 E2E 8/8；工作区单测 251/251；已提交并推送（`cedf7ae`，2026-11-04）。
- 关联 spec：`docs/superpowers/specs/2026-11-04-prompt-lab-preset-design.md`
- 关联计划：`docs/superpowers/plans/2026-11-04-prompt-lab-preset.md`
- 关联状态：`docs/superpowers/status/2026-11-04-prompt-lab.md`
- 用户原话：m00296「不要用梁神模式作为预设基底，而是极简模式 命令咋办？/sp file xxx.md 然后这个md文件就是系统提示词了？」；
  m00339「一个会话在开头导入一个文件里的系统提示词后，之后就一直用这个，直到手动用sp命令在对话期间切换，那么整个费缓存改注入，这也是我想要的」；
  m00405「为何是追加，我要的就是替换全会话的第一条，也就是B 也许可以开始了」。

## 为什么这么定（D-026~D-029）

**D-026 承载在 `@mosire/dsh-liangshen-anchored`，第三预设 `minimal-prompt-lab`。**
不新建包：预设声明、peer farm、`presets/**` 扫描、状态文件、测试都在既有包内，第三预设只是多一项 `PRESETS` 条目 + 一个组合目录。
组合逐行照抄 `@deepseek-ai/dsh-web-app/presets/minimal.patch.yml` 的 `plugins`，唯一改动是 persona 行换成本地 provider、另加 `/sp` 命令行。
这样「预设自有工具面」与官方 Minimal 完全一致（bash + read_image，无 read/write/edit）。

**D-027 系统提示词用 `complete:true` 的动态 section，中途切换硬替换。**
`deployment:persona-prefix` 的 `text` 可以接收 `(context) => string`，每次 assembly 求值；provider 从本会话 projection 里取选择，因此不需要重启 Host、不需要新会话。
`complete:true` + `suppressRuntimeContext()` + `interpolate:false` 保证 wire 上只有文件内容（不被 `{{}}` 插值，不加 persona 前后缀）。
中途切换要「替换第一条」而不是原生追加：`agent/pre-step` 守卫在 pending 时返回 `{...decision, startsRequestSeries:true}`，
`SystemPromptProjection.project` 走 replace 分支——旧 system 节点被墓碑化、头节点换成新文本，整段前缀缓存失效（用户明确要这个代价）。

**D-028 状态只从会话日志重建。**
`prompt-lab` projection 折叠 `command/run`/`command/done`（只有 success 才生效，崩溃/失败的 `/sp` 不落盘）+ 最近一条非空 `system/message`（冻结快照）。
没有旁路文件、没有全局默认；resume/fork 从同一日志重建，行为一致。代价是状态文案会随 projection checkpoint 复制一份，故有 256 KiB 上限。

**D-029 `/sp` 是 preset-scoped 命令，文件在下一次请求读取。**
命令只改「选择」，不触发 turn；provider 在下一 assembly 读文件。首个 `system/message` 就是快照，之后改文件不影响本会话。
空文件拒绝（要空提示词用 `/sp blank`）；UTF-8、去 BOM、NUL/超限拒绝；相对路径按会话 cwd 解析；`show` 只回元数据，不回显全文。

## 关键实现点

- `packages/dsh-liangshen-anchored/lib/prompt-lab-state.js`：无第三方依赖（包只有 peerDependencies）。
- `…/presets/minimal-prompt-lab/prompt-lab-persona.mjs`：`ctx.systemPrompt.section({name:'deployment:persona-prefix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), complete:true, interpolate:false, text})` + `ctx.systemPrompt.suppressRuntimeContext()`。
- `…/prompt-lab-command.mjs`：`inject=['commands']`，`ctx.effect(() => ctx.commands.register({name:'sp', …}))`；结果用 `{kind:'success'|'error', text}`。
- `lib/index.js`：`PROMPT_LAB_ROOT`；第三 `PRESETS` 条目（`root` 字段让 `readMetadata`/`declareOne` 用对目录）；`installPromptLab` 注册 projection 与 `agent/pre-step` 守卫（prepend）。
- `tools/verify-prompt-lab.mjs`：折叠 `surfaceOp`（append + replace），要求**恰好一条非空 system 节点**——原生追加会留下两条，因此它会失败；这是把「硬替换」变成机器判据的关键。

## 证据

- 单测：`node --test packages/*/test/*.test.mjs` → 251/251。
- 真实 E2E：`.superpowers/sdd/2026-11-04-prompt-lab/evidence/`（session `session-6eaacc2c…`；8/8 checks；官方 minimal 对照 56=56、注入一致；落盘 CLI exit 0）。
- 未验：`/sp clear|text|blank`、冻结、fork/resume、其它预设隔离、Windows（见状态文档第三节）。

## 被什么取代 / 后续

无取代。后续若要「空提示词也走文件」或「批量跑对照」，可直接在 `minimal-prompt-lab` 上扩展；不要把它和梁神模式混在同一个预设里（梁神模式的首轮锚定是另一条铁律）。
