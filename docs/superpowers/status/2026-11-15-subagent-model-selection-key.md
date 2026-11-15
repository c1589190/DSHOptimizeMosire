# 2026-11-15 子 Agent 模型选择 + 首轮 subagent:identity 泄漏修复

## 一、子 Agent 模型选择键名修复

- **根因**：梁神/空提示词预设的 `tool-subagent` 行仍写 DSH 0.2.1 时代的
  `modelSelectionSettings: true`。DSH 0.2.2 已把该选项改名为 `modelSelection`，官方升级指南明确要求迁移
  （`docs/upgrade-guide/v0.2.1-rc.1/subagent-control-tools/guide.zh.md:12,20`）；当前插件的 `Config` 只读
  `modelSelection`（默认 `false`，`modelDiscovery` 默认 `false`）。旧键被 Schemastery 当作未知键保留，不报错，
  所以预设仍 `broken:null`，但工具实例实际没有开模型选择。
- **后果**：梁神/空提示词新会话晋升后，`subagent` 不暴露 `provider` / `model` / `reasoning_effort`，
  `list_subagent_models` 也不注册；只有 `agentOptions.reasoningEffort: high` 生效。
- **修复**：两预设的 `tool-subagent` 行改为 `modelSelection: true` + `modelDiscovery: true`，
  保留 `agentOptions.reasoningEffort: high`。空提示词变体由生成器重生成。

## 二、首轮 `subagent:identity` 泄漏修复

- **根因**：DSH 0.2.2 的 `suppressRuntimeContext()` 按设计**保留 required context**
  （`@deepseek-ai/dsh-system-prompt/src/index.ts:598`：`suppressed && provider?.required !== true` 才跳过）。
  官方 `@deepseek-ai/dsh-tool-subagent-control/src/index.ts:86,95` 在 0.2.2-rc.3 注册了 required 的
  `subagent:identity` context；`context-gate.mjs` 只 shadow 了 `working-directory:current`，所以 identity
  以 `source.kind = runtime-context` 的消息漏进首请求。
- **修复**：`context-gate.mjs` 在 unpromoted 阶段增加同名空 shadow：
  `subagent:identity`、`required: true`、`text: ''`、order 取 `getContextOrder('SUBAGENT_DELEGATION')`；
  只有该 order 可知（0.2.2-rc.3）时才注册，旧版本跳过。晋升/压缩重锚时随其他 shadow 一起释放。
- **改动**：`packages/dsh-liangshen-anchored/presets/liangshen/context-gate.mjs:189-224`；
  新增 `packages/dsh-liangshen-anchored/test/context-gate.test.mjs:43,52`（分别断言 working-directory 与
  subagent:identity 的 required 空 shadow）。

## 验证

- `node --test packages/dsh-liangshen-anchored/test/context-gate.test.mjs` → **2/2 pass**（未加 identity shadow 前
  第二条先 RED）。
- `node --test packages/dsh-liangshen-anchored/test/composition.test.mjs` → **13/13 pass**。
- `node --test packages/dsh-liangshen-anchored/test/*.test.mjs` → **122/122 pass**。
- `node --test packages/*/test/*.test.mjs` → **284/284 pass**。
- 配置层复算：`node .superpowers/sdd/2026-11-15-subagent-model-selection/evidence/check-preset-config.mjs` →
  两份组合均为 `{"modelSelection":true,"modelDiscovery":true,"reasoningEffort":"high"}`。
- 临时 `dsh web`（127.0.0.1:3099，真实 web profile，当前 workspace link）会话
  `session-609beacc-ac61-4f24-ad9d-6d23626fc3d4`（`liangshen`）——全部检查 `ok:true`：
  - 首请求 tools = `[bash, str_replace_editor]`；
  - **首请求零自动注入上下文**（`injected sources: []`，identity 泄漏已消失）；
  - persona 正确；
  - 晋升后 `subagent` 参数为 `cwd, description, name, prompt, provider, model, reasoning_effort`；
  - 晋升后的 runtime-context 消息（seq 20）重新包含 `subagent:identity`，证明空 shadow 只作用于 gate 关闭阶段；
  - `list_subagent_models` 已注册；`subagent_fork` 参数仍为 `cwd, description, name, prompt`（继承父路由）；
  - 会话记录 `subagent/model-selection-policy`，授权
    `deepseek-official/deepseek-flash` 与 `deepseek-account/deepseek-flash`；
  - `compaction re-anchor` 因本次会话未触发压缩而 **skipped（未验证）**。
  - 证据（本机留痕，不进 git）：`.superpowers/sdd/2026-11-15-subagent-model-selection/evidence/`。

## 应用状态

- 当前 3080 Host（pid 16776，16:48 启动）在**启动时挂载预设组合**；本次没有重启 3080（重启会断当前会话）。
  因此 3080 的新梁神会话仍可能使用旧挂载组合，**需要重启 3080** 后才能验收。
- 临时 3099 Host 已按当前文件证明：首请求零注入、双工具；晋升后 `subagent` 带三字段、
  `list_subagent_models` 可见、策略授权两条 deepseek-flash 路由。
- 重启 3080 后的验收：新建梁神会话 → 首请求双工具 + 零注入 → 晋升后 `subagent` schema 带
  `provider/model/reasoning_effort`、`list_subagent_models` 可见 → 策略事件授权两条 deepseek-flash 路由。
  若要选 `deepseek-v4-pro`，还需在 Web 设置页/allowlist 增加该路由（只对新会话生效）。
