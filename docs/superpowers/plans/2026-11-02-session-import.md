# Session 日志导入（功能八）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 dshom 增加 `/import <路径>`：把 DSH 导出的 Session 日志（ZIP / JSONL / 多帧 zstd）经官方持久化写 API 变成可打开、可续聊的会话。

**Architecture:** 新包 `packages/dsh-session-import`，四层：ZIP 读取（无依赖）→ 日志解码与解析 → id 分配/重映射 → `ctx.sessionPersistence.create/append/flush` 写入 + `ctx.attachments` 附件回填。命令注册沿用 `dsh-goal-confirm` 的 `commands.register` 形态，由 `packages/dshom/index.js` 按特性开关组合。

**Tech Stack:** Node 22（`node:fs/promises`、`node:zlib`、`node:crypto`、`node:path`）、`node:test`；零第三方依赖。

**Spec:** `docs/superpowers/specs/2026-11-02-session-import-design.md`

## Global Constraints

- 只走官方 API：`ctx.sessionPersistence.create(header, options) → SessionHandle.append(events) → flush()`；禁止写 `~/.dsh/sessions/` 文件。
- 只接受 `version === 4` 的日志；`isSeeded === true` 的日志拒绝（导出不含 `inheritedEventCount`）。
- 不新增 HTTP 路由、不改 client half、不改 `cordis.patch.yml`。
- 用户可见文案用中文；标识符与错误信息用英文。
- 零第三方依赖。
- 每步提交前跑 `node --test packages/dsh-session-import/test/*.test.mjs`；提交由用户批准，未批准则停在「测试通过」。

## Review Focus

1. `isSeeded: true` 或 `version !== 4` 的日志 → 明确拒绝、零会话落库。
2. ZIP 条目路径穿越（`../`、绝对路径）→ 忽略并计入 skipped，绝不按路径落盘。
3. 同一 ZIP 连续导入两次 → 第二份全部换新 id，第一份内容与 id 不变。
4. 事件行损坏（截断/非法 JSON/未知类型）→ 该会话整体拒绝，报告里给首个错误与已成功的会话。
5. 超过 `maxBytes` 的压缩包 → 在解析前拒绝，内存不爆。

---

### Task 1: ZIP 读取（`lib/zip.js`）

**Files:**
- Create: `packages/dsh-session-import/lib/zip.js`
- Test: `packages/dsh-session-import/test/zip.test.mjs`
- Create: `packages/dsh-session-import/package.json`

**Interfaces:**
- Produces: `isZip(buffer: Buffer): boolean`、`readZipEntries(buffer: Buffer): Map<string, Buffer>`（entry 名 → 解压后字节；抛 `ZipError`）。

- [ ] **Step 1: 写失败测试**

```js
// test/zip.test.mjs — 手工构造最小 ZIP（method 0 与 method 8）
import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { isZip, readZipEntries, ZipError } from '../lib/zip.js'
import { buildZip } from './helpers/zip-builder.mjs'

test('reads stored and deflated entries', () => {
  const zip = buildZip([
    { name: 'session.v4.jsonl', data: Buffer.from('{"type":"session"}\n'), method: 0 },
    { name: 'media/sha256:ab.png', data: Buffer.from('PNG'), method: 8 },
  ])
  assert.equal(isZip(zip), true)
  const entries = readZipEntries(zip)
  assert.equal(entries.get('session.v4.jsonl').toString(), '{"type":"session"}\n')
  assert.equal(entries.get('media/sha256:ab.png').toString(), 'PNG')
})

test('rejects encrypted and zip64 entries', () => { /* flag bit 0 / sizes 0xffffffff → ZipError */ })
test('rejects trailing garbage and truncated archives', () => { /* → ZipError */ })
```

- [ ] **Step 2: 跑测试确认失败** — `node --test packages/dsh-session-import/test/zip.test.mjs`；期望 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现 `lib/zip.js`**

`readZipEntries` 从文件尾向前找 EOCD 签名 `0x06054b50`（最多回溯 65 557 B），读中央目录项（签名 `0x02014b50`），每个 entry 记录：`method`（0/8）、`compressedSize`、`uncompressedSize`、`localHeaderOffset`、`flags`。数据起点 = local header 的 30 字节 + local nameLen + local extraLen；method 8 用 `inflateRawSync`。拒绝：`flags & 1`（加密）、任一 size 为 `0xffffffff`（zip64）、method 非 0/8。总解压字节上限 1 GiB（防 zip bomb）。

- [ ] **Step 4: 跑测试确认通过** — 同上命令，全部 pass。

- [ ] **Step 5: 提交** — `git add packages/dsh-session-import && git commit -m "feat(session-import): dependency-free zip reader"`（用户批准后）。

---

### Task 2: 日志解码（`lib/decode.js`）

**Files:**
- Create: `packages/dsh-session-import/lib/decode.js`
- Test: `packages/dsh-session-import/test/decode.test.mjs`

**Interfaces:**
- Produces: `sniffLog(buffer): 'zip'|'zstd'|'jsonl'`；`decodeZstdFrames(buffer): Buffer`；`parseSessionLog(text, location?): { header, events }`。

- [ ] **Step 1: 写失败测试**

```js
test('sniffs zip, zstd and jsonl by magic', () => { /* PK\x03\x04 / 28 b5 2f fd / '{' */ })

test('decodes concatenated zstd frames', () => {
  const a = zstdCompressSync(Buffer.from('{"type":"session","version":4,"id":"s1"}\n'))
  const b = zstdCompressSync(Buffer.from('{"type":"user/message","seq":0}\n'))
  assert.equal(decodeZstdFrames(Buffer.concat([a, b])).toString(),
    '{"type":"session","version":4,"id":"s1"}\n{"type":"user/message","seq":0}\n')
})

test('rejects version 3 and non-session first line', () => { /* → DecodeError */ })
```

- [ ] **Step 2: 跑测试确认失败**。

- [ ] **Step 3: 实现 `lib/decode.js`**

- `decodeZstdFrames`：扫 magic `28 b5 2f fd` 得候选边界；逐段 `zstdDecompressSync`；某段失败就把边界延到下一个 magic 重试（数据里出现伪 magic 的兜底）；全失败抛 `DecodeError`。
- `parseSessionLog`：按 `\n` 切行、去空行；首行 `JSON.parse` 后要求 `type === 'session'`、`version === 4`、`id`/`createdAt` 合法；其余行 `JSON.parse` 成事件，任一失败抛 `DecodeError` 带行号。

- [ ] **Step 4: 跑测试确认通过**。

- [ ] **Step 5: 提交** — `git commit -m "feat(session-import): sniff and decode session logs"`。

---

### Task 3: 归档解析与 id 分配（`lib/archive.js`）

**Files:**
- Create: `packages/dsh-session-import/lib/archive.js`
- Test: `packages/dsh-session-import/test/archive.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `readZipEntries`、Task 2 的 `parseSessionLog`。
- Produces:
  - `parseArchive(buffer, { fallbackCwd }): { sessions, media, files, skipped }`
    - `sessions: Array<{ header, events, source }>`（根在前，按 `delegationDepth` 升序）
    - `media: Array<{ attachmentId, ext, data }>`、`files: Array<{ digest, name, data }>`、`skipped: string[]`
  - `assignSessionIds(sessions, isTaken: (id) => Promise<boolean>, mintId?): Promise<{ sessions, renames: Map<string,string> }>`
  - `remapSession(session, renames): session`（纯函数，深拷贝后改 `header.id`/`parentSession` 与事件里**恰好等于**被改 id 的字符串）

- [ ] **Step 1: 写失败测试**

```js
test('parses a zip tree into root + subagent sessions with attachments', () => {
  const zip = buildZip([
    { name: 'session.v4.jsonl', data: jsonl(rootHeader, rootEvents) },
    { name: 'subagents/session-child/session.v4.jsonl', data: jsonl(childHeader, []) },
    { name: 'media/sha256:ab.png', data: Buffer.from('PNG') },
    { name: 'files/ab/abcdef/doc.txt', data: Buffer.from('hi') },
    { name: '../evil', data: Buffer.from('x') },
  ])
  const parsed = parseArchive(zip, { fallbackCwd: '/tmp/ws' })
  assert.deepEqual(parsed.sessions.map(s => s.header.id), ['s1', 'session-child'])
  assert.equal(parsed.media[0].attachmentId, 'sha256:ab')
  assert.deepEqual(parsed.skipped, ['../evil'])
})

test('renames taken ids and keeps the parent chain', async () => {
  const { sessions, renames } = await assignSessionIds(parsed.sessions, async id => id === 's1')
  assert.equal(renames.get('s1'), 'session-<uuid>')       // mintId 注入固定值
  assert.equal(remapSession(parsed.sessions[1], renames).header.parentSession, 'session-<uuid>')
})
```

- [ ] **Step 2: 跑测试确认失败**。

- [ ] **Step 3: 实现**

- ZIP 模式：只认 `session.v4.jsonl` 与 `subagents/<seg>/session.v4.jsonl`；`media/<id>.<ext>` 拆 `attachmentId`（`sha256:<hex>`）与 ext；`files/<2>/<digest>/<name>`；条目名含 `..`、以 `/` 开头、或不在上述三类 → 进 `skipped`。
- 裸日志模式：整份当一个根会话，`media`/`files` 为空。
- `assignSessionIds`：依次 `await isTaken(id)`，占用则 `mintId()`（默认 `` `session-${randomUUID()}` ``）并写入 `renames`。
- `remapSession`：`structuredClone` 后改 header；再递归遍历事件 JSON，字符串全等映射值则替换。

- [ ] **Step 4: 跑测试确认通过**。

- [ ] **Step 5: 提交** — `git commit -m "feat(session-import): parse archives and remap session ids"`。

---

### Task 4: 导入器与命令（`lib/import.js`、`lib/index.js`）

**Files:**
- Create: `packages/dsh-session-import/lib/import.js`
- Create: `packages/dsh-session-import/lib/index.js`
- Test: `packages/dsh-session-import/test/import.test.mjs`

**Interfaces:**
- Consumes: Task 3 的 `parseArchive` / `assignSessionIds` / `remapSession`。
- Produces:
  - `importArchive({ buffer, persistence, attachments, fallbackCwd, maxBytes, signal }): Promise<Report>`
  - `apply(ctx, config): void`，注册 `/import`；`COMMAND_NAME = 'import'`
  - `runImport(invocation, deps): Promise<{ kind, text }>`

- [ ] **Step 1: 写失败测试**

```js
test('creates, appends and flushes one session per archive entry', async () => {
  const persistence = fakePersistence({ taken: [] })   // stat/create/append/flush 记录调用
  const report = await importArchive({ buffer: zip, persistence, attachments: fakeAttachments(), fallbackCwd: '/tmp/ws' })
  assert.equal(report.sessions.length, 1)
  assert.deepEqual(persistence.calls.map(c => c.kind), ['stat', 'create', 'append', 'flush', 'close'])
})

test('rejects isSeeded logs before creating anything', async () => {
  const persistence = fakePersistence()
  await assert.rejects(importArchive({ buffer: seededZip, persistence, ... }), /isSeeded/)
  assert.equal(persistence.calls.length, 0)
})

test('attachments are saved before the session is created', async () => {
  const order = []
  // saveImage pushes 'attachment'; create pushes 'create'
  assert.deepEqual(order, ['attachment', 'create'])
})

test('large buffers are rejected before parsing', async () => {
  await assert.rejects(importArchive({ buffer: Buffer.alloc(10), maxBytes: 5, ... }), /too large/)
})
```

- [ ] **Step 2: 跑测试确认失败**。

- [ ] **Step 3: 实现 `importArchive`**

顺序：`buffer.length > maxBytes` → 拒绝；`parseArchive`；`assignSessionIds`；逐会话 `validateStoredEvents(remapSession(...))`（校验失败整批拒绝，零写入）；附件 `saveImage`/`saveFile`（失败只记 `attachmentErrors`）；逐会话 `create(header)` → `append(events)` → `flush()` → `close()`（`try/finally`）。`fallbackCwd` 用于 `header.cwd` 缺失或本机不存在时。`flush` 失败时报告已成功部分与失败项。

- [ ] **Step 4: 实现 `lib/index.js` 的命令**

```js
{
  name: 'import',
  description: '从 Session 日志导入会话：/import <zip|jsonl|jsonl.zstd 路径>',
  input: { hint: '<路径>' },
  handler: (inv) => runImport(inv, deps),
}
```

`apply` 用 `whenReady` 等 `commands`、`sessionPersistence`（附件服务可选）。`runImport`：取 `inv.rawInput.trim()` 去引号、`~` 展开、相对路径按 `inv.agent.cwd ?? process.cwd()`；无参数返回 `{kind:'error', text:'用法：/import <路径>'}`；`readFile` 失败返回错误文本；成功文本：

```
已导入 2 个会话，根会话 session-xxx（cwd: /path）；附件 3 个；跳过 1 项
原 session-a -> session-b
```

- [ ] **Step 5: 跑测试确认通过** — `node --test packages/dsh-session-import/test/*.test.mjs`。

- [ ] **Step 6: 提交** — `git commit -m "feat(session-import): import archives through the session persistence service"`。

---

### Task 5: dshom 组合与文档

**Files:**
- Modify: `packages/dshom/index.js`
- Modify: `packages/dshom/README.md`
- Create: `packages/dsh-session-import/README.md`、`packages/dsh-session-import/package.json`（若 Task 1 未建）

**Interfaces:**
- Consumes: Task 4 的 `apply(ctx, config)`。
- Produces: `features.sessionImport: false` 可关；默认开。

- [ ] **Step 1: 改 `packages/dshom/index.js`**

```js
import { apply as applySessionImport } from '../dsh-session-import/lib/index.js'
// apply() 内：
if (features.sessionImport !== false) {
  whenReady(ctx, ['sessionPersistence'], (ready) => applySessionImport(ready, source.sessionImport ?? {}))
}
```

- [ ] **Step 2: 验证组合不炸**

Run: `node -e "import('./packages/dshom/index.js').then(m => m.apply({get:()=>undefined, inject:(_s,f)=>f({get:()=>undefined})}, {}))"`
Expected: 退出码 0（无命令服务时静默跳过）。

- [ ] **Step 3: 文档**

`packages/dsh-session-import/README.md`：用法、支持的三种输入、id/cwd 策略、`isSeeded` 限制、失败语义。`packages/dshom/README.md` 表格加一行「Session 日志导入 | `../dsh-session-import/lib/index.js` | 开」。

- [ ] **Step 4: 全量单测**

Run: `node --test packages/*/test/*.test.mjs`
Expected: 全部 pass，0 fail。

- [ ] **Step 5: 提交** — `git commit -m "feat(dshom): compose session import into the bundle"`。

---

### Task 6: 真实存储 E2E 与状态留痕

**Files:**
- Create: `docs/superpowers/status/2026-11-02-session-import.md`
- Test: 手工（真实 DSH 进程）

- [ ] **Step 1: 生成一份真实日志**

在任意会话执行 `/export`，或从 `~/.dsh/sessions/.../session.v4.jsonl.zstd` 解码（多帧切分）后存 `/tmp/import-e2e/session.v4.jsonl`。

- [ ] **Step 2: 重新加载 Host**

重启 3080 Host 使新 Host 代码生效；`node tools/doctor.mjs` 确认 bundle 仍为 `broken:null`。

- [ ] **Step 3: 在 Web 会话里执行**

`/import /tmp/import-e2e/session.v4.jsonl`。期望文本：`已导入 1 个会话，根会话 <id>（cwd: …）`。

- [ ] **Step 4: 验证四条判据**

- 列表出现新会话（必要时刷新页面），可打开，消息顺序与原文一致；
- 若原日志含图片，图片可显示；
- `dsh headless --session-id <新id> --prompt "hi"` 能续一轮；
- 再执行一次 `/import` 同一文件 → 第二个副本，id 不同。

- [ ] **Step 5: 负例**

`/import /tmp/import-e2e/broken.jsonl`（手工截断一行）→ 报错文本含行号，无半成品会话。

- [ ] **Step 6: 写状态文档并提交**

`docs/superpowers/status/2026-11-02-session-import.md`：改了什么、验证到哪层、未验证项（Windows、超大 ZIP、真实 GUI 刷新行为）。提交 `docs/superpowers/status/` 与新包。
