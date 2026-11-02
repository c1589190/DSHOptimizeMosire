import test from 'node:test'
import assert from 'node:assert/strict'
import { buildZip } from './helpers/zip-builder.mjs'
import { parseArchive, assignSessionIds, remapSession } from '../lib/archive.js'

const header = (id, extra = {}) => ({ type: 'session', version: 4, id, createdAt: 1, cwd: '/tmp/ws', isSeeded: false, ...extra })
const jsonl = (h, events = []) => Buffer.from([h, ...events].map((value) => JSON.stringify(value)).join('\n') + '\n')
const userMessage = (seq, text) => ({
  type: 'user/message',
  seq,
  time: 1,
  data: { content: [{ type: 'text', text }], role: 'user', id: `m${seq}` },
  surfaceOp: 'append',
})

test('parses a zip tree into root + subagent sessions with attachments', () => {
  const zip = buildZip([
    { name: 'session.v4.jsonl', data: jsonl(header('s1'), [userMessage(0, 'hi')]) },
    {
      name: 'subagents/session-child/session.v4.jsonl',
      data: jsonl(header('session-child', { parentSession: 's1', delegationDepth: 1 })),
    },
    { name: 'media/sha256:ab.png', data: Buffer.from('PNG') },
    { name: 'files/ab/abcdef/doc.txt', data: Buffer.from('hi') },
    { name: '../evil', data: Buffer.from('x') },
  ])
  const parsed = parseArchive(zip, { fallbackCwd: '/tmp/ws' })
  assert.deepEqual(parsed.sessions.map((session) => session.header.id), ['s1', 'session-child'])
  assert.equal(parsed.sessions[0].source, 'session.v4.jsonl')
  assert.deepEqual(parsed.media, [{ attachmentId: 'sha256:ab', ext: 'png', data: Buffer.from('PNG') }])
  assert.deepEqual(parsed.files, [{ digest: 'abcdef', name: 'doc.txt', data: Buffer.from('hi') }])
  assert.deepEqual(parsed.skipped, ['../evil'])
})

test('parses a bare jsonl log as one root session', () => {
  const parsed = parseArchive(jsonl(header('solo', { cwd: undefined }), [userMessage(0, 'x')]), { fallbackCwd: '/fallback' })
  assert.equal(parsed.sessions.length, 1)
  assert.equal(parsed.sessions[0].header.cwd, '/fallback')
  assert.deepEqual(parsed.media, [])
  assert.deepEqual(parsed.skipped, [])
})

test('skips archive entries outside the export layout', () => {
  const zip = buildZip([
    { name: 'session.v4.jsonl', data: jsonl(header('s1')) },
    { name: '/etc/passwd', data: Buffer.from('x') },
    { name: 'subagents/x/notes.txt', data: Buffer.from('x') },
    { name: 'other.bin', data: Buffer.from('x') },
  ])
  const parsed = parseArchive(zip)
  assert.deepEqual(parsed.skipped, ['/etc/passwd', 'subagents/x/notes.txt', 'other.bin'])
})

test('renames taken ids and keeps the parent chain', async () => {
  const zip = buildZip([
    { name: 'session.v4.jsonl', data: jsonl(header('s1')) },
    {
      name: 'subagents/c/session.v4.jsonl',
      data: jsonl(header('c', { parentSession: 's1', delegationDepth: 1 }), [
        { type: 'subagent/catalog', seq: 0, time: 1, data: { child: 'c', parent: 's1', note: 'c' } },
      ]),
    },
  ])
  const parsed = parseArchive(zip)
  const { renames } = await assignSessionIds(parsed.sessions, async (id) => id === 's1', () => 'session-new')
  assert.equal(renames.get('s1'), 'session-new')
  const child = remapSession(parsed.sessions[1], renames)
  assert.equal(child.header.parentSession, 'session-new')
  assert.deepEqual(child.events[0].data, { child: 'c', parent: 'session-new', note: 'c' })
  assert.equal(parsed.sessions[1].header.parentSession, 's1', 'input must not be mutated')
})

test('minted ids that are also taken are skipped', async () => {
  const parsed = parseArchive(jsonl(header('s1')))
  const candidates = ['taken-too', 'fresh']
  const { renames } = await assignSessionIds(
    parsed.sessions,
    async (id) => id === 's1' || id === 'taken-too',
    () => candidates.shift(),
  )
  assert.equal(renames.get('s1'), 'fresh')
})
