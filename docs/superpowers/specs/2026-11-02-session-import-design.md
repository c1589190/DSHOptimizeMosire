# 2026-11-02 · Session 日志导入（功能八）

> 入口已由用户拍板（2026-11-02）：走 **B · Host 插件命令**，`/import <路径>`，直接读盘。
> 不做客户端上传、不做 watcher、不做导入台账。设计依据是 0.2.1-rc.4 实测的导出格式与持久化写 API。

## 1. 目标与非目标

**目标**：把 DSH 自己导出的 Session 日志（ZIP 或单个 JSONL）重新变成 DSH 里一个可打开、可续聊的会话。

- 输入：`/export` 产出的 `dsh-session-*.zip`；裸 `session.v4.jsonl`；磁盘上的 `session*.jsonl.zstd`（多帧）。
- 输出：在 `ctx.sessionPersistence` 里新建会话（必要时含子会话树），会话列表可见、Chat 可渲染、`dsh headless --session-id` 可续。
- 全程走官方写 API，不拼物理文件格式，不依赖磁盘布局。

**非目标**：

- 不做浏览器上传 / 拖拽（入口是 Host 路径参数，用户已定）。
- 不做「重复导入跳过/覆盖」台账：每次导入都是新副本（id 空闲时保留原 id）。
- 不做 v0/v3 → v4 迁移：只接受当前 `SESSION_FORMAT_VERSION`（4）的日志；旧代际提示先用原 store 打开一次。
- 不做 watcher、不做远程下载、不走网络。
- 不保证字节级还原（导出本身就是解析后重序列化）。

## 2. 输入识别与解析

按**内容嗅探**，不看扩展名：

| 魔数 | 形态 | 处理 |
|---|---|---|
| `PK\x03\x04` | ZIP（export 包） | 解析中央目录，逐 entry 处理 |
| `28 b5 2f fd` | 多帧 zstd | 按 magic 切帧，逐帧 `zlib.zstdDecompressSync` |
| `{` 开头 | 明文 JSONL | 直接按行切 |

ZIP 条目约定（与 `@deepseek-ai/dsh-session-log-export` 对齐）：

- `session.v4.jsonl` → 根会话；`subagents/<id>/session.v4.jsonl` → 子会话。
- `media/<attachmentId>.<ext>` → 图片；`files/<digest 前2位>/<digest>/<name>` → 文件附件。
- 其它条目忽略并计入「跳过」列表。

每个 JSONL：首行必须是 `{type:"session", version:4, id, createdAt, ...}`；其余行是事件。任一行坏掉 → 该会话整体拒绝，不半写。

## 3. 写入路径

对每个会话（根在前，子会话按 `delegationDepth` 升序）：

1. `ctx.sessionPersistence.stat(id)` 判断 id 是否空闲；占用则 `session-${randomUUID()}` 换新 id，并记入映射表。
2. 应用映射：`header.id` / `header.parentSession`；事件数据里**恰好等于**被替换 id 的字符串（递归替换，只命中映射表里的值，避免误伤）。
3. `header.cwd`：绝对路径且本机存在 → 保留；否则回退到 `invocation.agent` 的 cwd（保证会话落在当前项目里可见）。
4. 预校验：`materializeCreateHeader(header)` + `validateStoredEvents(header, events)`；失败即停，不创建任何会话。
5. 附件先行：`ctx.attachments.saveImage({data, mediaType, name})` / `saveFile({data, name})`；附件是内容寻址，id 不变，事件里的引用无需改写。单张失败只记警告，不阻断会话导入。
6. `create(header)` → `handle.append(events)` → `flush()`；`close()` 收尾。
7. 汇总：新建会话数、根 id、改名映射、附件数、跳过条目、失败原因。

**禁止**：任何情况下都不用 `fs.writeFile` 往 `~/.dsh/sessions/` 里写；不用 `create` 覆盖既有 id。

## 4. 边界与拒绝

- `header.isSeeded === true`：导出不含 `inheritedEventCount`，v1 直接拒绝，文案说明「种子会话请从原 store 导出」。
- `header.version !== 4`：拒绝，提示先用原 store 打开触发迁移。
- 事件校验失败（未知类型非 ignorable、seq 不连续、surfaceOp 缺失）：拒绝该会话，报首个错误。
- 单文件超过 `maxBytes`（默认 512 MiB）：拒绝，提示用路径直接读取不受限。
- 同名会话已在 live 进程里：`create` 抛 `SessionAlreadyExistsError`；因为是换新 id 后的调用，正常情况下不会触发，仍按错误汇报。

## 5. 命令面

```js
{
  name: 'import',
  description: '从 Session 日志导入会话：/import <zip|jsonl|jsonl.zstd 路径>',
  input: { hint: '<路径>' },
  handler: (invocation) => runImport(invocation),
}
```

- 路径支持 `~` 展开；相对路径按 `invocation.agent.cwd` 解析；去首尾引号。
- 返回 `{kind:'success'|'error', text}`，文本形态：
  - 成功：`已导入 2 个会话，根会话 <id>（cwd: /path）；附件 3 个；跳过 1 项`
  - 改名：追加一行 `原 id -> 新 id`
- 不写 `command/run` 以外的自定义事件；不新增投影。

## 6. 装配

- 新包 `packages/dsh-session-import`（`lib/index.js` + `lib/zip.js` + `lib/zstd.js` + `lib/import.js`），`apply(ctx, config)`。
- `packages/dshom/index.js` 增加 `features.sessionImport !== false` 时 `applySessionImport(ctx, source.sessionImport ?? {})`，用 `whenReady(ctx, ['sessionPersistence'], …)`。
- 无 client half、无 `cordis.patch.yml` 改动；profile 里已 `link:` 到本仓，装后生效。
- 依赖：只用 Node 内置（`node:fs/promises`、`node:zlib`、`node:crypto`、`node:path`）；ZIP 读自己写（中央目录 + `inflateRawSync`），不引 fflate。

## 7. 已知风险

- **导入即信任**：日志中的工具输出/用户消息会成为新会话 surface 的一部分；续聊时模型会读到。导入前应确认来源。
- **列表刷新**：新会话是持久化会话，GUI 需刷新/重开页面才出现在列表；`--session-id` 与 RPC 立刻可用。
- **cwd 回退**：原 cwd 不存在时改写为当前项目，属有损但保证可见；报告里注明。
- **导出语义**：`isSeeded`、`origin` 等元数据可能与原会话不完全一致；不改写 surface。
- **大文件**：整包读进内存解析，512 MiB 上限即保护。

## 8. 验收

1. 单测：ZIP 解析（含 data descriptor 情形）、zstd 切帧、id 映射、cwd 回退、非法事件拒绝、命令语法。
2. 手工 E2E：用本会话 `/export` 的 ZIP 执行 `/import`，确认——
   - 列表出现新会话并可打开，消息顺序与原文一致；
   - 图片附件可显示；
   - `dsh headless --session-id <新id>` 能续一轮；
   - 再导一次得到第二个副本（不覆盖）。
3. 负例：喂一个手搓的坏 JSONL，报错且不产生半成品会话。
