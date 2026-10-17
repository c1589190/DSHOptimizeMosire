import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BASE_FILE,
  VARIANT_FILE,
  renderEmptySystemComposition,
} from '../../../tools/sync-preset-variant.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const presetDir = join(root, 'presets', 'liangshen')
const yml = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
const metadata = readFileSync(join(presetDir, 'preset.yml'), 'utf8')
const variantYml = existsSync(VARIANT_FILE) ? readFileSync(VARIANT_FILE, 'utf8') : ''
const emptyPresetMetadataPath = join(presetDir, 'preset.empty-system.yml')

const rowIndex = (id) => yml.indexOf(`- id: ${id}`)
const countRows = (text) => text.split('\n').filter((line) => /^- id: /.test(line)).length

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

test('the context gate allows the per-compaction recovery hint', () => {
  assert.match(yml, /allowKinds: \[skill-invocation, recovery-hint\]/u)
  assert.match(variantYml, /allowKinds: \[skill-invocation, recovery-hint\]/u)
})

test('instruction-hint enables the per-compaction recovery hint in both presets', () => {
  assert.match(yml, /recoveryHint: true/u)
  assert.match(variantYml, /recoveryHint: true/u)
})

const localPluginFiles = (composition) =>
  [...composition.matchAll(/name: \.\/([\w-]+\.mjs)/g)].map((match) => match[1])

test('every locally referenced plugin file exists in the preset directory', () => {
  for (const [label, composition] of [['main', yml], ['empty-system', variantYml]]) {
    const local = localPluginFiles(composition)
    assert.ok(local.length >= 5, `expected at least 5 mounted local plugins in ${label}, found ${local.length}`)
    for (const file of local) assert.ok(existsSync(join(presetDir, file)), `missing ${file} referenced by ${label}`)
    for (const helper of ['compaction-epoch.mjs', 'session-events.mjs']) {
      assert.ok(existsSync(join(presetDir, helper)), `missing helper ${helper} referenced by ${label}`)
    }
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

test('the empty-system composition is generated from the main composition', () => {
  assert.ok(existsSync(VARIANT_FILE), `missing ${VARIANT_FILE}; run node tools/sync-preset-variant.mjs --write`)
  assert.equal(BASE_FILE, join(presetDir, 'agent.cordis.yml'))
  assert.equal(VARIANT_FILE, join(presetDir, 'agent.empty-system.cordis.yml'))
  assert.equal(variantYml, renderEmptySystemComposition(readFileSync(BASE_FILE, 'utf8')))
})

test('the empty-system composition keeps 21 rows and swaps only the persona literal', () => {
  assert.equal(countRows(variantYml), 21)
  assert.equal(countRows(variantYml), countRows(yml))
  assert.match(variantYml, /const persona = ' '/)
  assert.ok(!yml.includes("const persona = ' '"), 'main composition must not contain the empty persona literal')
  assert.match(yml, /const persona = 'You are a helpful software engineer assistant\.'/)
})

test('the empty-system preset metadata declares its identity and roster order', () => {
  assert.ok(existsSync(emptyPresetMetadataPath), 'missing preset.empty-system.yml')
  const emptyMetadata = readFileSync(emptyPresetMetadataPath, 'utf8')
  assert.match(emptyMetadata, /^name: 梁神模式·空系统提示词$/m)
  assert.match(emptyMetadata, /^order: 6$/m)
})

test('the empty-system persona row keeps the version-adaptive complete prompt config', () => {
  assert.match(variantYml, /complete: true, includeRuntimeContext: false/u)
  assert.match(variantYml, /prefix: persona/u)
  assert.match(variantYml, /text: persona/u)
})

test('the delegation row enables per-call model selection with default effort high', () => {
  assert.match(yml, /modelSelectionSettings: true/u)
  assert.match(yml, /agentOptions:\n\s+reasoningEffort: high/u)
  // The generated empty-system variant must carry the same delegation config.
  assert.match(variantYml, /modelSelectionSettings: true/u)
  assert.match(variantYml, /agentOptions:\n\s+reasoningEffort: high/u)
})
