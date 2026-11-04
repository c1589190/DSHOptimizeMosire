import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../presets/minimal-prompt-lab/prompt-lab-persona.mjs'
import { DEFAULT_SYSTEM_PROMPT, initPromptLabState } from '../lib/prompt-lab-state.js'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-lab-persona-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function install(state, options = {}) {
  const warnings = []
  let section
  let suppressed = false
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    systemPrompt: {
      section(value) {
        section = value
        return () => {}
      },
      getSectionOrder: (sectionName) => (sectionName === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : NaN),
      suppressRuntimeContext() {
        suppressed = true
        return () => {}
      },
    },
    get: (service) => {
      if (service !== 'sessionProjections' || options.noRegistry) return undefined
      return {
        stateOf: () => {
          if (options.throws) throw new Error('registry exploded')
          return state
        },
      }
    },
  }
  apply(ctx)
  return { section, suppressed, warnings }
}

test('persona metadata and section shape', () => {
  assert.equal(name, 'prompt-lab-persona')
  assert.deepEqual(inject, ['systemPrompt'])
  const { section, suppressed } = install(initPromptLabState({ cwd: '/work' }))
  assert.equal(section.name, 'deployment:persona-prefix')
  assert.equal(section.order, 0)
  assert.equal(section.complete, true)
  assert.equal(section.interpolate, false)
  assert.equal(typeof section.text, 'function')
  assert.equal(suppressed, true)
})

test('provider: default line without an agent or a registry', () => {
  const { section } = install(initPromptLabState({ cwd: '/work' }))
  assert.equal(section.text({}), DEFAULT_SYSTEM_PROMPT)
  assert.equal(section.text({ agent: { session: {} } }), DEFAULT_SYSTEM_PROMPT)
  assert.equal(section.text(undefined), DEFAULT_SYSTEM_PROMPT)

  const noRegistry = install(initPromptLabState({ cwd: '/work' }), { noRegistry: true })
  assert.equal(noRegistry.section.text({ agent: { session: {} } }), DEFAULT_SYSTEM_PROMPT)
})

test('provider: pending selection reads the file, frozen snapshot replays', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'exp.md')
  writeFileSync(path, 'file prompt')

  const pending = install({
    ...initPromptLabState({ cwd: dir }),
    selection: { kind: 'file', path, seq: 4 },
  })
  assert.equal(pending.section.text({ agent: { session: {} } }), 'file prompt')

  const frozen = install({
    ...initPromptLabState({ cwd: dir }),
    selection: { kind: 'file', path, seq: 4 },
    lastSystemText: 'snapshot prompt',
    lastSystemSeq: 9,
  })
  assert.equal(frozen.section.text({ agent: { session: {} } }), 'snapshot prompt')
})

test('provider: a broken pending file falls back and warns once', (t) => {
  const dir = tempDir(t)
  const missing = join(dir, 'missing.md')
  const { section, warnings } = install({
    ...initPromptLabState({ cwd: dir }),
    selection: { kind: 'file', path: missing, seq: 4 },
  })
  assert.equal(section.text({ agent: { session: {} } }), DEFAULT_SYSTEM_PROMPT)
  assert.equal(section.text({ agent: { session: {} } }), DEFAULT_SYSTEM_PROMPT)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /读不到文件/u)

  const withSnapshot = install({
    ...initPromptLabState({ cwd: dir }),
    selection: { kind: 'file', path: missing, seq: 4 },
    lastSystemText: 'last good',
    lastSystemSeq: 9,
  })
  assert.equal(withSnapshot.section.text({ agent: { session: {} } }), 'last good')
})

test('provider: a throwing registry degrades to the default line', () => {
  const { section, warnings } = install(initPromptLabState({ cwd: '/work' }), { throws: true })
  assert.equal(section.text({ agent: { session: {} } }), DEFAULT_SYSTEM_PROMPT)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /registry exploded/u)
})
