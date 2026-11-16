# @mosire/dshom

DSH Optimize Mosire 的**默认入口 bundle**：把梁神预设、goal 确认、子 Agent 控制、后台任务工具、Session 导入、prompt-lab 编排和会话查看收进一个插件行。

> **2026-11-10：本 bundle 只保留 Host half，客户端 half（聊天时间标注 + composer dock 的 goal 开关）已移除。**
> DSH 0.2.2 的 composerSeat 带 `will-change:transform`，是 `position:fixed` 后代的包含块；
> 旧 client half 把 fixed 标签/菜单渲染在 `conversation.composer.dock` 里，坐标被容器劫持，
> 会出现时间标签飘到输入框/屏外、goal 菜单错位等显示问题。详见
> `.agents/notes/implemented/2026-11-10-remove-chat-timing-client.md`。
> `/goal-confirm` 命令与提问卡片第三项仍由 Host half 提供，只是不再有 composer dock 小开关。

> **2026-11-16：所有功能和三个预设都可以单独开关；每个功能包也补上了自己的 `dsh.bundle.patch`，可以脱离 dshom 单独安装**（见「独立子包」）。

## 两种装配布局（2026-11-16）

| 布局 | profile 里列什么 | 插件页看到什么 | 开关方式 |
|---|---|---|---|
| 单 bundle（dshom） | 只列 `@mosire/dshom` | 1 个条目，1 个组件 | `config.features` / `config.presets` |
| 拆分 bundle（当前 3080 profile 使用） | 预设 bundle + 6 个功能 bundle | **7 个条目**；预设 bundle 页内 3 个预设组件 | 在插件页逐个开关（写入 profile patch 的 `disabled` 行） |

两种布局**二选一**；同时启用会重复 `apply()`。

| 功能 | 实现 | 默认 | 开关 |
|---|---|---|---|
| 三个预设（`liangshen` / `liangshen-empty-system` / `minimal-prompt-lab`） | `../dsh-liangshen-anchored/lib/index.js` | 全开 | `presets.*` |
| goal 续轮确认门 | `../dsh-goal-confirm/lib/index.js` | 开 | `features.goalConfirm` |
| 父→子 Agent 控制工具（`subagent_list/message/interrupt/wait`） | `../dsh-subagent-access/lib/index.js` | 开 | `features.subagentAccess` |
| 后台任务 `job_wait` / `job_read` | `../dsh-job-tools/lib/index.js` | 开 | `features.jobTools` |
| Session 日志导入（`/import <路径>`） | `../dsh-session-import/lib/index.js` | 开 | `features.sessionImport` |
| Prompt-lab 会话编排（`prompt_lab_workspaces` / `prompt_lab_session`） | `../dsh-prompt-lab-session/lib/index.js` | 开 | `features.promptLabSession` |
| 会话查看（`session_list` / `session_read` / `session_find`） | `../dsh-session-inspect/lib/index.js` | 开 | `features.sessionInspect` |

Host 入口按需调用各功能的既有 `apply`，不复制业务代码。四个工具组共享一个锚定 gate：
梁神模式下首次持久信号前不挂载、晋升后挂载、压缩后再卸载。
预设组合位于 `packages/dsh-liangshen-anchored/presets/`（由该包自己的 peer symlink 农场解析 `@deepseek-ai/*`）。

**版本无关**：peer 农场在每次 Host 激活时从运行中的 DSH 安装重建（`process.argv[1]` realpath，回退 `/proc`），
不持久化 pnpm 版本目录；DSH 升级后不需要手动重链。装好后跑 `node tools/doctor.mjs` 可检查
`dsh.profile.bundles` 条目、farm 链接与上次 preset 状态；`--fix` 会重新加回 bundle 条目并刷新 farm。

## 配置（单 bundle 布局）

```yaml
- id: dshom
  name: '@mosire/dshom'
  config:
    features:
      presets: true          # 三个预设（另见 presets 子开关）
      goalConfirm: true
      subagentAccess: true
      jobTools: true
      sessionImport: true
      promptLabSession: true
      sessionInspect: true
    presets:                 # 不写＝全部 true
      liangshen: true
      emptySystem: true
      promptLab: true
    goalConfirm:
      timeoutSeconds: 30
      cancelOnClose: true
    subagentAccess:
      includeDelegatedAgents: false
    jobTools:
      defaultTimeoutSeconds: 600
      maxTimeoutSeconds: 3600
      maxBytes: 16384
      defaultLines: 200
    sessionImport:
      maxBytes: 1073741824
```

- 只关闭某个**功能**：对应 `features.*` 置 `false`（缺服务时本来也会 fail-open 跳过）。
- 只关闭某个**预设**：`presets.<key>` 置 `false`。键名是 `liangshen` / `emptySystem` / `promptLab`；
  未知键或非布尔值在激活时直接报错（避免 profile 里拼错后静默少一个预设）。关闭 `promptLab` 时
  其 Host half（`prompt-lab` 投影 + `pre-switch` 守卫）也不再安装。
- `goalConfirm.timeoutSeconds: 0` = 会话等待人工确认（不自动继续）。会话级开关不写配置，而是用
  `/goal-confirm on|off|wait|timeout <秒>|reset` 或提问卡片第三项；状态由会话日志里的
  `command/run` 经 projection `goal-confirm` 重建（详见 `../dsh-goal-confirm/README.md`）。

## 独立子包（可选）

每个功能包现在都有自己的 bundle patch，可以**脱离 `@mosire/dshom` 单独安装/启用**：

| 包 | bundle 行 id | 单独启用后安装 |
|---|---|---|
| `@mosire/dsh-goal-confirm` | `goal-confirm` | `/goal-confirm` + goal 卡片 |
| `@mosire/dsh-subagent-access` | `subagent-access` | 四个 `subagent_*` 工具 |
| `@mosire/dsh-job-tools` | `job-tools` | `job_wait` / `job_read` |
| `@mosire/dsh-session-import` | `session-import` | `/import` |
| `@mosire/dsh-prompt-lab-session` | `prompt-lab-session` | `prompt_lab_*` 两个工具 |
| `@mosire/dsh-session-inspect` | `session-inspect` | `session_list/read/find` |
| `@mosire/dsh-liangshen-anchored` | `liangshen-anchored` | 三个预设（可用 `config.presets` 再筛） |

用法：把包加进 profile 的 `dsh.profile.bundles`（本机为 `link:` 到 `packages/<name>`），
**不要同时启用 `@mosire/dshom`**——两者会各 `apply()` 一遍，工具重复注册。
单独安装的四个工具体在 `apply(ctx, config)` 没有外部 gate 时会自建一个锚定 gate，
所以即使只装「预设 bundle + 某个功能 bundle」，梁神模式首轮也不会泄漏该功能的工具。

> 本仓没有 pnpm workspace 根，包之间仍以相对路径互相引用（例如功能包引用 `../dshom/tool-gate.js`）；
> 发布到 npm 前需要把这些实现收进各自包或建 workspace。详见状态
> `docs/superpowers/status/2026-11-16-subpackages.md`。
