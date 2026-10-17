# 决策记录：Chat 时间标注（功能六）

- **日期**：2026-10-17（用户「方案A吧，方便一些」当日）
- **状态**：implemented（bundle 已安装、槽位注册 active；页面视觉待用户确认）
- **关系**：独立 UI 需求；不改变功能一~五。调研结论：DSH Chat 无「既有行右侧追加」官方槽位，只有整行替换或附着槽；用户选择**官方槽位折中**。

## 裁定

- **D-017**：采用方案 A——用两个 additive 官方槽实现，不替换 Chat 渲染器、不写 DOM：
  - `conversation.chat.assistant-actions`：每条最终 assistant 消息动作区右侧 `开始 HH:MM · 用时 XmYYs`（数据：`timing.stepStartTime`/`timing.completedTime`）；
  - `conversation.chat.turnTail`：每个已完成轮次末尾右对齐时间线，逐条列出该轮**思考**与**工具命令**的开始时间和耗时（数据：assistant timing + `ToolResultNode.callTime/time`）。
- **D-018**：DSH 自带 Trajectory 视图（每条记录的开始时间/耗时 + timing overview）保留为现成能力，不二次开发、不替代本插件。
- **D-019（2026-10-17 用户追加）**：用户要的是「工具**运行期间**就显示」，而 additive 槽（assistant-actions/turnTail）只在完成后渲染 ⇒
  追加 LiveTiming overlay：挂 `conversation.composer.dock`，500ms 轮询 Chat 快照中的 running tool-call / assistant-step，
  用 `position: fixed` 在对应行右侧渲染自己的实时 `开始 HH:MM · 已用 …` 标签；只读行 DOM 的 `[data-chat-node-key]` 做对齐，**不改宿主 DOM**。

## 实现

- 新 bundle `@mosire/dsh-timing-annotations`（`packages/dsh-timing-annotations/`），Host half 为空 `apply()`，全部在 client half；locale 走 `ctx.locale`，样式只用 `--dsw-alias-*` token，组件局部 `<style>`。
- `plugin_manager install_bundle` → `application: applied`；`Slots.listSubTree` 三个槽 occupants 见 `timing-annotations`（assistant-actions）、
  `timing-annotations-turn`（turnTail）、`timing-annotations-live`（composer.dock），均 `active: true`。

## 已知限制 / 未验证

- assistant-actions 位于宿主动作行，历史轮次可能 hover 才显示（宿主行为）；常显信息以 turnTail 为准。
- 页面视觉（深/浅色、历史分页）需用户刷新后确认；本机无浏览器控制，未截图。
- 若将来要严格「每行最右侧常显」，需要方案 B（DOM overlay）或替换 `conversation.chat.node` 渲染器，风险更高，另立条目。
