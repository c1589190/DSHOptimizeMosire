# DSHOptimizeMosire（dshom）

「梁神模式」的现代复刻 + 功能优化：一个装进 DeepSeek Harness（DSH）的 **Host-only bundle**（`@mosire/dshom`）。

复刻基准是社区已停用的**锚定式（anchored standard）**实现——首轮只暴露 Minimal 双工具、剥离自动注入上下文、
首次工具调用后放开完整目录、压缩后重新锚定。装配形态、功能清单与实测证据见
[2026-11-15 插件实际形态与功能盘点](docs/superpowers/status/2026-11-15-plugin-inventory.md)。

> 2026-11-15：此前本 README 停留在 2026-10-17「调研完成、设计与实现未开始」的过期状态；实现已全部落地，
> 现按实测重写。唯一安装入口是 `@mosire/dshom`，客户端 half（聊天时间标注）已于 2026-11-10（D-033）移除。

## 交付内容

### 3 个 agent 预设（新建会话时选择）

| 预设 id | 名称 | 说明 |
|---|---|---|
| `liangshen` | 梁神模式 | 主/子 Agent 首轮均为 Minimal 双工具（持久 `bash` + `str_replace_editor`）、零自动注入；首工具调用或首条 assistant 消息后放开完整目录；压缩后重新锚定并注入一条恢复 hint |
| `liangshen-empty-system` | 梁神模式·空系统提示词 | 与 `liangshen` 完全一致，唯一差异是系统提示词为单个 ASCII 空格 |
| `minimal-prompt-lab` | 极简模式·提示词实验 | 官方 Minimal 工具面（`bash` + `read_image`）+ `/sp file\|text\|blank\|clear\|show` 会话级系统提示词；首个 `system/message` 即冻结，中途切换整段替换 |

### 6 组常驻能力（profile 级 Host 插件，默认全开）

| 能力 | 暴露面 |
|---|---|
| goal 续轮确认门 | `/goal-confirm on\|off\|wait\|timeout <秒>\|reset`、提问卡片、会话投影 `goal-confirm` |
| 父→子 Agent 控制 | `subagent_list` / `subagent_message` / `subagent_interrupt` / `subagent_wait` |
| 后台任务 | `job_wait`（等待不杀 job）、`job_read`（绝对偏移 + 字符优化，不消费游标） |
| Session 导入 | `/import <zip\|jsonl\|jsonl.zstd 路径>` |
| prompt-lab 编排 | `prompt_lab_workspaces`、`prompt_lab_session` |
| 会话查看 | `session_list` / `session_read` / `session_find`（只读，只装顶层会话） |

梁神模式下，四组**工具体**（subagent / job / prompt-lab / session）在**首个持久信号前不挂载**（避免破坏首轮 wire），
晋升后挂载、压缩后再卸载；由 `packages/dshom/tool-gate.js` 与预设的 `tools.restrict()` 两层闸门共同保证。
goal 确认门与 `/import` 是命令/监听器，不占工具面。

## 安装与配置

profile 的 `dsh.profile.bundles` 里只列一行 `@mosire/dshom`（本机为 `link:` 到 `packages/dshom`）。
插件页会显示 **9 个可独立开关的组件**（3 个预设 + 6 个功能），关闭组件由插件管理页写回 profile patch：

```yaml
- id: preset-liangshen-empty-system
  disabled: true
```

装好后跑 `node tools/doctor.mjs` 检查 bundle 条目、组件包 link、peer symlink 农场与上次预设声明
（doctor 同时支持「单 bundle 多组件」与「每个功能一个 bundle」两种布局）。
每个功能包和预设包也带自己的 `dsh.bundle.patch`，可以脱离 dshom 单独安装（二选一，不要混用）；
完整组件清单与独立子包说明见 [packages/dshom/README.md](packages/dshom/README.md)。
预设的 `@deepseek-ai/*` peer 在每次 Host 激活时从运行中的 DSH 安装解析，因此不持久化安装路径。

## 验证

```bash
cd packages && for d in dsh-liangshen-anchored dsh-goal-confirm dsh-subagent-access \
  dsh-job-tools dsh-session-import dsh-prompt-lab-session dsh-session-inspect dshom; do
  (cd "$d" && node --test test/*.test.mjs 2>&1 | grep -E '^# (pass|fail)'); done
# 2026-11-16：129/53/32/19/28/12/14/15 全过（合计 302，0 fail）
```

运行诊断：`~/.dsh/<feature>-status.json`（pid 应与目标 Host 一致）；预设声明看
`~/.dsh/liangshen-anchored-status.json` 的 `presets[].broken`。

## 文档入口

- [AGENTS.md](AGENTS.md) —— 项目简介 + 五条铁律 + 文档索引（**常驻口径，冲突时以它为准**）
- 最新盘点：[docs/superpowers/status/2026-11-15-plugin-inventory.md](docs/superpowers/status/2026-11-15-plugin-inventory.md)
- 调研：[docs/agents/00-调研-梁神模式谱系.md](<docs/agents/00-调研-梁神模式谱系.md>) 等 `docs/agents/*.md`
- 设计/计划：[docs/superpowers/specs/](docs/superpowers/specs/)、[docs/superpowers/plans/](docs/superpowers/plans/)
- 状态与交接：[docs/superpowers/status/](docs/superpowers/status/)
