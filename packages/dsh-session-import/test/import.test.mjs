import test from 'node:test'
import assert from 'node:assert/strict'
import { buildZip } from './helpers/zip-builder.mjs'
import { importArchive } from '../lib/import.js'

const header = (id, extra = {}) => ({ type: 'session', version: 4, id, createdAt: 1, cwd: '/tmp/ws', isSeeded: false, ...extra })
const jsonl = (h, events = []) => Buffer.from([h, ...events].map((value) => JSON.stringify(value)).join('\n') + '\n')
const userMessage = (seq, text) => ({
  type: 'user/message',
  seq,
  time: 1,
  data: { content: [{ type: 'text', text }], role: 'user', id: `m${seq}` },
  surfaceOp: 'append',
})

function fakePersistence({ taken = [], appendError } = {}) {
  const calls = []
  return {
    calls,
    async stat(id) {
      calls.push({ kind: 'stat', id })
      return taken.includes(id) ? { id } : undefined
    },
    async create(created) {
      calls.push({ kind: 'create', id: created.id, header: created })
      return {
        id: created.id,
        async append(events) {
          calls.push({ kind: 'append', id: created.id, events })
          if (appendError !== undefined) throw appendError
        },
        async flush() {
          calls.push({ kind: 'flush', id: created.id })
        },
        async close() {
          calls.push({ kind: 'close', id: created.id })
        },
      }
    },
  }
}

function fakeAttachments(order) {
  return {
    async saveImage(input) {
      order.push('image')
      return { attachmentId: 'sha256:x', mediaType: input.mediaType, bytes: input.data.length }
    },
    async saveFile(input) {
      order.push('file')
      return { attachmentId: 'sha256:y', name: input.name, bytes: input.data.length }
    },
  }
}

test('creates, appends and flushes one session per archive entry', async () => {
  const persistence = fakePersistence()
  const buffer = buildZip([{ name: 'session.v4.jsonl', data: jsonl(header('s1'), [userMessage(0, 'hi')]) }])
  const report = await importArchive({ buffer, persistence, attachments: fakeAttachments([]), fallbackCwd: '/tmp/ws' })
  assert.equal(report.sessions.length, 1)
  assert.equal(report.sessions[0].id, 's1')
  assert.deepEqual(persistence.calls.map((call) => call.kind), ['stat', 'create', 'append', 'flush', 'close'])
  const created = persistence.calls.find((call) => call.kind === 'create')
  assert.equal(created.header.type, undefined, 'the logical header has no type field')
  assert.equal(created.header.delegationDepth, 0)
})

test('rejects isSeeded logs before creating anything', async () => {
  const persistence = fakePersistence()
  const buffer = buildZip([{ name: 'session.v4.jsonl', data: jsonl(header('seeded', { isSeeded: true })) }])
  await assert.rejects(
    importArchive({ buffer, persistence, attachments: fakeAttachments([]) }),
    /isSeeded/u,
  )
  assert.equal(persistence.calls.length, 0)
})

test('attachments are saved before the session is created', async () => {
  const order = []
  const persistence = fakePersistence()
  const create = persistence.create.bind(persistence)
  persistence.create = async (created) => {
    order.push('create')
    return create(created)
  }
  const buffer = buildZip([
    { name: 'session.v4.jsonl', data: jsonl(header('s1')) },
    { name: 'media/sha256:ab.png', data: Buffer.from('PNG') },
    { name: 'files/ab/abcdef/doc.txt', data: Buffer.from('hi') },
  ])
  await importArchive({ buffer, persistence, attachments: fakeAttachments(order) })
  assert.deepEqual(order, ['image', 'file', 'create'])
})

test('large buffers are rejected before parsing', async () => {
  const persistence = fakePersistence()
  await assert.rejects(
    importArchive({ buffer: Buffer.alloc(10), persistence, attachments: fakeAttachments([]), maxBytes: 5 }),
    /too large/u,
  )
  assert.equal(persistence.calls.length, 0)
})

test('invalid event sequences reject the batch before any write', async () => {
  const persistence = fakePersistence()
  const buffer = buildZip([
    {
      name: 'session.v4.jsonl',
      data: jsonl(header('s1'), [{ type: 'turn/start', seq: 5, time: 1, data: { turn: 1 } }]),
    },
  ])
  await assert.rejects(
    importArchive({ buffer, persistence, attachments: fakeAttachments([]) }),
    /seq/u,
  )
  assert.equal(persistence.calls.filter((call) => call.kind === 'create').length, 0)
})

test('an append failure is reported and the handle is still closed', async () => {
  const persistence = fakePersistence({ appendError: new Error('disk full') })
  const buffer = buildZip([{ name: 'session.v4.jsonl', data: jsonl(header('s1')) }])
  const report = await importArchive({ buffer, persistence, attachments: fakeAttachments([]) })
  assert.equal(report.sessions.length, 0)
  assert.equal(report.failures.length, 1)
  assert.match(report.failures[0].error, /disk full/u)
  assert.ok(persistence.calls.some((call) => call.kind === 'close'))
})

test('taken ids are renamed and the parent chain follows', async () => {
  const persistence = fakePersistence({ taken: ['s1'] })
  const buffer = buildZip([
    { name: 'session.v4.jsonl', data: jsonl(header('s1')) },
    {
      name: 'subagents/c/session.v4.jsonl',
      data: jsonl(header('c', { parentSession: 's1', delegationDepth: 1 })),
    },
  ])
  const report = await importArchive({
    buffer,
    persistence,
    attachments: fakeAttachments([]),
    mintId: () => 'session-fixed',
  })
  assert.deepEqual(report.sessions.map((session) => session.id), ['session-fixed', 'c'])
  assert.equal(report.sessions[0].previousId, 's1')
  const childCreate = persistence.calls.find((call) => call.kind === 'create' && call.id === 'c')
  assert.equal(childCreate.header.parentSession, 'session-fixed')
})

test('skipped archive entries are reported', async () => {
  const buffer = buildZip([
    { name: 'session.v4.jsonl', data: jsonl(header('s1')) },
    { name: 'other.bin', data: Buffer.from('x') },
  ])
  const report = await importArchive({ buffer, persistence: fakePersistence(), attachments: fakeAttachments([]) })
  assert.deepEqual(report.skipped, ['other.bin'])
})
