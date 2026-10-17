# @mosire/dsh-liangshen-anchored

「梁神模式（锚定式）」的现代复刻：把社区已停用的 **anchored standard** 梁神预设，以官方
`@deepseek-ai/dsh-agent-preset` 声明机制重新装回 DSH Web profile。

本 bundle 声明**两个预设**：

| 预设 id | 名称 | 说明 |
|---|---|---|
| `liangshen` | 梁神模式 | 锚定式主预设（order 5） |
| `liangshen-empty-system` | 梁神模式·空系统提示词 | 与主预设完全一致，仅系统提示词替换为**单个 ASCII 空格**（order 6，对照用） |

## 它做什么

1. **首轮锚定**：新会话第一条模型请求只暴露官方 Minimal 精确双工具
   （持久 `bash` + `str_replace_editor`），并把 skill 目录、AGENTS.md 摘要、runtime-context
   与一切自动注入挡在首轮之外（`context-gate` + `tool-bootstrap`）。
2. **首调晋升**：首个持久晋升信号（`tool/call` 或 `assistant/message`，`promoteOn: either`）
   之后，下一条请求放开完整组装目录。
3. **压缩重锚**：`compaction/end` 之后 epoch 感知地回到受控态，等新的持久信号再晋升。
4. **子代理同相位**：`includeSubagents: true`，子代理首轮同样锚定。

系统提示词与官方 Minimal 逐字节一致（单行 persona），AGENTS.md 不在首轮注入；
晋升后由 `instruction-hint` 注入一条非命令式提示，模型自己读文件。

子 Agent 的模型/档位：`tool-subagent` 行开启 `modelSelectionSettings: true` 并设
`agentOptions.reasoningEffort: high`——在新会话里 `subagent` 工具可选 `provider` / `model` / `reasoning_effort`
（`list_subagent_models` 查目录），不给参数时子 Agent 默认思考档位 `high`。前提：Host 的
`subagent-model-selection` 设置已启用（Web profile 自带），且策略在会话创建时记录（旧会话不追溯）。
`subagent_fork` 固定继承父模型，不支持选择。

空系统提示词变体的组合由 `tools/sync-preset-variant.mjs` 从主组合生成（唯一差异为 persona 字面量，
单测会拦截产物过期）。生成/校验：

```sh
node tools/sync-preset-variant.mjs           # 校验产物是否最新
node tools/sync-preset-variant.mjs --write   # 主组合改动后重新生成
```

## 安装（Web profile）

```sh
# 1) 为组合里的 @deepseek-ai/* 裸包名建 symlink（指向运行中的 DSH 安装）
node tools/link-dsh-peers.mjs
# 2) 安装 bundle（或由 plugin_manager install_bundle 安装到当前 profile）
dsh plugin --profile web add link:/home/cna/DSHOptimizeMosire/packages/dsh-liangshen-anchored
```

装完新开会话，在预设选择器里选「梁神模式」或「梁神模式·空系统提示词」。

> 为什么要 symlink：组合 YAML 由 `@deepseek-ai/cordis-plugin-include` 从包内目录加载，
> 其中的 `@deepseek-ai/*` 裸包名由 Node 从该目录向上找 `node_modules`；workspace 包没有自己的依赖树，
> 故用 symlink 指向 DSH 安装（realpath 相同，与宿主共享同一模块实例）。
> 诊断：声明结果会写到 `$DSH_HOME/liangshen-anchored-status.json`（best-effort）。

## 目录

```
cordis.patch.yml                  # 插入 preset-liangshen 声明
presets/liangshen/
  preset.yml                      # 主预设名称/order 元数据
  preset.empty-system.yml         # 空系统提示词变体元数据（order 6）
  agent.cordis.yml                # 21 行组合（context-gate 首行）
  agent.empty-system.cordis.yml   # 生成的空提示词组合（勿手改）
  tool-bootstrap.mjs              # 首轮收窄 + 晋升（v7）
  context-gate.mjs                # 统一注入控制（上游）
  instruction-hint.mjs            # 晋升后一条指令文件提示
  skill-search.mjs                # 按需 skill 检索（替代全量目录注入）
  custom-bash.mjs                 # Windows Git Bash 等价 bash
  compaction-epoch.mjs            # 晋升纪元（压缩感知）
  session-events.mjs
test/                             # node --test（组合/纪元/verifier/后台任务）
lib/index.js                      # host 插件：激活时声明两个预设 + 诊断状态文件
```

## 验证

```sh
cd packages/dsh-liangshen-anchored && node --test test/*.test.mjs
# 真实会话协议断言：
node ../../tools/verify-session.mjs <session.v4.jsonl.zstd> --preset liangshen
# 空系统提示词变体（期望首条 system message 恰好为一个空格）：
node ../../tools/verify-session.mjs <session.v4.jsonl.zstd> --preset liangshen-empty-system
```

## 许可

MIT。移植来源与版权声明见 `NOTICE`。
