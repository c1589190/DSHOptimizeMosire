# 决策记录：统一为 @mosire/dshom 单一 bundle（2026-10-19）

- **日期**：2026-10-19（用户「把这几个功能全部整合到一个命名空间的插件旗下」）
- **状态**：implemented；profile 安装 `@mosire/dshom`，Host 已激活，预设 `broken:null`；等待用户新会话验收。
- **背景**：DSH 升级到 0.2.1-rc.2 后安装迁到 pnpm global 目录，旧 peer symlink 农场失效导致梁神预设全部 "never started"；
  修复 relink 后（`9daa47e`），用户要求把 `liangshen` / `goal-confirm` / `subagent-access` / `timing-annotations`
  收进一个命名空间、一个 bundle，避免 profile 里四个插件分别安装/启用。

## 裁定

- **D-020**：统一入口 bundle `@mosire/dshom`
  - Host 入口 `packages/dshom/index.js` 依次调用既有实现模块的 `apply`：
    `dsh-liangshen-anchored`（两个预设 + 压缩恢复 hint）、`dsh-goal-confirm`、`dsh-subagent-access`；
  - Client half 是聊天时间标注（运行中实时 + 完成后标注），从 `dsh-timing-annotations` 复制并改为本包客户端模块；
  - 特性开关：`config.features.{presets,goalConfirm,subagentAccess}`，默认全开；子功能配置放在
    `config.goalConfirm` / `config.subagentAccess`；
  - 旧 `@mosire/dsh-*` 包保留为实现与测试模块（workspace 内相对引用），profile 只启用 `@mosire/dshom`；
  - 该包通过相对路径引用同仓库模块（workspace link 安装适用）；发布/打包前需把实现内联进本包（README 已注明）。

## DSH 0.2.1 兼容修复（随本次一同落地）

- `tools/link-dsh-peers.mjs`：自动从运行中的 Host `/proc` 定位 dsh，按 pnpm 布局从 realpath 的虚拟 store 取 peers，
  保留 npm 嵌套布局 fallback；`packages/dsh-liangshen-anchored` 26 个 peer 中 24 个重新链接。
- `dsh-tool-ralph` 在 0.2.1 不再是 dsh 依赖（迁到实验 bundle）：预设 row 改为「包可解析才启用」。
- `dsh-subagent-access` 去掉 `@deepseek-ai/dsh-tools` 依赖（0.2.1 的 dsh 依赖树不再提供），改为本地 `toJsonSchema` +
  最小 `defineTool` 等价实现。

## 验证

- 单测：liangshen 76/76、goal-confirm 30/30、subagent-access 28/28。
- 安装：`plugin_manager install_bundle packages/dshom` → `application: applied`；
  `~/.dsh/liangshen-anchored-status.json` 两预设 `declared:true, broken:null`；
  `goal-confirm-status.json` activated、`subagent-access-status.json` activated（tools 列表正确）；
  client `conversation.chat.assistant-actions` / `turnTail` / `composer.dock` 的 timing 注册 active。
- 待用户：新开梁神/空预设会话验证预设可用与四功能同时生效；旧会话不追溯。

## 回滚

- 重新启用旧 bundle 需先禁用 `@mosire/dshom`（否则两个 Host 入口会重复声明同名预设 / 重复注册工具）。
- 特性级回滚：在 `dshom` 配置里把对应 `features.*` 置 `false`，无需卸载 bundle。
