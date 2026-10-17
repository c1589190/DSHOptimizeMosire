# 2026-10-17 · 空系统提示词预设（功能四）的范围裁定

> 状态：**implemented（Lead 依用户 2026-10-17 授权直接实现）**。
> 用户原话（2026-10-17，逐字）：「顺别再加一个模式，空系统提示词模式，就是梁神模式但是把系统提示词替换成一个空格」。
> 设计见 `docs/superpowers/specs/2026-10-17-empty-system-prompt-design.md`。

## 事实（回代码核过）

1. 主预设由 host 插件在激活时向 `ctx.agentPresets.register()` 声明；组合经
   `@deepseek-ai/cordis-plugin-include` 以包内绝对 `file://` URL 载入
   （`packages/dsh-liangshen-anchored/lib/index.js`）；
2. persona 行使用版本自适应 `!!js` 块（`prefix`/`text` 键），`complete: true` + `includeRuntimeContext: false`；
   `@deepseek-ai/dsh-persona` 的 `prefix` 为 `z.string().required()`，单个空格合法；
   `dsh-system-prompt` assembly 对 complete section 恢复为唯一段，渲染按 `text.length > 0` 保留（单空格会保留）；
3. 主组合 `agent.cordis.yml` 458 行 / 21 row，`.mjs` 相对引用依赖组合文件所在目录。

## 裁定

| ID | 问题 | 裁定 | 理由 |
|---|---|---|---|
| D-007 | 交付形态 | **新增独立第二预设** `liangshen-empty-system`（name「梁神模式·空系统提示词」、order 6），主预设零改动 | 用户要「再加一个模式」；便于对照与随时切回 |
| D-008 | 组合维护方式 | **生成器 + 提交产物**：`tools/sync-preset-variant.mjs` 从主组合生成 `agent.empty-system.cordis.yml`，单测断言产物==生成结果；不引入运行时生成/构建步骤 | 避免手抄 458 行漂移；`.mjs` 相对引用继续有效；机器可拦 |
| D-009 | 「空」的语义 | persona 前缀 = **单个 ASCII 空格（U+0020）**，`complete: true` 不变；真实 wire 若被适配层 trim，以实测为准并记录偏差（不擅自改判据） | 用户原话「替换成一个空格」；证据先行 |

## 影响面 / 后续

- 验收 A1/B1–B4/C1–C2/D1（spec §2）；真实 wire（B1/B2/B3）必须用户新建会话选择该预设后验证。
- 状态文件 schema v2（多预设数组），保留 `declared` 兼容字段。
- `tools/verify-session.mjs` 增加 `--preset liangshen-empty-system` 的 space 模式断言。
