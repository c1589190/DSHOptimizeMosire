import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../presets/minimal-prompt-lab/prompt-lab-command.mjs'
import { initPromptLabState, sha256 } from '../lib/prompt-lab-state.js'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-lab-cmd-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function install(state) {
  let definition
  const ctx = {
    effect: (fn) => fn(),
    commands: {
      register(registered) {
        definition = registered
        return () => {}
      },
    },
    get: (service) => (service === 'sessionProjections' ? { stateOf: () => state } : undefined),
  }
  apply(ctx)
  return definition
}

function invoke(definition, rawInput, cwd) {
  return definition.handler({ rawInput, agent: { session: { header: { cwd } } } })
}

test('command metadata and registration', () => {
  assert.equal(name, 'prompt-lab-command')
  assert.deepEqual(inject, ['commands'])
  const definition = install(initPromptLabState({ cwd: '/work' }))
  assert.equal(definition.name, 'sp')
  assert.match(definition.description, /系统提示词/u)
  assert.match(definition.input.hint, /file/u)
  assert.equal(typeof definition.handler, 'function')
})

test('/sp file: validates the file and reports metadata without echoing contents', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'exp.md')
  writeFileSync(path, 'secret prompt')
  const definition = install({ ...initPromptLabState({ cwd: dir }), selection: null })

  const withCwd = invoke(definition, 'file exp.md', dir)
  assert.equal(withCwd.kind, 'success')
  assert.match(withCwd.text, new RegExp(`已选择 ${path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'))
  assert.match(withCwd.text, /13 bytes/u)
  assert.match(withCwd.text, new RegExp(sha256('secret prompt'), 'u'))
  assert.match(withCwd.text, /下一条消息生效/u)
  assert.doesNotMatch(withCwd.text, /secret prompt/u)

  const absolute = invoke(definition, `file ${path}`, '')
  assert.equal(absolute.kind, 'success')

  assert.equal(invoke(definition, 'file', dir).kind, 'error')
  const noCwd = install(initPromptLabState({ cwd: '' }))
  assert.equal(invoke(noCwd, 'file exp.md', '').kind, 'error')
  assert.equal(invoke(definition, 'file missing.md', dir).kind, 'error')
})

test('/sp text, blank, clear: metadata only', () => {
  const definition = install(initPromptLabState({ cwd: '/work' }))
  const text = invoke(definition, 'text hello world', '/work')
  assert.equal(text.kind, 'success')
  assert.match(text.text, /11 bytes/u)
  assert.match(text.text, new RegExp(sha256('hello world'), 'u'))
  assert.doesNotMatch(text.text, /hello world/u)

  assert.match(invoke(definition, 'blank', '/work').text, /单个空格/u)
  assert.match(invoke(definition, 'clear', '/work').text, /官方 persona/u)
  assert.equal(invoke(definition, 'text', '/work').kind, 'error')
  assert.equal(invoke(definition, 'show extra', '/work').kind, 'error')
})

test('/sp show: unset, pending, frozen', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'exp.md')
  writeFileSync(path, 'abc')

  const unset = install(initPromptLabState({ cwd: dir }))
  const unsetShow = invoke(unset, 'show', dir)
  assert.equal(unsetShow.kind, 'success')
  assert.match(unsetShow.text, /未设置/u)
  assert.match(unsetShow.text, /快照：无/u)

  const pending = install({
    ...initPromptLabState({ cwd: dir }),
    selection: { kind: 'file', path, seq: 4 },
  })
  const pendingShow = invoke(pending, 'show', dir)
  assert.match(pendingShow.text, /待下一条消息生效/u)
  assert.match(pendingShow.text, /文件/u)
  assert.match(pendingShow.text, new RegExp(sha256('abc'), 'u'))
  assert.match(pendingShow.text, /快照：无/u)

  const frozen = install({
    ...initPromptLabState({ cwd: dir }),
    selection: { kind: 'blank', seq: 4 },
    lastSystemText: 'frozen text',
    lastSystemSeq: 9,
  })
  const frozenShow = invoke(frozen, 'show', dir)
  assert.match(frozenShow.text, /已生效（本会话已冻结）/u)
  assert.match(frozenShow.text, /空提示词/u)
  assert.match(frozenShow.text, /快照：seq 9/u)
  assert.match(frozenShow.text, new RegExp(sha256('frozen text'), 'u'))
})

test('/sp without a projection service reports failure instead of a false success', () => {
  let definition
  apply({
    effect: (fn) => fn(),
    commands: { register: (registered) => { definition = registered; return () => {} } },
    get: () => undefined,
  })
  const file = invoke(definition, 'text hi', '/work')
  assert.equal(file.kind, 'error')
  assert.match(file.text, /状态不可用/u)
  const show = invoke(definition, 'show', '/work')
  assert.equal(show.kind, 'success')
  assert.match(show.text, /状态不可用/u)
})
