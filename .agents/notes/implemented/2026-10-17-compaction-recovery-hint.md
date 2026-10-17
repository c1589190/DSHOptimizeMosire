# 决策记录：压缩后恢复 hint（功能五）

- **日期**：2026-10-17（用户「开始吧」当日）
- **状态**：implemented（设计已裁定，实现见 `docs/superpowers/specs/2026-10-17-compaction-recovery-hint-design.md`）
- **取代/关系**：选定 `docs/agents/04-调研-通用基础设施补位.md` §五 方案对比中的「压缩后额外 hint（纯提示）」路线；**不采用**方案 A（回挂官方 `agent-instructions`/`tool-skill`）与「注入 AGENTS.md 内容」路线（暂缓，作为升级后备）。

## 背景

梁神模式 `instruction-hint` 每会话只注入一次，`compaction/end` 后不重注；压缩把 hint 与 AGENTS.md 内容挤出可见上下文后，模型从 checkpoint 直接开工。真实故障 `session-74bc67ff`（hint@39 → read AGENTS@44 → compaction@839 → 重锚/再晋升无 hint → turn2 未读 AGENTS → 用户两次质疑后才 grep 找回规则）。

## 裁定（用户 2026-10-17）

- **D-011**：采用「压缩后额外注入一条 recovery hint」（纯提示，不注入文件内容、不回挂官方注入源）。
- **D-012**：主预设与空系统预设都启用（同一插件，生成器同步；空预设 system prompt 仍为单空格）。
- **D-013**：时机 = 压缩后的第一条请求（工具面仍 2 工具；`context-gate.allowKinds` 放行 `recovery-hint`），不推迟到重锚晋升后。
- **D-014**：铁律 3 修正为：AGENTS.md 类指令不整段注入——promote 后至多一条非命令式 hint；**每个压缩纪元（`compaction/end` 后）可再注入一条恢复 hint**。
- **D-015**：若真实会话实测该 hint 仍被忽略，再评估「升级为带内容版/方案 A」；本轮不做。
- **D-016**（旁记）：`complete:true` 造成的永久缺口（runtime-context 快照、plan policy、tool guidance）另立条目，不捆绑本轮。

## 关键取舍

- 成本：仅压缩过的会话每次压缩付 ~400–700 chars；普通会话零变化。
- 风险：纯提示仍有被忽略可能（既有证据 12–13/15 会读、2/15 忽略）；压缩后首请求不再是严格「零注入」，仅这一条 `recovery-hint` 例外，工具面不变。
- 回滚：`instruction-hint.config.recoveryHint: false`。

## 证据位置

- 调研：`docs/agents/04-调研-通用基础设施补位.md`（§3.1 故障链、§4.0 上游历史）。
- 实机证据（待补）：`.superpowers/sdd/2026-10-17-compaction-recovery-hint/evidence/`。

## 实机结果（2026-10-17 深夜）

- DSH 重启后用户会话 `session-aa65c681…`（effective liangshen）：`compaction/end`@104 → `recovery-hint`@111（boundary=104，483 chars）
  → 压缩后首请求@112 tools=2 → 模型 `cat AGENTS.md`@116 → 再晋升@122 tools=48；`verify-session` exit=0（含新检查）。
- 提交：`831d059`（docs）、`6ae5cb6`（feat），远程 main；空预设未单独跑 recovery（同源+单测覆盖）。
