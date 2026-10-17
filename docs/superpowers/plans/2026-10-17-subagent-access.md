# 子 Agent 访问（父 → 子控制面）实现计划 · 功能三 M1

> 对应 spec：`docs/superpowers/specs/2026-10-17-subagent-access-design.md`（已定，2026-10-17）。
> 原则：不碰 DSH 源码；只调官方 service；TDD；安装后真实 E2E。

## Global Constraints

- 不修改 DSH 安装目录；不复制 DSH 源码；不写 profile 的 `package.json` / `cordis.patch.yml`（用 `plugin_manager`）。
- 新包：`packages/dsh-subagent-access/`（`@mosire/dsh-subagent-access`，private，MIT，图标/locale 与既有包同构）。
- 工具名固定：`subagent_list` / `subagent_message` / `subagent_interrupt`（不与 Team 重名）。
- 默认只给 root 会话（`delegationDepth === 0`）安装；`includeDelegatedAgents` 可开。
- 证据分层：单测 ≠ 安装成功 ≠ E2E；只有跑过的那层才能声称。

## Task 1: 包骨架 + 依赖解析

**Files:** `packages/dsh-subagent-access/{package.json,cordis.patch.yml,README.md,NOTICE,LICENSE,icon.svg,locale/{zh,en}.json}`；
`tools/link-dsh-peers.mjs`（泛化）。

- [x] Step 1: 写 `package.json`（`dsh.bundle.patch`、`type:module`、peer `@deepseek-ai/dsh`）。
- [x] Step 2: `cordis.patch.yml` 插入行 `id: subagent-access`、`name: '@mosire/dsh-subagent-access'`。
- [x] Step 3: 泛化 `tools/link-dsh-peers.mjs`：扫描所有 `packages/*/lib/*.js` 的 `@deepseek-ai/*` import +
      组合文件里的官方包名，为每个包建 symlink farm；保留 `--dsh-root`。
- [x] Step 4: 跑 `node tools/link-dsh-peers.mjs`，确认新包 `node_modules/@deepseek-ai/dsh-tools` 可解析。

## Task 2: 纯逻辑模块 + 单测

**Files:** `lib/catalog.js`、`test/catalog.test.mjs`。

- [x] Step 1: 写失败测试：`normalizeConfig` 默认 `{enabled:true,includeDelegatedAgents:false}`、非布尔抛 TypeError；
      `catalogRows(entries, statusOf)` 映射 `{id,label?,mode,status,createdAt}`（三 mode、label 可选、running/inactive）；
      `shouldInstall(agent, config)` 按 `delegationDepth` 筛选。
- [x] Step 2: 实现 `lib/catalog.js`（无 DSH import，纯 ESM）。
- [x] Step 3: `node --test test/*.test.mjs` PASS。

## Task 3: 插件装配 + 三工具 + 单测

**Files:** `lib/index.js`、`test/plugin.test.mjs`。

- [x] Step 1: 写失败测试（fake ctx：`agents` 假 registry、`subagents` 假服务、`agent.ctx.tools.register` 捕获）：
      - apply 对现有 root agent 安装 3 工具；`includeDelegatedAgents:false` 时跳过 depth>0；
      - `enabled:false` 不注册监听/工具；
      - execute 参数与返回值：list（空/非空）、message（capture sender/target/content/signal）、interrupt（采样前状态）；
      - 错误透传（fake 服务抛 `NOT_RESUMABLE`/`UNAUTHORIZED`）；
      - agent/disposed 与插件卸载释放 disposer；`subagents` 缺失 fail-open。
- [x] Step 2: 实现 `lib/index.js`：`inject=['agents','subagents']`；`defineTool` from `@deepseek-ai/dsh-tools`；
      安装/卸载/状态文件（`$DSH_HOME/subagent-access-status.json`）。
- [x] Step 3: 测试 PASS；`node --check lib/index.js`。

## Task 4: 安装 + 真实 E2E + 证据

- [x] Step 1: `plugin_manager install_bundle /home/cna/DSHOptimizeMosire/packages/dsh-subagent-access`，
      检查返回 `application/applied`；状态文件。
- [x] Step 2: `cordis_inspect_query` `Tool.listTools`（当前会话）确认三工具可见。
- [x] Step 3: 真实 E2E（本次会话）：
      1) `subagent` 派发一个 continuable 子会话跑 `sleep` 长任务（不写文件）；
      2) `subagent_list` → 显示 running；
      3) `subagent_interrupt` → `previousStatus:"running"`；
      4) `subagent_message` → 子会话新回合回报 → 父会话 `agent-message`；
      5) 记录父/子会话 id + seq 到 `.superpowers/sdd/2026-10-17-subagent-access/evidence/`。
- [x] Step 4: 对照 Team：`list_agents` / `send_message` 行为不变（只读验证）。

## Task 5: 收尾

- [x] Step 1: 全量测试（三个包）+ `node --check`。
- [x] Step 2: 更新状态文档/AGENTS 门禁；`git status` 自查。
- [x] Step 3: commit + push（用户已授权本阶段）。
