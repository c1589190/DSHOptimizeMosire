# 2026-11-04 功能九：极简模式·提示词实验（prompt-lab）

**状态：已实现；真实 E2E 8/8；单测 251/251；待用户重启 3080 Host 后在 Web 里选预设验收。**
设计：`docs/superpowers/specs/2026-11-04-prompt-lab-preset-design.md`；计划：`docs/superpowers/plans/2026-11-04-prompt-lab-preset.md`；
裁定：D-026~D-029（根 `AGENTS.md` §七）。

## 一、这轮交付了什么

| 层 | 文件 | 作用 |
|---|---|---|
| 预设 | `packages/dsh-liangshen-anchored/presets/minimal-prompt-lab/agent.cordis.yml` | 官方 Minimal 组合逐行照抄；persona 行换成本地 provider，另加 `/sp` 命令行 |
| provider | `…/minimal-prompt-lab/prompt-lab-persona.mjs` | 注册 `deployment:persona-prefix`（`complete:true`、`interpolate:false`），每次 assembly 从 `prompt-lab` projection 解析本会话提示词 |
| 命令 | `…/minimal-prompt-lab/prompt-lab-command.mjs` | `/sp file <path> \| text <一行> \| blank \| clear \| show`（preset-scoped） |
| 状态 | `packages/dsh-liangshen-anchored/lib/prompt-lab-state.js` | 无依赖状态机：解析命令、读文件校验、折叠 `command/run`+`command/done`+`system/message`、冻结/待切换判定、projection 定义、pre-step 守卫 |
| 宿主 | `packages/dsh-liangshen-anchored/lib/index.js` | 声明第三预设（order 4、per-spec root）；注册 projection；注册 `agent/pre-step` 守卫（pending 时返回 `startsRequestSeries:true`） |
| 验证 | `tools/verify-prompt-lab.mjs` | 读会话 JSONL：预设、官方 Minimal 工具面、单条非空 system、无身份串、首条=文件 A、头=文件 B |
| 证据脚本 | `.superpowers/sdd/2026-11-04-prompt-lab/evidence/e2e-prompt-lab.mjs` | 进程内 `runProfile` 启动 web Host:3099，空白会话 `/sp A` → 对话 → `/sp B` → 对话 → 分析 |

工具面：预设自有行只有 `bash` + `read_image`（无 read/write/edit）；web profile 宿主插件另行追加 profile 级工具（实测 56 个，与官方 `minimal` 完全一致）。

## 二、验证到哪一层

**单测**：`node --test packages/*/test/*.test.mjs` → **251/251 通过**。
其中 prompt-lab 新增：state 13、command 6、persona 5、composition 5、host 2、verifier 7；`presets.test.mjs` 扩到 3 个预设（4/4）。

**真实 E2E（3099，in-process `runProfile`，live `~/.dsh`）**：
- 会话 `session-6eaacc2c-002c-48be-ab41-89312906fe0f`，cwd `/tmp/dsh-prompt-lab-kQCtaC/ws`；
- 空白会话 `/sp file prompt-a.md` → 首轮；中途 `/sp file prompt-b.md` → 次轮；
- 8/8 检查为真：header、预设 `minimal-prompt-lab`、官方 Minimal 工具面、首步无预设注入、**恰好一条非空 system 节点**、无 harness 身份、会话头 sha = prompt-b、首条 system sha = prompt-a；
- surface 证据：`system/message` seq 9 append A，seq 28 `surfaceOp {op:'replace', startSeq:9, endSeq:9}` B；
- 同 Host 官方 `minimal` 对照：工具目录 56=56、注入 `["runtime-context"]` 相同、system 单节点为官方 persona；
- 落盘会话 CLI：`node tools/verify-prompt-lab.mjs <session.v4.jsonl.zstd> --system-file prompt-b.md --initial-file prompt-a.md` → exit 0，8 checks，`failures: []`。

证据目录：`.superpowers/sdd/2026-11-04-prompt-lab/evidence/{e2e-prompt-lab.mjs,e2e-events.jsonl,e2e-control-events.jsonl,verify-report.json}`（本机留痕，不进 git）。

## 三、还没验的（不许写成通过）

- `/sp clear`、`/sp text`、`/sp blank` 只有单测，没有真机跑；
- 文件改动后的冻结（B2）只有单测；fork/resume 的继承只有单测；
- 其它预设会话里看不到 `/sp`（隔离）只有单测；
- Windows（pwsh 分支）未验；
- 3080 当前 Host 仍是旧代码，预设要重启后才出现。

## 四、重启 3080 后的验收清单

1. 重启 3080 Host（加载新 Host 代码与第三预设）。
2. 新会话，预设选「极简模式·提示词实验」。
3. 发消息前执行 `/sp file /abs/prompt.md`；`/sp show` 应显示来源、字节、sha256、状态。
4. 发第一条消息；会话第一条 `system/message` 应等于文件内容（无 persona/身份/注入）。
5. 对话中途 `/sp file /abs/prompt2.md`，再发一条消息；应看到第一条 system 被替换（旧提示词消失），代价是整段缓存失效——这是设计预期。
6. 依次试 `/sp blank`、`/sp text …`、`/sp clear`（clear = 回到官方 persona）。
7. 用 `tools/verify-prompt-lab.mjs` 对落盘会话复核。
8. 如有需要，再验 fork/resume 与其它预设会话（不应出现 `/sp`）。

## 五、已知边界

- 硬替换依赖 `agent/pre-step` 返回 `startsRequestSeries: true`（目前官方只有 goal-round-driver 这么用）；若未来 DSH 改语义，回退方案 A（原生追加，旧提示词留在历史里）。
- 本预设不注入 runtime-context 之外的任何自动上下文；`runtime-context` 是 profile 级每轮 user 消息，官方 minimal 同样有。
- 预设组合是官方 Minimal 的**抄写**，不是引用；官方升级时需要跑 `tools/verify-prompt-lab.mjs` 或人工对照 `@deepseek-ai/dsh-web-app/presets/minimal.patch.yml`。
- 命令只在本预设会话可见；没有全局默认，每个会话用 `/sp` 显式选。
