# @mosire/dshom

DSH Optimize Mosire 的**唯一入口 bundle**：一个安装条目，插件页里 **9 个可独立开关的组件**（预设 3 + 功能 6）。

> **2026-11-10：本 bundle 只保留 Host half，客户端 half（聊天时间标注 + composer dock 的 goal 开关）已移除。**
> DSH 0.2.2 的 composerSeat 带 `will-change:transform`，是 `position:fixed` 后代的包含块；
> 旧 client half 把 fixed 标签/菜单渲染在 `conversation.composer.dock` 里，坐标被容器劫持，
> 会出现时间标签飘到输入框/屏外、goal 菜单错位等显示问题。详见
> `.agents/notes/implemented/2026-11-10-remove-chat-timing-client.md`。
> `/goal-confirm` 命令与提问卡片第三项仍由 Host half 提供，只是不再有 composer dock 小开关。

## 组件清单（插件页「包含的组件」）

`cordis.patch.yml` 插入 9 行；插件页对每个组件提供独立开关，关闭时由插件管理页写回 profile patch
（例如 `- id: preset-liangshen-empty-system disabled: true`）。

| 组件 id | 来自包 | 提供 |
|---|---|---|
| `preset-liangshen` | `@mosire/dsh-liangshen-anchored/presets/liangshen` | 梁神模式预设（order 5） |
| `preset-liangshen-empty-system` | `@mosire/dsh-liangshen-anchored/presets/empty-system` | 空系统提示词预设（order 6） |
| `preset-minimal-prompt-lab` | `@mosire/dsh-liangshen-anchored/presets/prompt-lab` | 极简·提示词实验（含 `/sp` 投影与切换守卫） |
| `goal-confirm` | `@mosire/dsh-goal-confirm` | `/goal-confirm` + goal 续轮确认卡片 |
| `subagent-access` | `@mosire/dsh-subagent-access` | `subagent_list/message/interrupt/wait` |
| `job-tools` | `@mosire/dsh-job-tools` | `job_wait` / `job_read` |
| `session-import` | `@mosire/dsh-session-import` | `/import <路径>` |
| `prompt-lab-session` | `@mosire/dsh-prompt-lab-session` | `prompt_lab_workspaces` / `prompt_lab_session` |
| `session-inspect` | `@mosire/dsh-session-inspect` | `session_list` / `session_read` / `session_find` |

组件包必须能从 profile 的 `node_modules` 解析（本机是 `link:`）；dshom 的 patch 只负责按行挂载，
不再有旧的「一个 `dshom` 插件行统一 apply」形态。

## 安装

profile 的 `dsh.profile.bundles` 里只列一行 `@mosire/dshom`：

```yaml
- id: dshom
  name: '@mosire/dshom'
```

同时把 9 个组件包装进 profile（本机为 `link:` 到 `packages/*`）。装好后：

```sh
node tools/doctor.mjs        # 检查 bundle 条目 / 组件包 link / peer farm / 上次预设声明
```

`tools/doctor.mjs` 同时支持两种布局：本文件的「单 bundle 多组件」布局，以及「每个功能一个独立 bundle」的拆分布局。

## 独立子包（可选）

每个功能包和预设包也都有自己的 `dsh.bundle.patch`，可以**不装 dshom**，按需把其中几个列进
`dsh.profile.bundles`（预设 bundle 的 patch 会插 3 个预设行）。两种布局**二选一**，不要同时启用。

| 包 | 单独启用后安装 |
|---|---|
| `@mosire/dsh-goal-confirm` | `/goal-confirm` + goal 卡片 |
| `@mosire/dsh-subagent-access` | 四个 `subagent_*` 工具 |
| `@mosire/dsh-job-tools` | `job_wait` / `job_read` |
| `@mosire/dsh-session-import` | `/import` |
| `@mosire/dsh-prompt-lab-session` | `prompt_lab_*` |
| `@mosire/dsh-session-inspect` | `session_list/read/find` |
| `@mosire/dsh-liangshen-anchored` | 3 个预设行（可再按行开关） |

四个工具体在独立安装时会自建锚定 gate（`apply(ctx, config)` 的第三参为空时），所以「只装预设 bundle +
某个功能 bundle」也不会破坏梁神首轮；它们用 `export const inject` 等对应服务就绪后再挂载。

## 版本无关的 peer farm

预设的 `@deepseek-ai/*` row 由 `dsh-liangshen-anchored/lib/host-peers.js` 在每次 Host 激活时从运行中的 DSH 安装
（`process.argv[1]` realpath，回退 `/proc`）解析并重建 symlink farm；不持久化安装路径，DSH 升级后不需要手动重链。
多组件预设行共享一次农场重建。

`@mosire/dshom/index.js` 的 `apply()` 仍保留给「手动插一行 `@mosire/dshom`」的单行模式
（`config.features` / `config.presets` 只在这种手动模式下有效）；默认的组件布局不使用它。

> 本仓没有 pnpm workspace 根，包之间仍是相对路径 import（例如功能包引用 `../dshom/tool-gate.js`）；
> 发布 npm 前需要建 workspace 或把实现收进各自包。详见
> `docs/superpowers/status/2026-11-16-subpackages.md`。
