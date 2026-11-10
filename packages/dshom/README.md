# @mosire/dshom

DSH Optimize Mosire 的**唯一入口 bundle**：把梁神预设、goal 确认、子 Agent 控制、后台任务工具、Session 导入和 prompt-lab 编排收进一个插件行。

> **2026-11-10：本 bundle 只保留 Host half，客户端 half（聊天时间标注 + composer dock 的 goal 开关）已移除。**
> DSH 0.2.2 的 composerSeat 带 `will-change:transform`，是 `position:fixed` 后代的包含块；
> 旧 client half 把 fixed 标签/菜单渲染在 `conversation.composer.dock` 里，坐标被容器劫持，
> 会出现时间标签飘到输入框/屏外、goal 菜单错位等显示问题。详见
> `.agents/notes/implemented/2026-11-10-remove-chat-timing-client.md`。
> `/goal-confirm` 命令与提问卡片第三项仍由 Host half 提供，只是不再有 composer dock 小开关。

| 功能 | 实现 | 默认 |
|---|---|---|
| 梁神模式（锚定预设，含空系统提示词变体、压缩后恢复 hint） | `../dsh-liangshen-anchored/lib/index.js` | 开 |
| goal 续轮确认门 | `../dsh-goal-confirm/lib/index.js` | 开 |
| 父→子 Agent 控制工具（`subagent_list/message/interrupt/wait`） | `../dsh-subagent-access/lib/index.js` | 开 |
| 后台任务 `job_wait` / `job_read`（等待与优化输出分离） | `../dsh-job-tools/lib/index.js` | 开 |
| Session 日志导入（`/import <路径>`） | `../dsh-session-import/lib/index.js` | 开 |
| Prompt-lab 会话编排（`prompt_lab_workspaces` / `prompt_lab_session`） | `../dsh-prompt-lab-session/lib/index.js` | 开 |
| 会话查看（`session_list` / `session_read` / `session_find`） | `../dsh-session-inspect/lib/index.js` | 开 |

Host 入口按需调用各功能的既有 `apply`，不复制业务代码；预设组合仍位于
`packages/dsh-liangshen-anchored/presets/liangshen/`（由该包自己的 peer symlink 农场解析 `@deepseek-ai/*`）。

**版本无关**：peer 农场在每次 Host 激活时从运行中的 DSH 安装重建（`process.argv[1]` realpath，回退 `/proc`），
不持久化 pnpm 版本目录；DSH 升级后不需要手动重链。装好后跑 `node tools/doctor.mjs` 可检查
`dsh.profile.bundles` 条目、farm 链接与上次 preset 状态；`--fix` 会重新加回 bundle 条目并刷新 farm。

## 配置

```yaml
- id: dshom
  name: '@mosire/dshom'
  config:
    features:
      presets: true        # 两个梁神预设
      goalConfirm: true    # goal 续轮确认门
      subagentAccess: true # 父→子控制工具
      jobTools: true       # job_wait / job_read
      sessionImport: true  # /import <zip|jsonl|zstd>
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

只关闭某个功能时把对应 `features` 置 `false` 即可。`subagentAccess` 会在 `agents` /
`subagents` 服务就绪后安装；`jobTools` 会在 `agents` / `jobs` 服务就绪后安装并跟随 Agent 生命周期；
缺少服务时对应功能自动跳过（fail-open）。

`goalConfirm.timeoutSeconds: 0` = 会话等待人工确认（不自动继续）。会话级开关不写配置，而是用
`/goal-confirm on|off|wait|timeout <秒>|reset` 或提问卡片第三项；状态由会话日志里的
`command/run` 经 projection `goal-confirm` 重建（详见 `../dsh-goal-confirm/README.md`）。

> 本包通过相对路径引用同仓库的功能包，因此适用于 workspace 的 link 安装；发布/打包时需把实现收进本包。
