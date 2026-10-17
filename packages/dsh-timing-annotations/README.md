# @mosire/dsh-timing-annotations

DSH Web chat 的「时间标注」UI 插件（官方槽位方案，不替换任何宿主渲染器）：

- `conversation.chat.assistant-actions`：每条最终 assistant 消息的动作区右侧显示
  `开始 HH:MM · 用时 XmYYs`（来自 Chat 快照里的 `timing.stepStartTime` / `timing.completedTime`）；
- `conversation.chat.turnTail`：每个已完成轮次末尾右对齐显示一轮时间线：
  `本轮 HH:MM–HH:MM · 总耗时` + 每次思考/工具调用的 `开始 · 耗时`。

数据全部来自 Session 派生的 Chat 快照（`useChat(s => s.legacy)`），不新增事件、不改会话日志；
样式只用 `--dsw-alias-*` 主题 token。时间无法确定时（例如窗口截断缺少 timing）不显示对应项。

## 安装

```sh
# 由 plugin_manager install_bundle 安装到 web profile
```

安装后刷新（或由 HMR 热加载）页面即可；插件本身没有 Host 行为。
