# 梁神模式（锚定式）复刻设计 · 功能一

> **状态**：设计已批准（2026-10-17，用户选择 D-001=A / D-002=A / D-003=B），本文为**待用户评审的 spec**。
> **关联**：`docs/agents/00-调研-梁神模式谱系.md`；决策记录 `.agents/notes/implemented/2026-10-17-liangshen-replication-scope.md`。
> **用户原话附录**见 §12。**本文不含实现代码**；实现须在 spec 评审通过并出实现计划后进行。

## 1. 目标

在官方 DSH 0.2.0-rc.2 上，以 **Web profile 可安装 bundle** 的形式，复刻锚定式梁神模式 v7：

1. 首轮锚定：新会话第一条模型请求只暴露 Minimal 精确双工具（持久 `bash` + `str_replace_editor`），并剥离一切自动注入上下文；
2. 首调晋升：首个持久工具调用（或首个 assistant 消息，`promoteOn: either`）后放开完整组装目录；
3. 压缩重锚：`compaction/end` 后 epoch 感知地回到受控态，等新的持久信号再晋升；
4. 吸收上游小改进：`promoteOn: either`、`context-gate` 统一注入控制、Windows 后台任务（config-gated）。

**不修改 DSH 源码**；只使用官方 bundle patch、`@deepseek-ai/dsh-agent-preset` 声明与官方 peer 包。

## 2. 成功判据（验收；含负向用例）

| ID | 判据 | 验证方式 |
|---|---|---|
| A1 | `plugin_manager install_bundle` 安装本包后，preset 行 `preset-liangshen` 激活**无 diagnostic** | `plugin_manager list_plugins` + `cordis_inspect_query Config.listConfigs` |
| A2 | 新建会话的预设选择器出现「梁神模式」（name/order 正确） | 真实 Web 新建会话页 |
| B1 | 新会话**第一条**模型请求工具面恰为 `bash` + `str_replace_editor`（无其它工具） | 会话 JSONL `request/header`（首条，`reason` 属 initial/series） |
| B2 | 首轮 system prompt = persona 块（一行 persona + 工作纪律 + `Your working directory is <cwd>.`；plan mode 时另加 `plan:policy`） | 会话 JSONL `system/message` / header 对应事件 |
| B3 | 首个 step **不含** `skill-catalog` / `agent-instructions` 自动注入消息（context-gate 开启后：任何自动注入都被关闭） | 会话 JSONL 首 step 的 message source 清单 |
| C1 | 首个持久工具调用之后的下一条请求工具面 = 完整组装目录（数量 > 2，且包含 fs/jobs/skill/goal/todo/ask-user/web/subagent 等） | 会话 JSONL 第二条 `request/header` |
| D1 | `/compact`（或自动压缩）后的下一条请求重新收窄为 bootstrap 双工具；新的持久信号后再次放开 | 真实会话 + `/compact` + JSONL 断言 |
| E1 | `includeSubagents: true`：子代理首轮同样双工具，首调后放开 | 真实会话派发子代理 + 子会话 JSONL |
| F1 | 会话 resume / 进程重启后相位从持久事件流重建（已晋升仍晋升、未晋升仍受控） | 重启 `dsh web` 后恢复会话 + JSONL 断言 |
| G1 | 缺 bootstrap 工具：一次性告警 + 降级全目录，不 brick 会话 | 单测 + L1 日志 |
| G2 | 过滤器自身异常：保留上下文 / 全目录（绝不吞上下文） | 单测（注入异常桩） |
| G3 | 配置非法（未知键/坏类型）：安装激活期 fail-fast | 单测 + L1 负向安装 |
| H1 | `custom-bash` Git Bash 解析顺序、拒绝 System32/WSL 启动器 | 单测（mock fs/env/平台） |
| H2 | Windows 后台任务开关默认关闭、开启后工具 schema 含 `run_in_background` | 单测（**本机无法实机验证，明确标注**） |
| I1 | 全部证据（命令+输出+JSONL 摘要）落 `.superpowers/sdd/<topic>/evidence/` | 台账检查 |

**负向用例**：非锚定预设（standard）首轮工具面不受影响；`bootstrapTools` 缺失工具时不得静默删除能力；取消/失败路径不得写坏会话日志。

## 3. 非目标

- 双分支按模型路由、guard 运行时熔断、`fact_register`、working-context 行、`maxResidentTokens`、`dev_tool_search`、`prefab`（后续 spec）；
- TUI / 桌面 / 手机端兼容；
- npm 发布、市场条目、老虎机拨杆/设置卡（v2 可选）；
- 修改 DSH 源码或覆盖官方 preset 行。

## 4. 工程骨架（monorepo，双 bundle）

```
DSHOptimizeMosire/
  packages/
    dsh-liangshen-anchored/          # 功能一（本 spec）
      package.json                   # private, type:module, dsh.bundle.patch, peerDeps @deepseek-ai/dsh
      cordis.patch.yml               # 静态插入 preset 声明（首选）或 host 插件行（fallback）
      presets/liangshen/
        preset.yml                   # name: 梁神模式 / order: 5（元数据源，构建期不读亦可）
        agent.cordis.yml             # 组合（v7 基线 + context-gate 行）
        tool-bootstrap.mjs           # 上游 preset/ 版（promoteOn: either 语义由组合配置）
        context-gate.mjs             # 上游 preset/ 版（统一注入控制）
        instruction-hint.mjs         # v7 原样
        skill-search.mjs             # v7 原样
        custom-bash.mjs              # v7 + P1 Windows 后台任务（config-gated，默认关）
        compaction-epoch.mjs         # v7 原样
        session-events.mjs           # v7 原样
      lib/index.js                   # 仅 fallback 承载时存在（M0 决定）
      test/*.test.mjs                # node --test（零依赖）
      locale/{zh,en}.json  icon.svg  NOTICE  LICENSE  README.md
    dsh-goal-confirm/                # 功能二（另一 spec）
  tools/verify-session.mjs           # 会话 JSONL 断言工具（协议级验收）
  docs/ .agents/ .superpowers/ AGENTS.md
```

原则：plain ESM、**无构建步骤、无运行时依赖**；官方 `@deepseek-ai/*` 走 peer/运行时解析，不打包进产物。

## 5. 承载方式（M0 决策门）

**首选：静态 preset 声明**

`cordis.patch.yml`：

```yaml
- insert:
    - id: preset-liangshen
      name: '@deepseek-ai/dsh-agent-preset'
      config: !!js >-
        ({
          id: 'liangshen',
          name: '梁神模式',
          description: '主 Agent 与子 Agent 首轮均保持极简模式的最小工具面，首次工具调用后开放完整目录，压缩后重新锚定。',
          order: 5,
          plugins: [{
            id: 'liangshen-plugins',
            name: '@deepseek-ai/cordis-plugin-include',
            config: { path: new URL('./presets/liangshen/agent.cordis.yml', ctx.baseUrl).href },
          }],
        })
```

依据：官方 preset 声明 schema 为 `{id,name,description,order,plugins}`（Inspect 已核）；`@deepseek-ai/cordis-plugin-include` 以 include 的 `ctx.baseUrl` 解析 `config.path`（本机 `…/cordis-plugin-include/lib/index.js:123`）；官方 minimal preset 即静态声明先例。

**判据**：装包后 preset 激活无 diagnostic（`Config.listConfigs` 可见且新建会话可选）。

**fallback（M0 30 分钟内判不过即切换）**：`lib/index.js` host 插件，`apply()` 内用 `ctx.agentPresets.register({id,name,description,order,plugins})` 声明，include 路径由 `import.meta.url` 求绝对 file URL；`cordis.patch.yml` 改为插入该插件行。该路线已被 TUI `bundled-presets.js` 与 dsh-web `lib/index.js` 两条上游实现证明。

两条路线互斥；M0 结论与证据写入 `.superpowers/sdd/<topic>/impl-ledger.md`。

## 6. 组合与移植矩阵

### 6.1 组合 `agent.cordis.yml`

基线：`~/.dsh/.agent-presets/liangshen/agent.cordis.yml`（v7，425 行，20 row）。
改动（逐条记账）：

1. `tool-bootstrap` row 换上游版（301 行）语义：删除 `suppressedContextSources`（注入控制交给 context-gate），保留 `bootstrapTools: [bash, str_replace_editor]`；
2. 新增 `context-gate` row（**必须是第一个 row**，`name: ./context-gate.mjs`，config `{promoteOn: either, includeSubagents: true, allowKinds: [skill-invocation]}`）；
3. `tool-bootstrap` 与 `instruction-hint` 的 `promoteOn` 统一为 `either`、`includeSubagents: true`（三者必须同步；单测校验一致性）；
4. 其余 19 个 row 保持 v7 语义；包名按 M0 兼容清单修正（官方技能警告：v7 写于 0.1.x，改名的包会在激活期失败）；
5. `persona` 文本保持与官方 minimal 逐字节一致（含 `prefix`/`text` 版本兼容表达式）。

### 6.2 移植源矩阵

| 文件 | 行数 | 来源 | 本轮改动 |
|---|---|---|---|
| `tool-bootstrap.mjs` | 301 | 上游 `xiaobright/dsh-anchored-standard` `preset/`（MIT） | 原样（注释可保留） |
| `context-gate.mjs` | 202 | 上游 `preset/`（MIT） | 原样 |
| `instruction-hint.mjs` | 190 | 本机 v7 | 原样 |
| `skill-search.mjs` | 141 | 本机 v7 | 原样 |
| `custom-bash.mjs` | 301 | 本机 v7 | P1：Windows 后台任务（config-gated，默认 `backgroundJobs: false`） |
| `compaction-epoch.mjs` | 83 | 本机 v7 | 原样 |
| `session-events.mjs` | 8 | 本机 v7 | 原样（bundle 内可直接 import，保留自包含实现） |
| `agent.cordis.yml` | 425 | 本机 v7 | §6.1 五条改动 |

> 上游与本机 v7 的差异与出处见调研长文 §十；许可都是 MIT，`NOTICE` 必须列明改编来源。

## 7. 状态机与数据流

### 7.1 晋升状态机（单测核心）

```
state(session) = { boundary: number, promoted: boolean }
初始: { boundary: -1, promoted: false }
事件折叠:
  compaction/end            → { boundary: seq, promoted: false }
  promoteSignal & seq>boundary → promoted = true
promoteSignal = tool/call | assistant/message   (promoteOn: either)
```

- 相位从**持久事件流**重建（冷启动扫一次 + 增量 observe），resume/重载一致；
- `delegationDepth > 0`：`includeSubagents: true` 时同相位；否则视为已晋升；
- 压缩后 `compactionTools` 为空 ⇒ 保持 bootstrap 双工具直到新的持久信号。

### 7.2 请求面数据流

1. **首轮**：`system-prompt/assemble` → context-gate 关闭 runtime-context；tool-bootstrap 收窄 `tools` → 执行；
   `agent/pre-step` → context-gate 只保留 claimed batch + `allowKinds`；tool-bootstrap 兜底剥（上游版已移除，由 gate 负责）。
2. **首调后**：gate 打开；tool-bootstrap 放行完整目录；instruction-hint 注入一次 hint（`source.kind = instruction-hint`）。
3. **压缩后**：boundary 更新、gate 重新关闭、目录收窄 → 等待新信号。

## 8. 错误处理与降级（全部 fail-open，除配置外）

| 场景 | 行为 |
|---|---|
| 配置非法（未知键/类型错/非正数） | 激活期 `TypeError` fail-fast（安装可见、可修） |
| bootstrap 工具缺失 | 一次性 warn + 暴露全目录（不 brick 会话） |
| 过滤器内部异常 | 保留全部上下文 / 全目录 + warn（绝不吞上下文） |
| preset 声明失败 | roster 保留行 + diagnostic，不组合会话（官方行为） |
| 事件流读取失败 | 视为未晋升（保守锚定）并 warn |

## 9. 验证计划

- **L0 单测**（`node --test`）：晋升状态机（compaction 边界、either、子代理、恢复）、配置校验负向、gate/bootstrap 配置同步、custom-bash 解析顺序（mock 平台/fs/env）、后台任务 schema（开关开/关）。
- **L1 安装 spike**：`plugin_manager install_bundle` → 观察 `application`/`warnings` → `Config.listConfigs` 确认 `preset-liangshen`；新建会话可选。
- **L2 协议级 smoke**（1 条真实会话，deepseek-flash）：正常一轮工具调用 → `/compact` → 再一轮；
  导出 `~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`（Node ≥22.15 `zlib.zstdDecompressSync` 可读），
  `tools/verify-session.mjs` 断言 B1/B2/B3/C1/D1；子代理另跑一次断言 E1。
  注：日志为增量 flush，**必须在 turn 结束后读取**（必要时等待会话 idle）。
- **L3 隔离矩阵**（P1，可选）：3 任务 × 2 臂（v7 保真 vs +B 档）× 2 重复；记录 DSH 版本/preset 源码 hash/route/费用；不承诺统计提升。
- **L4 兼容回归**：resume、`source.kind` 词表、preset id 稳定、旧会话可恢复。
- 证据落 `.superpowers/sdd/2026-10-17-liangshen-anchored/evidence/`；未跑项写「未验证」。

## 10. 里程碑与任务分解（相邻任务可并行，但文件写作用域不重叠）

| 里程碑 | 任务 | 产物 | 验收 |
|---|---|---|---|
| M0 | 承载 spike + 包名/事件名兼容清单 | impl-ledger 决策段 | 静态声明通或 fallback 定案；20 row 全核 |
| M1 | 移植 7 个插件 + 组合 yml + 单测 | `packages/dsh-liangshen-anchored/**` | L0 全绿 |
| M2 | 安装 + 协议验收 | 会话 JSONL 证据 + `tools/verify-session.mjs` | A1/A2/B1-3/C1/D1/E1/F1 |
| M3 | P1 改进（Windows 后台任务 config-gated） | custom-bash 改动 + 单测 | H1/H2（H2 标注未实机） |
| M4 | 文档/状态/checkpoint | status 存档 + spec 回填 | I1 |

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 静态声明中 `ctx.baseUrl` 解析路径不确定 | M0 spike 卡点（30 分钟）；fallback 已设计 |
| v7 写于 0.1.x，包名/事件名漂移 | M0 全量回核 + 官方 Inspect 校验，逐条记账 |
| 会话日志增量 flush 导致证据读取过早 | turn 结束后读取；以 `request/header` 序列为准 |
| 无 Windows 实机 | 只做单测 + 静态审查，验收明确标「未实机验证」 |
| 与功能二同装冲突 | 功能二在 host 层独立监听；两包互不依赖；L2 联测 |
| 许可合规 | MIT + NOTICE（DSH minimal/standard/ptc、TUI v7、anchored-standard 均 MIT） |

## 12. 用户原话附录（逐字，2026-10-17）

> 「起因是，我目前使用了比较长时间的dsh，但是效果参差不齐，偶然想到之前有一个被删掉的梁神模式貌似挺好用，你先搜索一下相关资料——这个项目就是要复刻一下这个模式，同时做一些功能上的优化，先调查、创建AGENTS.md，本项目通用上下文的规则可以参考隔壁~/SimualtorMosire的结构」

裁定（用户选择）：D-001=A 锚定式 v7 保真复刻；D-002=A Web profile 插件 bundle；D-003=B 复刻 + 上游小改进；D-006 随 D-003（基线=v7，吸收 `promoteOn: either`/`context-gate`/Windows 后台任务）；D-004 默认沿用「梁神模式」/order 5/MIT；D-005 默认协议级 smoke + 12 会话小矩阵。
