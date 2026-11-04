import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const presetDir = join(root, 'presets', 'minimal-prompt-lab')
const yml = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
const metadata = readFileSync(join(presetDir, 'preset.yml'), 'utf8')
const rowIndex = (id) => yml.indexOf(`- id: ${id}`)
const rows = yml.split('\n').filter((line) => /^- id: /.test(line)).map((line) => line.slice(6).trim())

test('rows: prompt-lab persona, official Minimal blocks, /sp command', () => {
  assert.deepEqual(rows, [
    'prompt-lab-persona',
    'tool-fs',
    'compaction',
    'persistent-shell',
    'prompt-lab-command',
  ])
  assert.ok(rowIndex('tool-fs') > rowIndex('prompt-lab-persona'))
  assert.ok(rowIndex('compaction') > rowIndex('tool-fs'))
  assert.ok(rowIndex('persistent-shell') > rowIndex('compaction'))
  assert.ok(rowIndex('prompt-lab-command') > rowIndex('persistent-shell'))
})

test('tool surface is exactly bash + read_image (no read/write/edit)', () => {
  assert.match(yml, /read: false\n\s+readImage: true\n\s+write: false\n\s+edit: false/u)
  assert.match(yml, /name: '@deepseek-ai\/dsh-tool-bash-persistent'/u)
  assert.match(yml, /name: '@deepseek-ai\/dsh-tool-pwsh-persistent'/u)
  assert.ok(!/^\s+read: true$/mu.test(yml), 'read tool must stay disabled')
  assert.ok(!/^\s+write: true$/mu.test(yml), 'write tool must stay disabled')
  assert.ok(!/^\s+edit: true$/mu.test(yml), 'edit tool must stay disabled')
  const names = [...yml.matchAll(/name: '?(@deepseek-ai\/[\w-]+)'?/gu)].map((match) => match[1])
  assert.deepEqual([...new Set(names)].sort(), [
    '@deepseek-ai/dsh-command-compact',
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-terminal',
    '@deepseek-ai/dsh-terminal-bash',
    '@deepseek-ai/dsh-tool-bash-persistent',
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-tool-pwsh-persistent',
  ])
})

test('official persona row is replaced and no automatic context injection is mounted', () => {
  assert.ok(!yml.includes('@deepseek-ai/dsh-persona'), 'the official persona row must be replaced')
  assert.ok(!yml.includes('agent-instructions'))
  assert.ok(!yml.includes('skill-catalog'))
  assert.match(yml, /name: \.\/prompt-lab-persona\.mjs/u)
  assert.match(yml, /name: \.\/prompt-lab-command\.mjs/u)
  for (const file of ['prompt-lab-persona.mjs', 'prompt-lab-command.mjs']) {
    assert.ok(existsSync(join(presetDir, file)), `missing local plugin ${file}`)
  }
})

test('compaction and shell groups keep the official isolate realms and timeouts', () => {
  assert.match(yml, /isolate:\n\s+compaction: true/u)
  assert.match(yml, /isolate:\n\s+terminals: true/u)
  assert.match(yml, /timeoutMs: 300000/u)
  assert.match(yml, /disabled: !!js process\.platform === 'win32'/u)
  assert.match(yml, /disabled: !!js process\.platform !== 'win32'/u)
})

test('metadata declares the experiment preset with roster order 4', () => {
  assert.match(metadata, /^name: 极简模式·提示词实验$/mu)
  assert.match(metadata, /^order: 4$/mu)
})
