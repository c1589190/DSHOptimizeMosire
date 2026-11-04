import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BLANK_SYSTEM_PROMPT,
  COMMAND_NAME,
  DEFAULT_SYSTEM_PROMPT,
  MAX_PROMPT_BYTES,
  PROMPT_LAB_KEY,
  PROMPT_LAB_STATE_VERSION,
  USAGE,
  applyPromptLabEvent,
  initPromptLabState,
  isPromptLabState,
  isSwitchPending,
  makePromptLabProjection,
  makeSwitchGuard,
  parsePromptLabInput,
  promptLabStateSchema,
  readPromptFile,
  resolveLabPrompt,
  resolveSelection,
  resolveSelectionPath,
  sha256,
} from '../lib/prompt-lab-state.js'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-lab-state-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function tempFile(t, name, content) {
  const dir = tempDir(t)
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

test('parsePromptLabInput: selection verbs and usage errors', () => {
  assert.deepEqual(parsePromptLabInput('file exp.md'), { kind: 'file', path: 'exp.md' })
  assert.deepEqual(parsePromptLabInput('  file /tmp/a b.md  '), { kind: 'file', path: '/tmp/a b.md' })
  assert.deepEqual(parsePromptLabInput('text hello world'), { kind: 'text', text: 'hello world' })
  assert.deepEqual(parsePromptLabInput('blank'), { kind: 'blank' })
  assert.deepEqual(parsePromptLabInput('clear'), { kind: 'clear' })
  assert.deepEqual(parsePromptLabInput('show'), { kind: 'show' })
  assert.equal(parsePromptLabInput('').kind, 'error')
  assert.equal(parsePromptLabInput('').message, USAGE)
  assert.equal(parsePromptLabInput('nope').kind, 'error')
  assert.equal(parsePromptLabInput('file').kind, 'error')
  assert.equal(parsePromptLabInput('text   ').kind, 'error')
  assert.equal(parsePromptLabInput('blank extra').kind, 'error')
  assert.equal(parsePromptLabInput('clear extra').kind, 'error')
  assert.equal(parsePromptLabInput('show extra').kind, 'error')
})

test('resolveSelectionPath: absolute, relative, missing cwd', () => {
  assert.equal(resolveSelectionPath('/abs/a.md', '/work'), '/abs/a.md')
  assert.equal(resolveSelectionPath('rel/a.md', '/work'), '/work/rel/a.md')
  assert.equal(resolveSelectionPath('rel/a.md', ''), null)
  assert.equal(resolveSelectionPath('', '/work'), null)
  assert.equal(resolveSelectionPath(undefined, '/work'), null)
})

test('readPromptFile: text, BOM, empty, BOM-only, NUL, oversize, missing', (t) => {
  const path = tempFile(t, 'exp.md', 'Line A\nLine B\n')
  const file = readPromptFile(path)
  assert.equal(file.ok, true)
  assert.equal(file.text, 'Line A\nLine B\n')
  assert.equal(file.bytes, 14)
  assert.equal(file.sha256, sha256('Line A\nLine B\n'))
  assert.equal(file.fileSha256, sha256('Line A\nLine B\n'))

  const bomPath = tempFile(t, 'bom.md', '\uFEFFhello')
  const bom = readPromptFile(bomPath)
  assert.equal(bom.ok, true)
  assert.equal(bom.text, 'hello')
  assert.equal(bom.sha256, sha256('hello'))
  assert.notEqual(bom.fileSha256, bom.sha256)

  assert.equal(readPromptFile(tempFile(t, 'empty.md', '')).ok, false)
  const bomOnly = readPromptFile(tempFile(t, 'bom-only.md', '\uFEFF'))
  assert.equal(bomOnly.ok, false)
  assert.match(bomOnly.error, /BOM/u)

  const nul = readPromptFile(tempFile(t, 'nul.md', 'a\u0000b'))
  assert.equal(nul.ok, false)
  assert.match(nul.error, /NUL/u)

  const oversize = readPromptFile(tempFile(t, 'big.md', Buffer.alloc(MAX_PROMPT_BYTES + 1, 65)))
  assert.equal(oversize.ok, false)
  assert.match(oversize.error, /上限/u)

  const missing = readPromptFile(join(tempDir(t), 'missing.md'))
  assert.equal(missing.ok, false)
  assert.match(missing.error, /读不到文件/u)
})

test('resolveSelection: file, text, blank, default, relative without cwd', (t) => {
  const path = tempFile(t, 'exp.md', 'from file')
  const dir = join(path, '..')
  const file = resolveSelection({ kind: 'file', path: 'exp.md' }, dir)
  assert.equal(file.ok, true)
  assert.equal(file.text, 'from file')
  assert.equal(file.path, path)

  const noCwd = resolveSelection({ kind: 'file', path: 'exp.md' }, '')
  assert.equal(noCwd.ok, false)

  const text = resolveSelection({ kind: 'text', text: 'inline' }, '')
  assert.equal(text.ok, true)
  assert.equal(text.text, 'inline')
  assert.equal(text.sha256, sha256('inline'))

  assert.equal(resolveSelection({ kind: 'blank' }, '').text, BLANK_SYSTEM_PROMPT)
  assert.equal(resolveSelection({ kind: 'default' }, '').text, DEFAULT_SYSTEM_PROMPT)
  assert.equal(resolveSelection({ kind: 'nope' }, '').ok, false)
  assert.equal(resolveSelection(null, '').ok, false)
})

test('applyPromptLabEvent: run -> done success makes the selection effective', () => {
  let state = initPromptLabState({ cwd: '/work' })
  state = applyPromptLabEvent(state, {
    type: 'command/run',
    seq: 4,
    data: { commandId: 'c1', name: COMMAND_NAME, args: 'file exp.md' },
  })
  assert.equal(state.selection, null)
  assert.equal(state.pending.length, 1)
  assert.equal(isSwitchPending(state), false)

  state = applyPromptLabEvent(state, { type: 'command/done', seq: 5, data: { commandId: 'c1', kind: 'success' } })
  assert.equal(state.pending.length, 0)
  assert.deepEqual(state.selection, { kind: 'file', path: 'exp.md', seq: 4 })
  assert.equal(isSwitchPending(state), true)
})

test('applyPromptLabEvent: failed or mismatched done drops the pending run', () => {
  let state = initPromptLabState({ cwd: '/work' })
  state = applyPromptLabEvent(state, {
    type: 'command/run',
    seq: 4,
    data: { commandId: 'c1', name: COMMAND_NAME, args: 'file exp.md' },
  })
  state = applyPromptLabEvent(state, { type: 'command/done', seq: 5, data: { commandId: 'other', kind: 'success' } })
  assert.equal(state.pending.length, 1)
  assert.equal(state.selection, null)

  state = applyPromptLabEvent(state, { type: 'command/done', seq: 6, data: { commandId: 'c1', kind: 'error' } })
  assert.equal(state.pending.length, 0)
  assert.equal(state.selection, null)
})

test('applyPromptLabEvent: non-selection and non-sp events are ignored', () => {
  const state = initPromptLabState({ cwd: '/work' })
  assert.equal(
    applyPromptLabEvent(state, { type: 'command/run', seq: 1, data: { commandId: 'c', name: 'sp', args: 'show' } }),
    state,
  )
  assert.equal(
    applyPromptLabEvent(state, { type: 'command/run', seq: 2, data: { commandId: 'c', name: 'goal', args: 'x' } }),
    state,
  )
  assert.equal(applyPromptLabEvent(state, { type: 'user/message', seq: 3, data: {} }), state)
  assert.equal(applyPromptLabEvent(undefined, { type: 'command/run', seq: 1, data: {} }).cwd, '')
})

test('applyPromptLabEvent: system/message updates the snapshot, tombstone does not', () => {
  let state = initPromptLabState({ cwd: '/work' })
  state = applyPromptLabEvent(state, {
    type: 'system/message',
    seq: 9,
    data: { message: { role: 'system', content: [{ type: 'text', text: 'snapshot' }] } },
  })
  assert.equal(state.lastSystemText, 'snapshot')
  assert.equal(state.lastSystemSeq, 9)

  state = applyPromptLabEvent(state, {
    type: 'system/message',
    seq: 10,
    data: { message: { role: 'system', content: [] } },
  })
  assert.equal(state.lastSystemText, 'snapshot')
  assert.equal(state.lastSystemSeq, 9)

  const joined = applyPromptLabEvent(state, {
    type: 'system/message',
    seq: 11,
    data: { message: { role: 'system', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } },
  })
  assert.equal(joined.lastSystemText, 'ab')
})

test('isSwitchPending: no selection, pending switch, frozen snapshot', () => {
  assert.equal(isSwitchPending(initPromptLabState({ cwd: '/w' })), false)
  assert.equal(isSwitchPending(undefined), false)
  const pending = { ...initPromptLabState({ cwd: '/w' }), selection: { kind: 'blank', seq: 5 } }
  assert.equal(isSwitchPending(pending), true)
  assert.equal(isSwitchPending({ ...pending, lastSystemSeq: 5 }), false)
  assert.equal(isSwitchPending({ ...pending, lastSystemSeq: 6 }), false)
})

test('resolveLabPrompt: default, pending selection, frozen snapshot, broken source', (t) => {
  assert.deepEqual(resolveLabPrompt(undefined), { text: DEFAULT_SYSTEM_PROMPT, source: 'default' })
  assert.deepEqual(resolveLabPrompt(initPromptLabState({ cwd: '/w' })), { text: DEFAULT_SYSTEM_PROMPT, source: 'default' })

  const path = tempFile(t, 'exp.md', 'v1')
  const cwd = join(path, '..')
  let state = initPromptLabState({ cwd })
  state = applyPromptLabEvent(state, { type: 'command/run', seq: 1, data: { commandId: 'c', name: 'sp', args: `file ${path}` } })
  state = applyPromptLabEvent(state, { type: 'command/done', seq: 2, data: { commandId: 'c', kind: 'success' } })
  assert.deepEqual(resolveLabPrompt(state), {
    ok: true,
    text: 'v1',
    source: 'file',
    path,
    bytes: 2,
    sha256: sha256('v1'),
  })

  // Frozen snapshot: the file changes, the session keeps the snapshot.
  writeFileSync(path, 'v2')
  state = { ...state, lastSystemText: 'v1', lastSystemSeq: 3 }
  assert.deepEqual(resolveLabPrompt(state), { text: 'v1', source: 'snapshot', seq: 3 })

  // A new selection re-reads the file.
  state = applyPromptLabEvent(state, { type: 'command/run', seq: 4, data: { commandId: 'd', name: 'sp', args: `file ${path}` } })
  state = applyPromptLabEvent(state, { type: 'command/done', seq: 5, data: { commandId: 'd', kind: 'success' } })
  assert.equal(resolveLabPrompt(state).text, 'v2')

  // A broken pending source keeps the last system-message snapshot, with an error.
  const broken = { ...state, selection: { kind: 'file', path: join(cwd, 'missing.md'), seq: 6 } }
  const fallback = resolveLabPrompt(broken)
  assert.equal(fallback.text, 'v1')
  assert.equal(fallback.source, 'snapshot')
  assert.match(fallback.error, /读不到文件/u)

  // ... and with no snapshot at all falls back to the official persona.
  const noSnapshot = resolveLabPrompt({ ...initPromptLabState({ cwd }), selection: { kind: 'file', path: join(cwd, 'missing.md'), seq: 1 } })
  assert.equal(noSnapshot.text, DEFAULT_SYSTEM_PROMPT)
  assert.equal(noSnapshot.source, 'default')
  assert.match(noSnapshot.error, /读不到文件/u)

  assert.equal(resolveLabPrompt({ ...initPromptLabState({ cwd }), selection: { kind: 'text', text: 'inline', seq: 1 } }).text, 'inline')
  assert.equal(resolveLabPrompt({ ...initPromptLabState({ cwd }), selection: { kind: 'blank', seq: 1 } }).text, BLANK_SYSTEM_PROMPT)
})

test('promptLabStateSchema: parse accepts valid state and rejects garbage', () => {
  assert.equal(isPromptLabState(initPromptLabState({ cwd: '/w' })), true)
  assert.equal(isPromptLabState(null), false)
  assert.equal(isPromptLabState({}), false)
  assert.equal(isPromptLabState({ ...initPromptLabState({ cwd: '/w' }), selection: { kind: 'nope', seq: 1 } }), false)
  assert.equal(isPromptLabState({ ...initPromptLabState({ cwd: '/w' }), pending: [{ commandId: '', selection: {} }] }), false)
  assert.deepEqual(promptLabStateSchema.parse(initPromptLabState({ cwd: '/w' })).cwd, '/w')
  assert.throws(() => promptLabStateSchema.parse({}), TypeError)
  assert.equal(promptLabStateSchema.safeParse({}).success, false)
})

test('makePromptLabProjection: key, version, init, apply', () => {
  const projection = makePromptLabProjection()
  assert.equal(projection.key, PROMPT_LAB_KEY)
  assert.equal(projection.stateVersion, PROMPT_LAB_STATE_VERSION)
  const state = projection.init({ cwd: '/work' })
  assert.equal(state.cwd, '/work')
  const next = projection.apply(state, {
    type: 'command/run',
    seq: 1,
    data: { commandId: 'c', name: 'sp', args: 'blank' },
  })
  assert.equal(next.pending.length, 1)
})

test('makeSwitchGuard: only a pending switch on an enter decision forces a series', async () => {
  const enter = { kind: 'enter', messages: [] }
  const reject = { kind: 'reject' }
  const pending = { ...initPromptLabState({ cwd: '/w' }), selection: { kind: 'blank', seq: 5 } }
  const frozen = { ...pending, lastSystemSeq: 5 }

  const guard = makeSwitchGuard(() => pending)
  assert.deepEqual(await guard({}, async () => enter), { kind: 'enter', messages: [], startsRequestSeries: true })
  assert.deepEqual(await guard({}, async () => reject), reject)

  const idle = makeSwitchGuard(() => frozen)
  assert.deepEqual(await idle({}, async () => enter), enter)

  const throwing = makeSwitchGuard(() => { throw new Error('no projection') })
  assert.deepEqual(await throwing({}, async () => enter), enter)

  const noAgent = makeSwitchGuard((agent) => (agent === undefined ? undefined : pending))
  assert.deepEqual(await noAgent({}, async () => enter), enter)
})
