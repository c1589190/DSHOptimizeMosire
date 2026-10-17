# 2026-10-17 实现计划：压缩后恢复 hint（功能五）

> 设计：`docs/superpowers/specs/2026-10-17-compaction-recovery-hint-design.md`（D-011~D-014 已裁定）。
> 纪律：TDD（先补测试再实现插件）；证据先行；不碰 DSH 源码；提交需用户已授权（2026-10-17 本阶段已授权 commit+push）。

## T1 文档（本 commit）

- [x] spec（设计书）+ plan（本文件）+ 决策记录 `.agents/notes/implemented/2026-10-17-compaction-recovery-hint.md`
- [x] 根 `AGENTS.md`：功能五条目；铁律 3 修正；D-011~D-014；当前门禁进度
- [x] `docs/agents/04-调研-通用基础设施补位.md`：裁定结果回填
- [x] commit + push（docs only）— `831d059`

## T2 插件与单测（TDD）——完成

- [x] `test/instruction-hint.test.mjs` 先写 7 组用例（见 spec §六）
- [x] `presets/liangshen/instruction-hint.mjs`：
  - [x] `recoveryHint` 配置（boolean，默认 true，非法值 apply 时报错）
  - [x] epoch 感知：`promotion.status(agent).boundary >= 0` 时走 recovery 分支（未晋升也注入）
  - [x] durable 去重（`boundary` 匹配的 `source.kind='recovery-hint'`）+ 进程内 `Set<boundary>`
  - [x] recovery 文本（有文件/无文件/user-global/status-handoff/skill 指引）
  - [x] fs 缺失/探测异常 ⇒ 通用文本；注入异常 ⇒ fail-open
- [x] `node --test packages/dsh-liangshen-anchored/test/*.test.mjs` 全绿

## T3 组合 / 生成器 / verifier ——完成

- [x] `agent.cordis.yml`：`context-gate.allowKinds: [skill-invocation, recovery-hint]`；instruction-hint 行 `recoveryHint: true` + 注释
- [x] `node tools/sync-preset-variant.mjs --write`；`--check` 通过
- [x] `composition.test.mjs` 增加断言（allowKinds / recoveryHint / rows 仍 21）
- [x] `tools/verify-session.mjs`：每个 `compaction/end` 后检查 recovery-hint（boundary 匹配）+ 报告字段
- [x] 全量测试（liangshen 59+新增、goal-confirm 30、subagent-access 28）

## T4 实机（需用户配合，阻塞于重启）

- [ ] 提交+推送代码
- [ ] 用户重启 DSH → 新会话（主预设）跑一次真实任务 → `/compact` → 继续工作
- [ ] 同一流程跑空预设会话
- [ ] 用 `tools/verify-session.mjs` 分析两份日志：首轮 2 工具/零注入、压缩后 recovery-hint、工具面、模型是否 read AGENTS.md
- [ ] 证据落 `.superpowers/sdd/2026-10-17-compaction-recovery-hint/evidence/`

## T5 收尾

- [ ] `docs/superpowers/status/2026-10-17-initial-survey.md` 追加功能五进度
- [ ] README 提及压缩恢复 hint
- [ ] 最终 commit + push
