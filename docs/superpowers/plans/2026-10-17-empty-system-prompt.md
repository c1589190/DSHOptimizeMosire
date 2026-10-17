# 空系统提示词预设（梁神变体）实现计划 · 功能四

> 对应 spec：`docs/superpowers/specs/2026-10-17-empty-system-prompt-design.md`（已定，2026-10-17）。
> 原则：不动主预设行为；组合唯一差异为 persona 字面量；生成器 + 单测防漂移。

## Global Constraints

- 预设：id `liangshen-empty-system`、name `梁神模式·空系统提示词`、order 6；主预设保持 order 5 不变。
- 组合产物 `presets/liangshen/agent.empty-system.cordis.yml` 由 `tools/sync-preset-variant.mjs --write` 生成并提交。
- 不引入运行时写文件/构建步骤；不修改 7 个 `.mjs` 插件。
- 真实 wire（B1）需用户在新会话选择该预设后验证；未跑前只声称「组合/注册/单测」层。

## Task 1: 生成器 + 组合产物 + 元数据

**Files:** `tools/sync-preset-variant.mjs`（新）；`packages/dsh-liangshen-anchored/presets/liangshen/agent.empty-system.cordis.yml`（生成）；
`presets/liangshen/preset.empty-system.yml`。

- [ ] Step 1: 写生成器：`renderEmptySystemComposition(baseText)` 做两处确定性替换 + 生成头注释；CLI `--write` /
      默认校验并输出 diff 状态；导出函数供测试导入。
- [ ] Step 2: 运行 `node tools/sync-preset-variant.mjs --write` 生成产物。
- [ ] Step 3: 写 `preset.empty-system.yml`（name/description/order）。
- [ ] Step 4: 手查产物：persona 行 `const persona = ' '`、其余与主组合一致。

## Task 2: host 插件多预设注册

**Files:** `packages/dsh-liangshen-anchored/lib/index.js`、`test/composition.test.mjs`（或新增 `test/presets.test.mjs`）。

- [ ] Step 1: 写失败测试：两个预设源文件存在；元数据 order 5/6；组合一致性
      `emptyFile === renderEmptySystemComposition(baseFile)`；两份各 21 row。
- [ ] Step 2: 重构 `lib/index.js`：`PRESETS` 规格表 + 逐预设注册（互相隔离 try/catch），
      状态文件 schema v2（`presets:[{id,composition,broken,error?}]`），保留 `declared` 兼容字段。
- [ ] Step 3: 测试 PASS；`node --check lib/index.js`。

## Task 3: verify-session 支持空 system 模式

**Files:** `tools/verify-session.mjs`、`test/verify-session.test.mjs`。

- [ ] Step 1: 写失败测试：合成事件（system `" "`、首请求双工具）在 `--preset liangshen-empty-system` 下
      `failures: []`；主预设数据在该模式应失败（反之亦然）；`systemPrompt` 选项显式覆盖。
- [ ] Step 2: 实现 `analyzeSession(events,{preset,systemPrompt})` + CLI 依据 preset 自动选择；
      `space` 模式检查「system === ' '」与「无 harness identity」。
- [ ] Step 3: 测试 PASS。

## Task 4: 安装 + 真实 wire 验证

- [ ] Step 1: `plugin_manager install_bundle …/packages/dsh-liangshen-anchored` 重装 → 状态文件两预设 `broken:null`。
- [ ] Step 2: 请用户新建 Web 会话选「梁神模式·空系统提示词」跑一次 bash 任务；取会话日志跑
      `node tools/verify-session.mjs <path> --preset liangshen-empty-system`。
- [ ] Step 3: 同日跑主预设真实会话回归（B4）；证据归档 `.superpowers/sdd/2026-10-17-empty-system/`。
- [ ] Step 4: 若 wire 中空格被 trim（D1），记录实测文本与偏差，回报用户，不擅自改判据。

## Task 5: 收尾

- [ ] Step 1: 全量测试 + `node --check`。
- [ ] Step 2: 更新状态文档/AGENTS 门禁；`git status` 自查。
- [ ] Step 3: commit + push（用户已授权本阶段）。
