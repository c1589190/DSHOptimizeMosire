# 决策记录：移除 dshom 的客户端 half（聊天时间标注 + composer dock goal 开关）

- **日期**：2026-11-10
- **状态**：implemented（用户要求“直接把工具调用时间显示给删掉，赶紧上一个没有 bug 的版本，我要用梁神模式”）
- **取代**：功能六（D-017/D-018/D-019）与 D-024 的 composer dock 小开关部分；`/goal-confirm` 命令与提问卡片第三项不变。

## 根因（已验证）

1. **fixed 包含块劫持**：DSH 0.2.2 的 `.wSkVaW_composerSeat` 带 `will-change:transform`（`@deepseek-ai/dsh-client-ui-conversation/lib/client.js:20057`），
   按 CSS 规范成为 `position:fixed` 后代的包含块。官方 README（`README.md:109`）与槽位类型声明（`contract/slots.d.ts:344`）都明确：
   `conversation.composer.dock` 等 composer 槽里的 fixed 浮层**必须 portal 到 document.body**。
2. 旧 `packages/dshom/client.js` 的 `LiveTiming` 用视口矩形计算标签坐标，却把标签渲染在 composer dock 内 ⇒ 坐标被整体偏移
   （无头 Chromium 复现：容器 top=900 时，`top:300px` 的 fixed 标签实际落在 1200；普通容器内为 300）。
   后果：运行中时间标签被推到屏外/输入框附近，goal 菜单横向偏移。
3. 旧 `GoalConfirmSwitch` 的菜单同样是 fixed 且未 portal；且全局 `scroll` 监听会关闭菜单，流式输出时菜单一闪就没。
4. `LiveTiming` 读取 `[data-chat-flow]` / `[data-chat-node-key]` 属于宿主内部 DOM（类型与 README 均未声明契约），升级/切视图易碎。
5. 宿主动作行是 28px 高的 flex 行，`AssistantTiming` 的 `margin-left:auto` 会把 branch/clock 一并右推，窄列可能溢出。

## 决策

- **删除 `packages/dshom/client.js` 与 `dsh.client` 清单**：`@mosire/dshom` 只保留 Host half。
  - 不再注册 `conversation.chat.assistant-actions`、`conversation.chat.turnTail`、`conversation.composer.dock` 的任何条目；
  - 客户端不再有固定定位浮层，从根上消除这一类显示问题。
- **保留 Host 侧 goal 确认门**：`/goal-confirm` 命令、会话投影、提问卡片第三项继续工作；只失去 composer dock 小开关（命令等价）。
- `packages/dsh-timing-annotations/` 作为历史实现保留（不随 dshom 安装）；若将来重新启用，必须先按上面的 portal 契约重写。
- 时间标注若将来恢复，应优先采用「composer dock 内行内摘要」而不是逐行 fixed overlay（不读宿主 DOM）。

## 验证

- `@mosire/dshom` 安装后 `dsh --profile web --dump-config` 出现 `dshom` 行，且不再有 client half；
- 实时 Slot 树中 composer.dock / assistant-actions / turnTail 不再出现 `timing-annotations*` / `goal-confirm-switch`；
- 梁神预设仍可挂载（见当次安装的 status 文件与 doctor 输出）。
