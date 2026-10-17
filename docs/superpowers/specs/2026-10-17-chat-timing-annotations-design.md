# 2026-10-17 功能六设计：Chat 时间标注（官方槽位方案 A）

> **性质**：用户已选定「方案 A」（2026-10-17「方案A吧，方便一些」）。实现为独立 Web UI bundle `@mosire/dsh-timing-annotations`，只注册 Chat 官方 additive slots，**不替换任何宿主渲染器、不写 DOM**。
> **关系**：取代 `docs/agents/04-调研-通用基础设施补位.md` 之外的一次独立 UI 需求；不碰 DSH 源码（铁律 1）。

## 一、需求

> 「能不能让每次思考/运行命令的最右边都显示是什么时候开始的、持续了多少分钟？」→ 用户选方案 A（官方槽位折中，方便、稳定）。

DSH Chat 的官方扩展点没有「既有行右侧追加内容」的槽位：可用的只有 `conversation.chat.node`（整行替换，shadows-shipped-ui）与少数附属槽。方案 A 用两个 additive 槽实现：

1. `conversation.chat.assistant-actions`（list，`replaceRisk: none`）：每条**最终 assistant 消息**的动作区右侧显示 `开始 HH:MM · 用时 XmYYs`；
2. `conversation.chat.turnTail`（list，`replaceRisk: none`）：每个**已完成轮次**末尾右对齐显示本轮时间线：`本轮 HH:MM–HH:MM · 总耗时` + 每次思考/工具调用的 `开始 · 耗时`；
3. **运行中实时计时（2026-10-17 用户追加要求）**：前两个槽只在「完成后」渲染，无法显示运行中的计时。新增 `conversation.composer.dock` 中的 LiveTiming 组件：
   每 500ms 读取 Chat 快照里仍在运行的 `tool-call`（`root.phase` 存在，`root.time` 为开始）与 `assistant-step`（`status === 'running'`，
   开始时间取 `node.location.step.start.time`，缺失时用首次观察到的时间兜底），在对应行右侧以 `position: fixed` 渲染自己的
   `开始 HH:MM · 已用 XmYYs` 标签；只**读**行 DOM 的 `[data-chat-node-key]` 位置用于对齐，不改动宿主 DOM。行结束/隐藏即消失。

## 二、数据来源（不新增事件、不改会话日志）

- `props.useChat(snapshot => snapshot.legacy)` 取 Chat 快照兼容切片；
- assistant：`node.timing.stepStartTime` / `node.timing.completedTime`（缺失时退化 `node.time`，时长未知则不显示时长）；
- tool：`ToolResultNode.callTime`（tool/call 时间）与 `node.time`（tool/result 时间），时长 = `time - callTime`；
- 轮次边界：turnTail owner props 的 `turn.start.time` / `turn.end.time`（`TurnLocation`），用于筛选该轮的工具调用；
- 时间显示为浏览器本地时区 24 小时 `HH:MM`；时长 <60s 显示 `X.Xs`，否则 `XmYYs`（“多少分钟”语义）。

## 三、行为与边界

- assistant-actions 条目仅在消息有可确定的开始时间时渲染，否则返回 null（不占位）；
- turnTail 条目仅在该轮有思考/工具记录时渲染；超过 12 条时只显示最后 12 条并加 `+N`；
- 列表使用 `--dsw-alias-label-*` 主题 token、`font-variant-numeric: tabular-nums`，右对齐；
- locale 通过 `ctx.locale.register('timing-annotations', {zh,en})` + 注册项 `locale` 注入 `t`；文本全走 locale；
- 组件局部 `<style>` 元素随 React 渲染挂载/卸载，不写 `document.head`/`body`；
- 无 Host 行为（`index.js` 的 `apply()` 为空），bundle 仅提供 client half。

## 四、文件

| 文件 | 说明 |
|---|---|
| `packages/dsh-timing-annotations/package.json` | bundle + client half 声明（`dsh.bundle.patch`、`dsh.client{platform:web,immediately,inject:[ui-chat,ui-conversation,client-locale]}`） |
| `packages/dsh-timing-annotations/cordis.patch.yml` | insert 一行 `timing-annotations` |
| `packages/dsh-timing-annotations/index.js` | Host half：空 `apply()` |
| `packages/dsh-timing-annotations/client.js` | 两个组件 + locale 字典 + slot 注册 |
| `packages/dsh-timing-annotations/locale/{en,zh}.json` | `meta.title` / `meta.description`（插件显示元数据） |
| `packages/dsh-timing-annotations/icon.svg` | 原创时钟图标 |
| `packages/dsh-timing-annotations/README.md` | 安装与行为说明 |

## 五、验收

- `plugin_manager install_bundle` → `application: applied`；
- `cordis_inspect_query`（client `Slots.listSubTree`）两个槽的 `occupants` 均出现 `timing-annotations` / `timing-annotations-turn` 且 `active: true`；
- 视觉（**用户已确认**）：运行中的工具行右侧出现实时 `开始 HH:MM · 已用 …`（用户以 `sleep 5` 实测，22:21:30–35 看到标签并刷新）；
  完成后 assistant 动作区出现 `开始 HH:MM · 用时 …`，已完成轮次末尾出现右对齐时间线；
- 已知限制：assistant-actions 在宿主动作行中，历史轮次的动作行可能 hover 才显示（宿主行为，非本插件控制）；因此「始终可见」的信息以 turnTail 行为准。若要严格逐行常显，只能换成方案 B（DOM 叠加）或整行替换渲染器，均不在本次范围。

## 六、未验证

- 页面视觉与实际渲染需用户在刷新/热加载后确认；本机无浏览器控制能力，未截图验证。
- 深色/浅色主题、历史分页加载后的时间线准确性未单独验证。
