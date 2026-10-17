# 2026-10-17 初始调研存档（下次开工的唯一入口）

> **状态**：调研完成，设计与实现未开始。本文档取代：无（首份）。
> 加载：本文件不会自动注入；下次开工先读本文件 + 根 `AGENTS.md` + `docs/agents/00-调研-梁神模式谱系.md`。

## 一、本轮做了什么（2026-10-17）

1. 检索「梁神模式」上游资料：dsh-web（原 dsh-web-ui）、dsh-TUI、npm 生态、GitHub issue/discussion、知乎/博客/视频；
2. 定位本机一手材料 `~/.dsh/.agent-presets/liangshen/`（锚定式 v7，9 文件 1451 行，md5 见调研长文 §六）；
3. 查清「被删掉」根因：**DSH 0.1.7 起移除 legacy preset 目录发现**（官方技能原文 + TUI 源码注释双重证据），
   叠加 dsh-web v0.3.23 重构掉锚定（`anchorTools` 退役）；
4. 建立项目上下文：`AGENTS.md` / `docs/AGENTS.md` / `.superpowers/AGENTS.md` / 决策记录 / 本状态存档 / `.gitignore`；
5. 2026-10-17 追加：调研**功能二（goal 续轮确认门）**——摸清 `dsh-goal-round-driver` 自动续轮链路、`agent/pre-step` 瀑布拦截点、
   官方 `ctx.userQuestions` + Web 提问卡片复用可行性，产出 `docs/agents/02-调研-goal续轮确认门.md` 与对应决策记录；
6. **未写任何实现代码、未安装任何 bundle、未改 DSH 源码、未提交 git。**

## 二、已确认事实（详见调研长文）

> 2026-10-17 追加：原始出处 `xiaobright/dsh-anchored-standard`（MIT / 3754 stars）仍在线但 2026-09-10 冻结（V4 Pro 退役）；
> 本机 v7 ≈ TUI 0.15.0 包内副本（仅 2 文件各 3 行差异）；上游 `preset/` 多 `context-gate.mjs` / `dev-tool-search.mjs`（本地为更早简化派生）。

- 梁神模式是社区 preset，不是 DSH 官方内置（本机 0.2.0-rc.2 全量 grep 无命中）。
- 用户记忆中的版本 = 锚定式 v7：首轮 Minimal 精确双工具（持久 `bash` + `str_replace_editor`）、剥 `skill-catalog`/`agent-instructions`、
  首调晋升全目录、压缩后 epoch 重锚；本机源码与 TUI 0.15.0 包内副本逐字节相同。
- Web 侧现行 liangshen 0.4.6 已无锚定（极简 persona + `presentation: both` + tool-catalog + guard + fact_register + 分页）。
- 现代承载 = bundle patch + `@deepseek-ai/dsh-agent-preset` 声明（legacy 目录不再被读取，这也是「被删掉」的根因）。
- 功能二可行性：续轮由 `dsh-goal-round-driver` 在 `agent/pre-step` 先校验再放行；`prepend` 监听可先扣住；官方 `ctx.userQuestions`
  可发起匿名确认请求，Web 端已有卡片 UI（关闭=`ASK_CANCELLED`）；子代理不允许人工交互 ⇒ 自动放行。**不改 DSH 源码即可实现**。

## 三、当前仓库状态

- 目录骨架已建：`docs/{agents,superpowers/*}`、`.agents/{notes,skills}`、`.superpowers/{sdd}`、`tools/`；
- `git init` 已执行；**尚未 git commit**（等用户批准）；
- 文件清单以 `git status --short` 为准。

## 四、待用户裁定（阻塞设计）

- **D-001 已裁定（2026-10-17）= A 锚定式 v7 保真复刻**（用户选择）。
- **D-002 = A（Web profile 插件 bundle）**、**D-003 = B（复刻 + 上游小改进）**（2026-10-17 用户选择）。
- **D-006 随 D-003 确定**：基线 = 本地 v7；吸收上游小改进（`promoteOn: either`、`context-gate`、Windows 后台任务），不吸收 `dev_tool_search`/`prefab`。
- 待定：D-004 命名/order/包名/license（建议沿用「梁神模式」、order 5、MIT）；D-005 验证预算（建议协议级 smoke + 12 会话小矩阵）。
- **功能二待裁定**：G-001 UI 形态；G-002 挂载范围；G-003 关闭卡片语义；G-004 交付形态（详见 `docs/agents/02-调研-goal续轮确认门.md` §七）。
- **功能一设计已批准（2026-10-17）**、功能二四项裁定已定；两份 spec 已落盘待用户评审：
  - `docs/superpowers/specs/2026-10-17-liangshen-anchored-design.md`
  - `docs/superpowers/specs/2026-10-17-goal-confirm-gate-design.md`
- 下一步：**用户评审 spec** → 通过后 `writing-plans` 出实现计划 → 按里程碑实现（M0 承载 spike 先行）。

## 五、下一步（裁定落盘后）

1. brainstorming：分类（本项目=architectural）→ 澄清设计问题 → 出设计（架构/组件/数据流/错误处理/验证）→ **用户批准**；
2. 写 spec 到 `docs/superpowers/specs/2026-10-17-…-design.md` → 用户评审 → `writing-plans` 出实现计划；
3. 实现（TDD，按 P0 顺序）：bundle 骨架 → 移植 4 个自定义插件（tool-bootstrap / instruction-hint / skill-search / Windows bash）→
   `agent.cordis.yml` 组合 → preset 声明 + 注册 → 官方 DSH 0.2.0-rc.2 实机验证（新会话 header / 晋升 / 压缩 / 子代理 / 恢复）；
4. 优化项按 P1/P2 分期外挂（双分支、winbash 后台任务、guard、fact_register、working-context、maxResidentTokens）；
5. 验证基建（隔离 runner + 矩阵）与兼容回归（事件 kind / preset id / 恢复）。

## 六、未做 / 未验证（如实清单）

- 未在真实会话里跑过任何「复刻」；本文所有上游数字（5/5、~81%、72.6%、98.5 等）均为**转抄，未回核**。
- 未验证 DSH 0.2.0-rc.2 下「bundle 内 preset 声明 + `@deepseek-ai/cordis-plugin-include` 指向包内 `agent.cordis.yml` + 相对 `.mjs` 解析」的完整链路
  （TUI 源码显示同款做法，但本机未实装验证）。
- 未核 TUI 包与早期锚定版 preset 的许可证（dsh-web Apache-2.0、DSH MIT 已知；`presets/liangshen` 基于官方 Minimal/Standard/PTC 的 MIT 修改，需在 spec 里写清合规路径）。
- 未测算双分支 / guard 等优化项的实际收益；issue #266 的 22/22 是作者自测，非隔离对照。
