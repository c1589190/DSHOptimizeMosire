import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildZip } from './helpers/zip-builder.mjs'
import { apply, COMMAND_NAME, runImport } from '../lib/index.js'

const header = (id) => ({ type: 'session', version: 4, id, createdAt: 1, cwd: '/tmp/ws', isSeeded: false })
const jsonl = (h) => Buffer.from(`${JSON.stringify(h)}\n`)

function fakePersistence() {
  const created = []
  return {
    created,
    async stat() {
      return undefined
    },
    async create(sessionHeader) {
      created.push(sessionHeader.id)
      return { async append() {}, async flush() {}, async close() {} }
    },
  }
}

test('registers the import command on a ready context', () => {
  let definition
  const ctx = {
    get: (key) => ({ commands: { register: (value) => (definition = value) }, sessionPersistence: fakePersistence() })[key],
  }
  apply(ctx)
  assert.equal(definition.name, COMMAND_NAME)
  assert.equal(definition.input.hint, '<路径>')
  assert.equal(typeof definition.handler, 'function')
})

test('defers registration until the required services exist', () => {
  const requested = []
  const ctx = {
    get: () => undefined,
    inject: (services, callback) => requested.push({ services, callback }),
  }
  apply(ctx)
  assert.deepEqual(requested[0].services, ['commands', 'sessionPersistence'])
})

test('reports usage without touching the file system', async () => {
  const result = await runImport({ rawInput: '   ', agent: { cwd: '/tmp' } }, { persistence: fakePersistence() })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /用法/u)
})

test('reports an unreadable path', async () => {
  const result = await runImport(
    { rawInput: 'missing.zip', agent: { cwd: '/tmp' } },
    { persistence: fakePersistence() },
  )
  assert.equal(result.kind, 'error')
  assert.match(result.text, /无法读取/u)
})

test('imports a zip given as a relative path and summarizes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-import-cmd-'))
  const zip = buildZip([{ name: 'session.v4.jsonl', data: jsonl(header('s1')) }])
  await writeFile(join(dir, 'one.zip'), zip)
  const persistence = fakePersistence()
  const result = await runImport(
    { rawInput: 'one.zip', agent: { cwd: dir } },
    { persistence, attachments: undefined },
  )
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已导入 1 个会话/u)
  assert.deepEqual(persistence.created, ['s1'])
})
