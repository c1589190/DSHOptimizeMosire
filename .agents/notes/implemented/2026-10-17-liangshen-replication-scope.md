# 2026-10-17 · 梁神模式复刻的范围与基准（proposed）

> 状态：**implemented（用户已裁定，2026-10-17）**。设计见 `docs/superpowers/specs/2026-10-17-liangshen-anchored-design.md`（待评审）。
> 关联：根 `AGENTS.md` §七、`docs/agents/00-调研-梁神模式谱系.md` §七、`docs/superpowers/status/2026-10-17-initial-survey.md`。

## 1. 背景与用户原话（2026-10-17，逐字）

> 「起因是，我目前使用了比较长时间的dsh，但是效果参差不齐，偶然想到之前有一个被删掉的梁神模式貌似挺好用，你先搜索一下相关资料——这个项目就是要复刻一下这个模式，同时做一些功能上的优化，先调查、创建AGENTS.md，本项目通用上下文的规则可以参考隔壁~/SimualtorMosire的结构」

## 2. 已确认事实（详见调研长文）

1. 梁神模式是社区 agent preset，不是 DSH 官方内置；
2. 「被删掉」的直接原因：DSH 0.1.7 起移除 legacy `$DSH_HOME/.agent-presets/<id>/` 目录发现；本机残留副本已不被读取；
3. 用户记忆中好用的版本 = **锚定式 v7**（首轮 Minimal 精确双工具 + 零自动注入 → 首调全目录 → 压缩重锚）；
   本机 `~/.dsh/.agent-presets/liangshen/` 与 TUI 0.15.0 包内副本逐字节相同（1451 行）；
4. Web 现行 liangshen 0.4.6 已无锚定（极简 persona + PTC/both + guard + fact_register + 分页）；
5. 现代承载 = bundle patch + `@deepseek-ai/dsh-agent-preset` 声明（官方技能的 legacy 迁移路径）。

## 3. 选项与取舍

| ID | 问题 | 选项 | 取舍 |
|---|---|---|---|
| D-001 | 复刻基准 | A 锚定 v7 / B Web 0.4.6 / C 双分支融合 | **✅ 已裁定 A（用户选择，2026-10-17）**：保真复刻用户记忆中「好用」的行为；B 的核心哲学不同（无锚定），C 是 A 的外挂优化 |
| D-002 | 交付形态 | A Web profile bundle（含可选设置卡）/ B 纯 preset bundle / C TUI+Web 共用 | **✅ 已裁定 A（用户选择，2026-10-17）**：Web profile 插件 bundle；B 是其子集；C 等 A 稳定后再说 |
| D-003 | 优化范围 | §五 清单分期 | **✅ 已裁定 B（用户选择，2026-10-17）**：复刻 + 上游小改进（`promoteOn: either`、`context-gate`、Windows 后台任务）；双分支/guard/fact_register 等留待复刻验收后 |
| D-004 | 命名与 order | 沿用「梁神模式」/ 新名；order 4/5/其他 | 建议沿用名字 + order 5（与 legacy 一致），认知不断裂；对外可标「复刻版」 |
| D-005 | 验证预算 | 模型 route / 任务集 / 重复次数 / 费用上限 | 建议先协议级 smoke（1 条真实会话 header 全检），再 ≥3 任务 × 2 臂 × 2 重复的隔离矩阵；费用另报用户批准 |
| D-006 | 移植基线与上游吸收 | A 严格 v7 / B v7 保真仅参考上游 / C v7 为基础分期吸收上游机制 | 建议 **C 的 P0=B**：先严格 v7 可运行，再按对照数据升级（`promoteOn: either`、`context-gate`、`dev_tool_search`） |

## 4. 裁定（2026-10-17）

- **D-001 = A（锚定式 v7 保真复刻）**；**D-002 = A（Web profile 插件 bundle）**；**D-003 = B（复刻 + 上游小改进）**；
- **D-004 = 建议值**（沿用「梁神模式」/ order 5 / MIT）；**D-005 = 建议值**（协议级 smoke + 12 会话小矩阵）；**D-006 = 基线本地 v7 + 吸收 `promoteOn: either` / `context-gate` / Windows 后台任务**；
- 设计已于 2026-10-17 获用户批准，spec 已落盘待评审。

> 补充事实（2026-10-17 追加调研）：原始出处 `xiaobright/dsh-anchored-standard`（MIT，3754 stars）**仍在线但已于 2026-09-10 冻结**
> （V4 Pro 计划 2026-09-14 退役）；本机 v7 ≈ TUI 0.15.0 包内副本（仅 2 文件各 3 行差异），
> 相对上游 `preset/` 是「简化 + 旧默认」派生（缺 `context-gate.mjs` / `dev-tool-search.mjs`，`promoteOn` 仍是 `tool-call`）。
> 详见调研长文 §十。

## 5. 影响面 / 后续任务

- 裁定后：brainstorming 设计 → `docs/superpowers/specs/` 设计书 → 用户评审 → `writing-plans` → 实现；
- 若 D-001 选 C：issue #266 的双分支需要「按首轮实际 route 判定」的实现，先做单分支保真版再外挂；
- 若 D-002 选 A：需要额外设计设置卡/`!!js` 版本兼容与 bundle 安装路径（plugin_manager）。
