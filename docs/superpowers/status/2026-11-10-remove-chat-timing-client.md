# 2026-11-10 移除 dshom 客户端 half（Chat 时间标注 + composer dock goal 开关）

## 触发

用户 2026-11-10：「直接把工具调用时间显示给删掉得了。当务之急是赶紧改一个没有 bug 的插件版本上来，我要用梁神模式。」

此前排查结论：`packages/dshom/client.js` 的 `LiveTiming` 与 goal-confirm 菜单都是 `position: fixed`，但渲染在
`conversation.composer.dock`（composerSeat）内部；DSH 0.2.2 的 `.wSkVaW_composerSeat` 带 `will-change:transform`，
是 fixed 后代的包含块。官方 `@deepseek-ai/dsh-client-ui-conversation` README/槽位契约明确要求这些 composer 槽里的
fixed 浮层必须 portal 到 document.body。旧实现没有 portal，坐标被容器原点劫持：运行中时间标签被推到屏外/输入框附近，
goal 菜单横向偏移；另有每行一个 `<style>`、跨插件读 `[data-chat-flow]`/`[data-chat-node-key]`、开关无条件渲染等问题。

## 改动

- 删除 `packages/dshom/client.js`。
- `packages/dshom/package.json`：删除 `./client` 导出、`files` 里的 `client.js`、整个 `dsh.client` 清单；描述改为 Host bundle。
- `packages/dshom/README.md`、`locale/{en,zh}.json`：去掉聊天时间标注与 composer dock 开关的描述，写明 Host-only。
- 新增决策记录 `.agents/notes/implemented/2026-11-10-remove-chat-timing-client.md`（含根因与无头 Chromium 复现）。
- `/goal-confirm` 命令、会话 projection `goal-confirm`、提问卡片第三项保留；仅 composer dock 小开关随 client half 移除。

## 安装与验证

- `plugin_manager set_bundle @mosire/dshom enabled=true` → `application: applied`，无 warnings；Host tools 立即出现在工具面
  （`job_wait`/`job_read`/`session_*`/`prompt_lab_*`）。
- `dsh --profile web --dump-config` 出现 `- id: dshom / name: '@mosire/dshom'`；profile `dsh.profile.bundles` 含 `@mosire/dshom`。
- 实时 Slot 树：`conversation.composer.dock` 只有 `activity`/`usage`，`assistant-actions` 只有宿主/第三方条目，
  不再出现 `timing-annotations*` / `goal-confirm-switch`。
- `node tools/doctor.mjs`：OK；peer farm `synced=true`、anchor 指向运行中的 DSH 0.2.2、仅可选
  `@deepseek-ai/dsh-workflow-worker-thread` 缺失（自动禁用）。
- 真实 3099 `runProfile` E2E（`liangshen`）：12/12 checks —— 全部预设 `broken:null`；`session-051e8ff7…` 首请求
  `["bash","str_replace_editor"]`、零自动注入、minimal persona 正确；首次晋升后 80 工具、`list_agents` 恰好一次；
  压缩重锚 skipped（会话未触发 compaction）。
  证据 `.superpowers/sdd/2026-11-10-remove-timing-ui/evidence/verify-presets.json` 与 `verify-presets-events.jsonl`。

## 未验证 / 注意

- 压缩后重锚本轮未触发（需真实 `/compact`）。
- 验证用的 3099 进程会覆盖 `~/.dsh/*-status.json` 的 `pid` 字段（诊断文件，不影响运行）；当前 3080 Host 仍为 pid 13407。
- 验证在真实 profile 里创建了一个临时 liangshen 会话（`session-051e8ff7…`，cwd 在 /tmp），可忽略或删除。
- 旧 `packages/dsh-timing-annotations/` 作为历史实现保留，未随 dshom 安装；若将来重启该 UI，必须先按 portal 契约重写。
