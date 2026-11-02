# @mosire/dsh-session-import

用 `/import <路径>` 把一份导出的 Session 日志重新导入当前 DSH：会话出现在会话列表里，可打开、可续聊。

它是 `@mosire/dshom` 的一个特性（`features.sessionImport`，默认开），只使用官方
`ctx.commands` 与 `ctx.sessionPersistence.create/append/flush`，不改 DSH 源码、不新增 HTTP 路由、
不碰 Chat 客户端。

## 用法

```
/import /path/to/dsh-session-<id>.zip
/import /path/to/session.v4.jsonl
/import /path/to/session.v4.jsonl.zstd
```

- 路径由 **Host** 读取（不是浏览器上传）；相对路径按当前 Agent 的 cwd 解析，支持 `~` 与引号。
- ZIP 就是「更多操作 → 下载 Session 日志」产出的整棵树：根会话 + `subagents/<id>/` 子会话 + `media/`、`files/` 附件。
- 裸 `.jsonl` / 多帧 `.jsonl.zstd` 当作**单个根会话**导入，无附件。
- 同一文件重复导入会得到 id 不同的第二个副本，不覆盖已有会话。

成功时返回：

```
已导入 2 个会话，根会话 session-xxx（cwd: /path/to/ws）；附件 3 个；跳过 1 项
原 session-a -> session-abc
```

## 语义

- **只收 v4 日志**；v0/v3 先在原 DSH 里打开一次完成迁移，再导出。
- **`isSeeded: true` 的会话拒绝导入**（它依赖继承事件的计数，跨实例没有意义）。
- **id 冲突换新 id**：目标存储里已存在同名 id 时，用 `session-<uuid>` 替换，并同步改
  `header.parentSession` 与事件里恰好等于旧 id 的字符串（子 Agent 树保持连在一起）。
- **cwd**：沿用日志里的 `header.cwd`；缺失时回退到当前 Agent 的 cwd。
- **附件**：按内容寻址 id（`sha256:<hex>`）先写附件库，失败只报告、不阻塞会话；已存在的附件天然幂等。
- **整批预检**：解析、id 分配、事件校验全部通过后才写第一个会话；校验失败零写入。
- **失败语义**：单会话 `create/append/flush` 失败记入报告并继续后续会话；已写入的会话保留，不会回滚。

## 支持的事件校验

导入器按 v4 契约做本地校验（官方 `validateStoredEvents` 未导出，不能 import）：

- `seq` 必须从 0 连续；
- surface 事件（`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result`）
  必须带 `surfaceOp`，非 surface 事件不得带；
- `assistant/message` 不得带 `sourceEventSeqs`；
- 其它结构由持久化后端在 `append` 时兜底。

## 配置

```yaml
- id: dshom
  name: '@mosire/dshom'
  config:
    features:
      sessionImport: true
    sessionImport:
      maxBytes: 1073741824   # 默认 1 GiB
```

## 限制（未验证）

- Windows 路径与盘符未实测；
- 超过 1 GiB 的 ZIP 直接拒绝（先解压/裁剪再导）；
- 导入的会话在 Web 端需要刷新页面才会出现在列表里（Host 侧已经可打开）。

## 测试

```
node --test packages/dsh-session-import/test/*.test.mjs
```
