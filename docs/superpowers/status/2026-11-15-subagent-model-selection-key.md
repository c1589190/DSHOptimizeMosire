# 2026-11-15 子 Agent 模型选择：DSH 0.2.2 键名修复

## 结论

- **根因**：梁神/空提示词预设的 `tool-subagent` 行仍写 DSH 0.2.1 时代的
  `modelSelectionSettings: true`。DSH 0.2.2 已把该选项改名为 `modelSelection`，官方升级指南明确要求迁移
  （`docs/upgrade-guide/v0.2.1-rc.1/subagent-control-tools/guide.zh.md:12,20`）；当前插件的 `Config` 只读
  `modelSelection`（默认 `false`，`modelDiscovery` 默认 `false`）。旧键被 Schemastery 当作未知键保留，不报错，
  所以预设仍 `broken:null`，但工具实例实际没有开模型选择。
- **后果**：梁神/空提示词新会话晋升后，`subagent` 不暴露 `provider` / `model` / `reasoning_effort`，
  `list_subagent_models` 也不注册；只有 `agentOptions.reasoningEffort: high` 生效。
- **修复**：两预设的 `tool-subagent` 行改为 `modelSelection: true` + `modelDiscovery: true`，
  保留 `agentOptions.reasoningEffort: high`。空提示词变体由生成器重生成。

## 改动

- `packages/dsh-liangshen-anchored/presets/liangshen/agent.cordis.yml:422` — `modelSelection: true`，
  `:423` — `modelDiscovery: true`；注释说明 0.2.2 键名。
- `packages/dsh-liangshen-anchored/presets/liangshen/agent.empty-system.cordis.yml:427` — 生成产物同步。
- `packages/dsh-liangshen-anchored/test/composition.test.mjs:103` — 断言新键、`modelDiscovery`，并拒绝旧键 `modelSelectionSettings`。
- `packages/dsh-liangshen-anchored/README.md` — 说明改为 `modelSelection` + `modelDiscovery`。
- `AGENTS.md` — D-010 口径改为 0.2.2 键名，并补状态指针。

## 验证

已跑：

- `node --test packages/dsh-liangshen-anchored/test/composition.test.mjs` → **13/13 pass**（改测试先 RED，再改配置转 GREEN）。
- `node --test packages/dsh-liangshen-anchored/test/*.test.mjs` → **120/120 pass**。
- `node --test packages/*/test/*.test.mjs` → **282/282 pass**。
- 用当前 Host 的 `Config` 实际解析两份组合的 `tool-subagent` 行：
  `node .superpowers/sdd/2026-11-15-subagent-model-selection/evidence/check-preset-config.mjs` →
  `agent.cordis.yml` 与 `agent.empty-system.cordis.yml` 均为
  `{"modelSelection":true,"modelDiscovery":true,"reasoningEffort":"high"}`。
- 临时 `dsh web`（127.0.0.1:3099，真实 web profile，当前 workspace link）会话
  `session-3bc4a7bc-609d-4e7a-97f2-8eedcacefe99`（`liangshen`）：
  - 所有已声明预设 mount 成功（`broken:null`）；
  - 首请求 tools = `[bash, str_replace_editor]`，persona 正确；
  - 晋升后 `subagent` 参数为 `cwd, description, name, prompt, provider, model, reasoning_effort`；
  - `list_subagent_models` 已注册；`subagent_fork` 参数仍为 `cwd, description, name, prompt`（继承父路由）；
  - 会话记录了 `subagent/model-selection-policy`，授权
    `deepseek-official/deepseek-flash` 与 `deepseek-account/deepseek-flash`。
  - 证据（本机留痕，不进 git）：`.superpowers/sdd/2026-11-15-subagent-model-selection/evidence/`。

**已知失败（与本次改动无关，未修）**：同一次验证里，“首轮零自动注入上下文”检查失败——首请求多了一条
`source.kind = runtime-context` 的 `subagent:identity` 消息，来自 0.2.2-rc.3 官方
`@deepseek-ai/dsh-tool-subagent-control` 的 required system-prompt context。首请求工具面仍是 Minimal 双工具、
persona 仍正确；`subagent` 工具不在首请求里，因此本次 `modelSelection`/`modelDiscovery` 改动不是该泄漏的原因。
该首轮 identity 泄漏是当前 0.2.2-rc.3 适配的独立问题，留待单独处理。

## 应用状态

- 当前 3080 Host（pid 16776，16:48 启动）在**启动时挂载预设组合**；本次只改了预设 YAML + 测试，
  没有重启 3080（重启会断当前会话）。因此 3080 的新梁神会话仍可能使用旧挂载组合，**需要重启 3080** 后才能验收。
- 临时 3099 Host 已证明：按当前文件启动时，新组合能挂载且 `subagent` 带三字段。
- 重启 3080 后的验收：新建梁神会话 → 首请求仍双工具（已知 identity 泄漏除外）→ 晋升后
  `subagent` schema 带 `provider/model/reasoning_effort`、`list_subagent_models` 可见 → 会话策略事件授权两条
  deepseek-flash 路由。若要选 `deepseek-v4-pro`，还需在 Web 设置页/allowlist 增加该路由（只对新会话生效）。
