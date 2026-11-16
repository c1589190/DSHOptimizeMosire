# 2026-11-15 插件实际形态与功能盘点（9 包 / 3 预设 / 6 组常驻能力）

> 2026-11-16 补记：本文「顶层会话首请求 = 2 工具」的证据来自**程序化创建**（`controller.create({agentPreset})`）。
> GUI 新建会话走的是「先默认创建、首轮前 `agent-preset/selected` 切换」，该路径当时不生效；已修复，
> 见 `docs/superpowers/status/2026-11-16-preset-switch-anchor.md`。

## 触发

用户 2026-11-15：「能梳理一下当前目录下插件实际为什么模式提供什么功能吗」；随后「修复吧」＝
把这份梳理按 `docs/AGENTS.md` 规范落盘，并修掉根 `README.md` 的过期描述。
本轮**只动文档**（README + 本文件 + AGENTS.md 索引一行），不改任何插件代码。

> 口径更正：会话内先前的口头梳理把包数说成「10 个」，实测 `ls -d packages/*/` 为 **9 个**；
> 以本文与下列命令输出为准。

## 一、结论

- **装载模式（怎么进 Host）**：仓库 9 个包，web profile 的 `dsh.profile.bundles` 里本仓条目**只有 `@mosire/dshom`**。
  它是 **Host-only** bundle（`package.json` 无 `dsh.client`），patch 只插一行（`packages/dshom/cordis.patch.yml`），
  Host 入口用相对路径 `import` 组合 7 个实现包（`packages/dshom/index.js:10-17`），并按 `config.features` 逐项启用
  （`packages/dshom/index.js:46-77`）。
- **模式（预设）**：`@mosire/dsh-liangshen-anchored` 在 Host 激活时向 `agentPresets` 注册 **3 个预设**：
  `liangshen`（梁神模式，order 5）、`liangshen-empty-system`（空系统提示词，order 6）、
  `minimal-prompt-lab`（极简模式·提示词实验，order 4）（`packages/dsh-liangshen-anchored/lib/index.js:58-90`）。
- **功能**：3 个预设由 1 个模块（`dsh-liangshen-anchored`）承载，加上 6 组 Host 常驻能力，正好对应 dshom 的 **7 个特性模块**
  （`packages/dshom/index.js:10-17`）；剩下的第 9 个包 `@mosire/dsh-timing-annotations` 是 2026-11-10（D-033）
  退役的客户端 half，未进 profile，不参与运行。

## 二、装载拓扑（包 → 形态 → 是否实际启用）

| 包 | 自带 `dsh.bundle` patch | 在 profile bundles | 实际角色 |
|---|---|---|---|
| `@mosire/dshom` | 有（只 insert 一行 `id: dshom`） | ✅ 唯一 | 组合入口；Host-only；7 个特性开关 |
| `@mosire/dsh-liangshen-anchored` | 有 | ❌ | 被 dshom 相对 import；注册 3 预设 + `prompt-lab` 投影 + `agent/pre-step` 守卫 |
| `@mosire/dsh-goal-confirm` | 有 | ❌ | 模块被 import；自带 patch 仅供「独立安装」 |
| `@mosire/dsh-subagent-access` | 有 | ❌ | 同上 |
| `@mosire/dsh-job-tools` | 无 | ❌ | 纯实现模块，只能经 dshom 启用 |
| `@mosire/dsh-session-import` | 无 | ❌ | 同上 |
| `@mosire/dsh-prompt-lab-session` | 无 | ❌ | 同上 |
| `@mosire/dsh-session-inspect` | 无 | ❌ | 同上 |
| `@mosire/dsh-timing-annotations` | 有（清单含 `dsh.client`） | ❌ | **退役遗留**（D-033）；不加载 |

注意：`~/.dsh/profiles/web/node_modules/@mosire/` 仍留着 4 个旧 bundle 的 link（`dsh-goal-confirm`、
`dsh-subagent-access`、`dsh-timing-annotations`、`dsh-liangshen-anchored`）——**不在 bundles 列表＝不加载**，属惰性残留。

结构提醒：仓库**没有根 `package.json` / `pnpm-workspace.yaml`**；profile 用 `link:` 指向 `packages/dshom`，
其余实现包由 dshom 的相对路径 `import` 触达（`packages/dshom/index.js:10-17`）。因此不能单独 `npm install` 某个实现包，
移动目录会直接断链；每个包自己跑 `node --test test/*.test.mjs`。

## 三、三种预设模式各自提供什么

| 维度 | `liangshen` | `liangshen-empty-system` | `minimal-prompt-lab` |
|---|---|---|---|
| 定位 | 锚定式复刻（首轮极简 → 晋升 → 压缩重锚） | 与梁神模式**完全一致**，仅系统提示词为单个 ASCII 空格 | 官方 Minimal 表面的系统提示词实验版 |
| 系统提示词 | 官方 Minimal 单行 persona（`complete:true`，无 runtime context） | 单空格 | 默认官方 Minimal 行，`/sp` 可覆盖；首个 `system/message` 即冻结 |
| 首轮 wire | 精确 2 工具：持久 `bash` + `str_replace_editor`；剥离 `skill-catalog`/`agent-instructions` 等自动注入 | 同左 | 持久 `bash`（Win 为 pwsh）+ `read_image`，与官方 Minimal 一致 |
| 晋升 | 首工具调用**或**首条 assistant 消息（`promoteOn: either`）→ 一次性放开完整目录 | 同左 | 不锚定（官方 Minimal 行为） |
| 压缩 | `compaction/end` 后重新锚定；首请求仅放行 `recovery-hint`（`allowKinds`） | 同左 | 官方压缩行为 |
| 技能 | 不注入技能目录，改 `skill_search` / `skill_load` 按需 | 同左 | 无技能行 |
| 指令文件 | 不注入 AGENTS.md 内容；晋升后一条 hint，每次压缩后一条恢复 hint | 同左 | 无 |
| 子 Agent | 子 Agent 首请求同样锚定（`includeSubagents: true`），默认 `reasoningEffort: high`，可按次选模型 | 同左 | 无子 Agent 工具 |
| 预设内命令 | 官方 `/compact` 等行 | 同左 | `/sp file\|text\|blank\|clear\|show` |
| 证据 | 最近落盘 `broken:null`；2026-11-10 E2E 12/12 | `broken:null`；压缩重锚未单独跑 | 2026-11-04 E2E 8/8 |

组合文件：主预设 `packages/dsh-liangshen-anchored/presets/liangshen/agent.cordis.yml:53-104`
（context-gate、tool-bootstrap）、`:152-157`（instruction-hint）、`:23-35`（注释说明 gate 必须最先）；
prompt-lab `packages/dsh-liangshen-anchored/presets/minimal-prompt-lab/agent.cordis.yml`。

## 四、6 组 Host 常驻能力

| 功能 | 承载包 | 暴露面 | 生效范围（实际） |
|---|---|---|---|
| goal 续轮确认门 | `packages/dsh-goal-confirm/lib/index.js:300-428` | `/goal-confirm on\|off\|wait\|timeout <0..3600>\|reset`；提问卡片三选项；会话投影 `goal-confirm` | 全 profile；子 Agent 跳过（`:316`）；默认 30s；失败一律放行 |
| 父→子控制面 | `packages/dsh-subagent-access/lib/index.js:323-379` | `subagent_list` / `subagent_message` / `subagent_interrupt` / `subagent_wait` | 默认只装顶层（`packages/dsh-subagent-access/lib/catalog.js:64-69`），`includeDelegatedAgents:true` 才下发 |
| 后台任务等待/读 | `packages/dsh-job-tools/lib/index.js:211-280` | `job_wait`（默认 600s、上限 3600s，超时不杀 job）；`job_read`（绝对偏移非消费读 + ANSI/CR 清理、head/tail/errors/summary） | 装进所有 Agent scope；锚定预设顶层由 tool-gate 延迟到晋升 |
| Session 日志导入 | `packages/dsh-session-import/lib/index.js:49-56` | `/import <zip\|jsonl\|jsonl.zstd 路径>`；整树导入、id 冲突改 `session-<uuid>`、附件内容寻址写回 | Host 命令；只收 v4，拒绝 `isSeeded:true` |
| prompt-lab 会话编排 | `packages/dsh-prompt-lab-session/lib/index.js:441-460` | `prompt_lab_workspaces`、`prompt_lab_session`（workspace 必填；可选 `prompt{file,text,blank,default}`、`model`、`task`） | 只装顶层，子会话跳过（`:617`） |
| 会话查看 | `packages/dsh-session-inspect/lib/index.js:597-760` | `session_list`、`session_read`（surface/raw/event）、`session_find`（单会话字面扫描，含 system 消息） | 只装顶层（`:848`）；只读；Web profile FTS 关闭，故为本地扫描 |

## 五、为什么梁神模式装了这些工具，首轮仍只有 2 个

两层闸门，缺一不可：

1. **官方工具面**：预设 `tool-bootstrap` 用 `agent.ctx.tools.restrict()` 把目录压到 `[bash, str_replace_editor]`
   （`packages/dsh-liangshen-anchored/presets/liangshen/tool-bootstrap.mjs:221-274`）；
2. **dshom 自己的工具组**：`packages/dshom/tool-gate.js:16-17` 定义锚定预设集合与晋升事件；
   `:101-113` 对锚定预设的顶层会话**先不挂载**，`session/event` 收到首持久信号才挂载，
   `:122-129` 在 `compaction/end` 时**重新卸载**。非锚定会话、子 Agent、已晋升会话立即挂载。

## 六、实测证据（2026-11-15 晚，本机）

1. 包数：`ls -d packages/*/ | wc -l` → `9`。
2. profile 里本仓条目：
   `node -e "const p=require('/home/cna/.dsh/profiles/web/package.json'); console.log(p.dsh.profile.bundles.filter(b=>/@mosire|@local/.test(b)))"`
   → `[ '@mosire/bma3-dsh', '@mosire/dshom', '@local/dsh-orbat-workbench' ]`（本仓只有 `@mosire/dshom`）。
3. 运行中的 3080 Host：`ps -o pid=,lstart= -p 192598` → `192598 Sun Nov 15 20:11:13 2026`；
   DSH 版本 `0.2.2-rc.3`（`node -e "console.log(require('<install>/@deepseek-ai/dsh/package.json').version)"`）。
4. 当前会话（本盘点所在会话）：`session_list(limit=40)` → `session-e51dc9f3…` preset=`standard`，cwd 为本仓库；
   另有 `session-609beacc…` / `session-3bc4a7bc…` preset=`liangshen`（历史验证会话）。
5. 实时工具目录：Host `Tool` inspect（`cordis_inspect_query`，provider `Tool`，method `listTools`）返回包含
   `job_wait`、`job_read`、`session_list/read/find`、`subagent_list/message/interrupt/wait`、
   `prompt_lab_session/workspaces` —— 共 **11 个 dshom 工具**，说明 Host-only bundle 在当前进程内已生效。
6. 特性状态文件（诊断用）：
   ```
   node -e "…遍历 ~/.dsh/*-status.json，打印 pid/activated/at…"
   → liangshen-anchored pid=303629 activated=- at=-
   → goal-confirm      pid=304635 activated=true at=-
   → subagent-access   pid=192598 activated=true at=2026-11-15T15:22:06.647Z
   → job-tools         pid=192598 activated=true at=2026-11-15T15:22:06.645Z
   → prompt-lab-session pid=192598 activated=true at=2026-11-15T15:22:06.648Z
   → session-inspect   pid=192598 activated=true at=2026-11-15T15:22:06.645Z
   ```
   `pid=192598` 即当前 3080 Host；`liangshen-anchored` / `goal-confirm` 两条是别的 Host 进程写的（见「未验证」）。
7. 单测（逐包跑）：
   ```
   cd packages && for d in dsh-liangshen-anchored dsh-goal-confirm dsh-subagent-access \
     dsh-job-tools dsh-session-import dsh-prompt-lab-session dsh-session-inspect dshom; do
     (cd "$d" && node --test test/*.test.mjs 2>&1 | grep -E '^# (pass|fail)'); done
   ```
   → `liangshen 122`、`goal-confirm 53`、`subagent-access 32`、`job-tools 18`、`session-import 28`、
   `prompt-lab-session 12`、`session-inspect 14`、`dshom 5`；**合计 284 pass / 0 fail**。
8. 空系统提示词变体同步：`node tools/sync-preset-variant.mjs --check`
   → `…/presets/liangshen/agent.empty-system.cordis.yml is in sync`。

## 七、本轮改动（仅文档）

- 新建本文件：插件形态/模式/功能/实测证据的单一入口盘点。
- 重写根 `README.md`：删掉「两个功能 / 设计与实现未开始（2026-10-17）」的过期描述，改为当前
  「Host-only 单 bundle + 3 预设 + 6 组常驻能力」并给出验证命令。
- `AGENTS.md` §四「状态与交接」新增本文索引，并把「最新状态」标记移到本文。

## 八、未验证 / 注意

- **3080 的预设注册未直接查询**：`liangshen-anchored-status.json` 当前由别的 Host 进程写入
  （pid 303629，2026-11-15 22:45；`goal-confirm` 为已退出的 pid 304635），3080 在 20:11 的激活记录已被覆盖。
  三个预设 `broken:null` 的口径来自该状态文件 + 组合单测，**不是**对 3080 进程内注册表的直接读取。
- 本轮**只跑单测**，没有重跑真实 E2E：压缩重锚、`/compact`、Windows 分支、liangshen 会话内「未晋升看不到
  dshom 工具」的实机复验均未做（此前证据见 `docs/superpowers/status/2026-11-10-remove-chat-timing-client.md`
  与 `2026-11-05-dsh-0.2.2-upgrade.md`）。
- `~/.dsh/*-status.json` 是诊断文件，多 Host 并存时会互相覆盖 `pid`；排查时先核对 pid 是否等于目标 Host。
- profile 的 `cordis.patch.yml` 未给 dshom 写 `config`，故 `features.*` 全走默认 `true`；
  要单项关闭需在 profile patch 里加 `id: dshom` 的 `config.features`。
