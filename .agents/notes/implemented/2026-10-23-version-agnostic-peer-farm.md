# 2026-10-23 — 预设 peer 改为运行时解析（D-022）

## 问题

`@mosire/dsh-liangshen-anchored` 的 composition 里，官方插件行写的是裸包名
（`name: '@deepseek-ai/dsh-persona'`）。`@deepseek-ai/cordis-plugin-include`
把 composition 所在目录设为子 Loader 的 `baseUrl`，因此这些裸名必须从
`packages/dsh-liangshen-anchored/node_modules/@deepseek-ai/` 解析。

此前的 farm 是指向 DSH 安装目录的**绝对符号链接**。pnpm global 布局按内容寻址
（`.../global/v11/<hash>/...`），DSH 每次升级会创建新目录并删除旧目录：

- 2026-10-19 升级后，farm 仍指向已删除的 `v11/5a9-…`；
- 2026-10-23 再次升级后，farm 指向的 `v11/5a9-…` 依旧不存在（当前为 `4bb-…` 经
  `499c-…` 符号链接进入）；
- 结果：26 个 row 全部 `never started`，两预设 `broken`，而 Host half 本身
  可能仍被加载——用户感知为“DSH 一更新插件立刻作废”。

此外，2026-10-23 重启前观察到 `@mosire/dshom` 不在
`dsh.profile.bundles`（profile 依赖仍在）。未复现出确定的删除路径；DSH
plugin-manager 的 `reconcile` 只在 bundle 元数据暂时不可解析时移除条目，
profile 包操作与 Boot 都可能成为触发窗口。

## 决定（D-022）

1. **不再持久化任何指向 DSH 安装目录的绝对链接。** 新模块
   `packages/dsh-liangshen-anchored/lib/host-peers.js` 在每次 Host 激活、
   声明预设之前：
   - 从 `process.argv[1]` 的 realpath 定位运行中的 DSH（`@deepseek-ai/dsh/lib/bin.js`）；
   - 失败时回退到 `DSH_INSTALL_ANCHOR` 或 Linux `/proc` 中的运行中 Host；
   - 用与 DSH 自身相同的 `packageDirFromAnchor` 方式（探测
     `<name>/package.json` 的 require 搜索路径）解析每个 peer；
   - 重建 `packages/dsh-liangshen-anchored/node_modules/@deepseek-ai/` farm；
   - 解析不到的可选包（`dsh-workflow-worker-thread`）不建链，对应 row 的
     `!!js` 条件按包自身是否可解析决定禁用；
   - 找不到任何 Host anchor 时**不裁剪**已有 farm，避免把唯一可用的状态删掉。
2. **可选行以自身包为准。** `workflow-worker-thread` 原先检查
   `dsh-workflow-ptc`，在 0.2.1 会误启用；现在检查自身。
3. **`dsh-tool-ralph` 可解析即启用。** 0.2.1 把它放在 pnpm 的
   `.pnpm/node_modules`（hoisted）里，旧 farm 的 sibling 扫描找不到；运行时
   resolver 能解析到。
4. **诊断可修复。** `tools/doctor.mjs` 检查 profile bundle 条目、farm 链接、
   上次 preset 状态；`--fix` 重新启用 `@mosire/dshom` 并刷新 farm。
5. **`@mosire/dshom` 导出 `./package.json`。** 避免任何依赖
   `require.resolve('<pkg>/package.json')` 的工具因 exports 限制而解析失败。

## 证据

- 修复前：farm 25 个链接全部指向 `v11/5a9-…`（不存在）；旧状态文件
  `broken` 列出 24 个 `never started`。
- 修复后：临时 `dsh web --port 3099 --no-open`（pid 3837）加载当前 profile，
  `liangshen-anchored-status.json`：
  - `peers.synced: true`，anchor 为 `v11/4bb-…/.pnpm/@deepseek-ai+dsh@…/…/dsh/lib/bin.js`；
  - `linked: 25`，`missing: ['@deepseek-ai/dsh-workflow-worker-thread']`；
  - `liangshen` / `liangshen-empty-system` 均 `broken: null`。
- 单测：liangshen 83/83（新增 host-peers 7 项）。
- profile 更新试验：`dsh plugin --profile web update dsh-plugin` 后
  `dsh.profile.bundles` 仍包含 `@mosire/dshom`。

## 代价与限制

- 首次激活需要写 `<package>/node_modules/@deepseek-ai/`；只读安装会得到
  `synced: false`，状态文件记录原因，预设可能仍按旧 farm 工作或失败。
- `requiredPeerNames` 按 composition 与 Host `import` 静态扫描；新增 peer 行
  需同时出现在 composition 中（自动覆盖）。
- `doctor --fix` 修复 bundle 条目后仍需重启 DSH 才会挂载 Host half；
  farm 修复对下一次预设声明立即生效。
