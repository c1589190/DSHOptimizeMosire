# 极简模式·提示词实验（prompt-lab）设计 · 功能九

> **状态**：已实现；2026-11-04 真实 E2E 通过（临时 3099 web Host，`session-6eaacc2c…`；8/8 checks；官方 minimal 对照 56 工具/注入一致）；全工作区 251/251 单测。用户 2026-11-04 选 B（硬替换）。
> **用户原话（2026-11-04，逐字）**：
> - 「不要用梁神模式作为预设基底，而是极简模式 命令咋办？/sp file xxx.md 然后这个md文件就是系统提示词了？」（m00296）
> - 「2 是的，不用放行这些工具 / 3 我想要的是，这个预设的话，一个会话在开头导入一个文件里的系统提示词后，之后就一直用这个，直到手动用sp命令在对话期间切换，那么整个费缓存改注入，这也是我想要的 / 4 根据以上，理论上来说就是要空会话的时候先sp / 其他没啥问题」（m00339）
> - 「为何是追加，我要的就是替换全会话的第一条，也就是B / 也许可以开始了」（m00405）
>
> 关联：`docs/superpowers/specs/2026-10-17-empty-system-prompt-design.md`（功能四，空系统提示词预设）；
> `docs/agents/00-调研-梁神模式谱系.md`；上游 `@deepseek-ai/dsh-web-app/presets/minimal.patch.yml`（0.2.1-rc.4）。
> 本文不含实现代码；实现按 `docs/superpowers/plans/2026-11-04-prompt-lab-preset.md` 执行。

## 1. 目标

新增**第三个 agent preset**：`minimal-prompt-lab`（显示名「极简模式·提示词实验」，order 4）。

- 基底 = **官方 Minimal（极简模式）**，不是梁神模式：工具面 `bash` + `read_image`，无 read/write/edit、无 skills/goal/planning/todo/web/delegation；
- 系统提示词**唯一段**（`complete: true`，抑制 runtime context）由一个**每次 assembly 求值**的 provider 提供，文本来自会话自己的 `/sp` 选择；
- 每个会话独立选择；**没有全局默认**：未 `/sp` 的会话用官方 persona 行 `You are a helpful software engineer assistant.`；
- `/sp file <path>` 在**下一次模型请求**读取文件，首个 `system/message` 即快照；之后文件再改不影响本会话；
- 会话中途 `/sp` = **硬替换**：下一次请求把会话第一条 system 消息换成新文本（`startsRequestSeries` → `SystemPromptProjection.project` 的 replace 分支），旧提示词从 surface 移除，整段早停缓存失效（用户明确要这个代价）。

## 2. 成功判据（验收）

| ID | 判据 | 验证方式 |
|---|---|---|
| A1 | 激活后 roster 出现第三个预设 `minimal-prompt-lab`（order 4），`broken:null`；`liangshen` / `liangshen-empty-system` 零回归 | `$DSH_HOME/liangshen-anchored-status.json` + 单测 |
| A2 | 组合 = 官方 Minimal 的 rows（tool-fs/compaction/persistent-shell）+ 本地 persona/command 两行；**预设自有**工具行 = `bash` + `read_image`（web profile 的宿主插件会给所有 preset 追加 profile 级工具；实测与官方 minimal 对照完全一致，read/write/edit 不在其中） | 组合单测 + 真实会话 header + 官方 minimal 对照 |
| B1 | 空白会话先 `/sp file exp.md` → 首条 `system/message` 文本 == 文件文本（BOM 去除后逐字节）；无 harness identity | 真实会话日志 + 判定脚本 |
| B2 | 首条消息之后编辑 exp.md，再发消息 → system 文本仍是旧快照（冻结） | 真实会话日志 |
| C1 | 会话中途 `/sp file exp2.md` → 下一次请求的**第一条** system 消息变为 exp2 文本，exp 文本不再出现在 surface | 真实会话日志（surface nodes） |
| C2 | C1 之后 `/sp clear` → 下一次请求第一条 system 消息回到官方 persona 行 | 真实会话日志 |
| D1 | `/sp text`、`/sp blank`（单个空格）、`/sp show` 行为符合语义；`/sp` 不开启 turn | 单测 + 命令结果 |
| D2 | 空文件、超 256 KiB、NUL 字节、相对路径无 cwd → `{kind:'error'}`，不写入选择 | 单测 |
| E1 | `/sp` 只在 prompt-lab 会话可见；其他预设会话的投影/守卫零影响 | 真实会话 + 单测 |
| E2 | fork/resume：继承的 `command/run`+`system/message` 折叠出同一份有效提示词；父会话崩溃留下的半截 `/sp`（无 `command/done`）不生效 | 单测（合成事件） |
| F1 | 文件在 `/sp` 之后、下一次请求之前被删除 → 回退到旧快照（有则）或官方 persona，并告警；不抛错 | 单测 |

**负向用例**：`/sp` 拼写错误不改变状态；`/sp show` 不改变状态；切换失败的 `/sp` 不留下 pending；`complete` section 永远只有一个（不得与官方 persona 段并存）。

## 3. 非目标

- 不做全局默认提示词（跨会话共享状态会引入竞态；用户明确「空会话先 /sp」是标准流程）；
- 不做会话级提示词版本/历史（session log 本身就是版本记录）；
- 不做工具面的动态配置（工具面固定 = 官方 Minimal 的 bash + read_image）；
- 不做 UI 定制（无新面板/槽位；命令结果显示在现有命令结果里）；
- 不修改 `liangshen` / `liangshen-empty-system` 的任何行为；
- 不引入运行时构建/生成步骤（组合文件与插件提交在仓库内）。

## 4. 架构与实现方案

### 4.1 承载（D-026）

- 新目录 `packages/dsh-liangshen-anchored/presets/minimal-prompt-lab/`：
  - `agent.cordis.yml`：官方 Minimal 的 plugins 列表逐行照抄（`tool-fs`、`compaction` group、`persistent-shell` group），persona 行替换为本地 `./prompt-lab-persona.mjs`，追加 `./prompt-lab-command.mjs`；
  - `preset.yml`：name/description/order 4；
  - `prompt-lab-persona.mjs`、`prompt-lab-command.mjs`：两个本地 plugin（loader 把 `./x.mjs` 解析到组合目录，已有先例：`presets/liangshen/agent.cordis.yml` 的 `./context-gate.mjs` 等）。
- `lib/index.js` 的 `PRESETS` 增加第三项；每项加可选 `root`（默认 `PRESET_ROOT`），因为现有 `PRESET_ROOT` 固定指向 `presets/liangshen/`。
- 组合与官方 minimal 的漂移：`test/prompt-lab-composition.test.mjs` 断言 rows/config 的关键形状；`tools/check-minimal-drift.mjs`（可选，见 Task 8）在 DSH 升级后对比官方 patch。

### 4.2 系统提示词 provider（D-027）

`prompt-lab-persona.mjs`：

```js
export const name = 'prompt-lab-persona'
export const inject = ['systemPrompt']
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'deployment:persona-prefix',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    complete: true,
    interpolate: false,
    text: (context) => resolveForAgent(ctx, context?.agent),
  })
  ctx.systemPrompt.suppressRuntimeContext()
}
```

- `complete: true` → `systemPrompt.assemble()` 把它恢复为**唯一** section（`@deepseek-ai/dsh-system-prompt/lib/index.js:386-396`）；`suppressRuntimeContext()` 去掉可选 runtime context；
- `interpolate: false` → 文件里的 `{{...}}` 不被当变量；
- provider 每次 assembly 求值；`AssembleContext.agent` 由 dsh-agent 注入（`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts` 的 augmentation；`assembleContextFor(agent, signal)`）；
- 解析顺序（`lib/prompt-lab-state.js` 的 `resolveLabPrompt`）：
  1. 有 pending 切换（selection.seq > lastSystemSeq）→ 解析选择：`file` 读文件、`text` 字面量、`blank` = `' '`、`default` = 官方 persona；
  2. 否则若 `lastSystemText !== ''` → 返回它（冻结快照）；
  3. 否则返回官方 persona 行。
- 解析失败（文件不存在/超限/NUL）→ 回退到快照（有）或官方 persona，并 `ctx.logger.warn`；不抛错（assembly 不能因实验文件坏掉而失败）。

### 4.3 会话状态（D-028）

`lib/prompt-lab-state.js` 导出：

- `PROMPT_LAB_KEY = 'prompt-lab'`、`PROMPT_LAB_STATE_VERSION = 1`；
- `init(header)` → `{cwd, selection:null, lastSystemText:'', lastSystemSeq:0, pending:[]}`；
- `apply(state, event)`：
  - `system/message`：文本非空 → 更新 `lastSystemText/lastSystemSeq`；
  - `command/run`（`name === 'sp'`，且 parse 为 file/text/blank/clear）→ `pending.push({commandId, selection:{kind, path?, text?, seq}})`；
  - `command/done`：按 `commandId` 找 pending；`kind === 'success'` 才把 `selection` 设为该 entry，否则丢弃；
- `isSwitchPending(state)` = `selection !== null && selection.seq > lastSystemSeq`；
- `promptLabStateSchema`：`{parse(value){轻量校验}, safeParse}`（不依赖 zod；包无运行时依赖）；
- `makePromptLabProjection()` → `{key, stateVersion, stateSchema, init, apply}`（无 `wire`）。

**为什么用 projection**：`Session.eventAt/snapshotEvents/ownEvents` 已标「禁止新调用」；`sessionProjections` 是官方唯一允许的同步读法。projection 注册在 Host 插件里（全局、一次），状态从 session log 折叠，resume/fork 天然一致；`command/done` 只在成功时生效，崩溃/失败的 `/sp` 不留下状态。
**已知代价**：`checkpoint(session)` 会 `structuredClone` 所有注册 key 的 state，冻结提示词文本因此也进 projection 缓存（与 `system/message` 重复）；实验级提示词 ≤ 256 KiB，可接受。

### 4.4 `/sp` 命令（D-029）

`prompt-lab-command.mjs`：`name='prompt-lab-command'`、`inject=['commands']`、`ctx.commands.register({name:'sp', description, input:{hint}, handler})`。

| 输入 | 语义 | 成功结果 |
|---|---|---|
| `/sp file <path>` | 选择文件；**下一次请求**读取；相对路径按 `session.header.cwd` 解析 | 绝对路径 + 字节数 + sha256 + 「下一条消息生效」 |
| `/sp text <一行>` | 选择内联文本（单行；多行用 file） | 字节数 + 生效说明 |
| `/sp blank` | 选择空提示词 = 单个 ASCII 空格 | 生效说明 |
| `/sp clear` | 回到未选择 = 官方 persona 行 | 生效说明 |
| `/sp show` | 显示选择 + 是否已冻结/待生效 + 快照元数据 | 三行状态 |

- 命令 handler 只做**校验与结果文案**，不写会话；`command/run` / `command/done` 由 commands 服务自动记录（`args = rawInput`，`/sp` 不开 turn）；
- 文件：UTF-8、去 BOM、拒绝空文件/纯 BOM/NUL/超 256 KiB；`sha256` 对「去 BOM 后的文本」计算，另报原始字节 sha256；
- 相对路径无 `header.cwd` → 报错，要求绝对路径；
- `show` 不打印提示词全文（避免长内容刷屏），只给来源/字节/sha256/冻结状态；需要全文看会话日志的 `system/message`。

### 4.5 硬替换（D-027）

Host 插件（`lib/index.js`）在 `agent/pre-step`（`prepend: true`）里：

```js
const state = registry.stateOf(agent.session, PROMPT_LAB_KEY)
const pending = isSwitchPending(state)
const decision = await next()
return pending && decision.kind === 'enter' ? { ...decision, startsRequestSeries: true } : decision
```

- `startsRequestSeries` 是官方 decision 字段（`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:94-98`：「Start a distinct model-message series before this step's admitted messages」）；目前唯一生产者是 `goal-round-driver`（grep 证实），本功能是第二个使用者；
- `SystemPromptProjection.project` 在 `startsSeries` 分支把 stale 的非空 system 节点置空并 `replace` 头节点 → 旧提示词从 surface 消失，整段缓存失效；
- 首个请求（无头节点）不需要 replace，`project` 直接 append；守卫的 flag 无害；
- 若实测该 flag 对 replace 分支无效（或与 goal driver 冲突）→ 回退 A（原生追加）：删掉守卫，其余不变；A 的代价是旧提示词留在历史里。

### 4.6 首轮 wire

- 首请求的 system 消息 = 文件/文本/空格/persona（`complete` 唯一段）；**不含** harness identity、runtime context、工具描述（工具描述在 tools 数组，不在 system）；
- 工具数组 = `bash` + `read_image`（`tool-fs` 的 read/write/edit 全 false，只留 readImage）；
- `/sp` 在首条消息前执行时，`command/run` + `command/done` 是 log-only，不会打开 turn；首条用户消息仍是首请求。

### 4.7 子 Agent / fork / resume

- 本预设有 `task`/delegation 吗？没有（官方 minimal 无），子 Agent 不适用；若将来加，子会话无 selection、首请求 = 官方 persona（可接受，spec 外）。
- fork/resume：事件前缀折叠；`selection.seq` 与 `lastSystemSeq` 都是事件 seq，顺序保持；父会话半截 `/sp`（无 done）不生效。
- 与 `goal-confirm` / `session-import` / `job-tools` 等现有功能无交集；`dshom` 的 `features.presets` 开关仍控制整套。

## 5. 验证

1. **单测**（`node --test packages/dsh-liangshen-anchored/test/*.test.mjs`）：
   - `prompt-lab-state.test.mjs`（13）：parse、状态折叠、pending、冻结、失败回滚、resolve 优先级、路径解析、文件校验、schema、`makeSwitchGuard`；
   - `prompt-lab-command.test.mjs`（6）/ `prompt-lab-persona.test.mjs`（5）：命令结果与 provider；
   - `prompt-lab-composition.test.mjs`（5）/ `prompt-lab-host.test.mjs`（2）：组合对齐与 Host 注册；
   - `prompt-lab-verify.test.mjs`（7）：`verify-prompt-lab` 的 8 项断言（含 native append 必须失败）；
   - 更新 `presets.test.mjs`（4）：3 个预设、order 4/5/6、组合 URL 存在、状态文件。
2. **真实会话**（临时 Host 或用户重启后的 3080）：空白会话 `/sp file` → 首条 system == 文件；改文件再发 → 冻结；中途 `/sp file` → 头节点替换；`/sp clear` → persona；`/sp show`；记录 header/事件 seq。
3. **回归**：`liangshen` / `liangshen-empty-system` 的 `presets.test` 与既有 verifier 仍过；`dshom` 全量测试 0 失败。

## 6. 未验证 / 风险

- **B 的 replace 分支已实机验证**（见 6.1）；A 回退仍保留为降级路径。
- **空白会话执行 `/sp` 已实机验证**（见 6.1）。
- **官方 minimal 漂移**：组合是 rc.4 的抄写；升级后 `tool-fs`/shell 行的 config 可能变。`check-minimal-drift.mjs` 是维护工具，不是硬门禁。
- **projection 缓存重复**：冻结文本进 projection checkpoint（见 4.3）；实验级大小可接受，若将来支持 MB 级提示词需改存引用。
- **命令结果长度**：`/sp show` 不打印全文；`file` 结果只给路径/字节/sha。
- **Windows**：shell 行按官方 disabled 表达式；本机 Linux 未跨平台验证。

### 6.1 验证记录（2026-11-04）

- **实机 E2E**（in-process `runProfile`，web profile，临时 3099 Host，live `~/.dsh`）：`session-6eaacc2c-002c-48be-ab41-89312906fe0f`，cwd `/tmp/dsh-prompt-lab-kQCtaC/ws`；空白会话 `/sp file prompt-a.md` → 首条 `system/message` == A；首轮结束后 `/sp file prompt-b.md` → 下一次请求 `system/message` seq 9 被 `surfaceOp {op:'replace',startSeq:9,endSeq:9}` 换成 B（seq 28），surface 只剩一个非空节点；8/8 checks（header、preset、minimal 工具面、无 preset 注入、单节点、无 harness identity、head==B、首条==A）。
- **对照**：同 Host 的官方 `minimal` 会话工具目录同为 56 个且集合完全相同；首步 `runtime-context` 注入也相同（profile 级基线，不是本预设注入）；控制组 system 为官方 persona 行。
- **持久化复核**：`node tools/verify-prompt-lab.mjs <session.v4.jsonl.zstd> --system-file …prompt-b.md --initial-file …prompt-a.md` → exit 0，8 checks，`failures: []`。
- **全量回归**：`node --test packages/*/test/*.test.mjs` → 251/251。
- **实现偏差**：验证器实现为独立 `tools/verify-prompt-lab.mjs`（不改 `verify-session.mjs`）；E2E 用 in-process `runProfile` + 3099（未用临时 `DSH_HOME`）；守卫由 `prompt-lab-state.test.mjs` + `prompt-lab-host.test.mjs` 覆盖，无单独的 `prompt-lab-guard.test.mjs`。
- **仍未真机**：`/sp clear`、`/sp text`、`/sp blank`、文件改动后的冻结（B2）、fork/resume、其他预设隔离、Windows。3080 Host 仍是旧进程，重启后才会出现第三个预设。

## 7. 裁定

- **D-026**：新预设 `minimal-prompt-lab` 承载于 `@mosire/dsh-liangshen-anchored`（不新建包），组合照抄官方 Minimal，persona 行换成本地 provider。
- **D-027**：系统提示词由 provider 每次 assembly 求值；`complete:true` + `suppressRuntimeContext` + `interpolate:false`；中途切换用 `startsRequestSeries` 硬替换（用户 2026-11-04 选 B）。
- **D-028**：会话选择/冻结/切换状态只从 session log 的 `prompt-lab` projection 重建；不写旁路文件、不做全局默认。
- **D-029**：`/sp` 是 preset-scoped 命令；handler 只校验与回报；文件在下一次请求读取；空文件拒绝；上限 256 KiB。
