import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const presetDir = join(root, 'presets', 'liangshen')
const yml = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
const metadata = readFileSync(join(presetDir, 'preset.yml'), 'utf8')

const rowIndex = (id) => yml.indexOf(`- id: ${id}`)

test('context gate is the first row and precedes the bootstrap row', () => {
  assert.ok(rowIndex('context-gate') >= 0, 'context-gate row missing')
  assert.ok(rowIndex('tool-bootstrap') > rowIndex('context-gate'), 'bootstrap must come after the gate')
  assert.ok(rowIndex('persona') > rowIndex('tool-bootstrap'))
})

test('promotion and subagent flags stay in sync across the three rows', () => {
  const promoteLines = yml.split('\n').filter((line) => /^\s+promoteOn: either\s*$/.test(line))
  assert.equal(promoteLines.length, 3, 'context-gate, tool-bootstrap and instruction-hint must all promote on either')
  const subagentLines = yml.split('\n').filter((line) => /^\s+includeSubagents:/.test(line))
  assert.equal(subagentLines.length, 3)
  for (const line of subagentLines) assert.match(line, /includeSubagents: true/)
})

test('bootstrap keeps the Minimal tool pair and the inline suppression set', () => {
  assert.match(yml, /bootstrapTools: \[bash, str_replace_editor\]/)
  assert.match(yml, /suppressedContextSources: \[agent-instructions, skill-catalog\]/)
})

test('every locally referenced plugin file exists in the preset directory', () => {
  const local = [...yml.matchAll(/name: \.\/([\w-]+\.mjs)/g)].map((m) => m[1])
  assert.ok(local.length >= 5, `expected at least 5 mounted local plugins, found ${local.length}`)
  for (const file of local) assert.ok(existsSync(join(presetDir, file)), `missing ${file}`)
  for (const helper of ['compaction-epoch.mjs', 'session-events.mjs']) {
    assert.ok(existsSync(join(presetDir, helper)), `missing helper ${helper}`)
  }
})

test('metadata keeps the 梁神模式 identity and roster order', () => {
  assert.match(metadata, /name: 梁神模式/)
  assert.match(metadata, /order: 5/)
})

test('the composition mounts 21 rows', () => {
  const rows = yml.split('\n').filter((line) => /^- id: /.test(line))
  assert.equal(rows.length, 21)
})
