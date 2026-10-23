import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { declarePresets } from '../lib/index.js'

/** Fake agent-presets registry capturing declarations. */
function makeRegistry({ broken = {}, fail = new Set() } = {}) {
  const calls = []
  return {
    calls,
    async register(definition) {
      if (fail.has(definition.id)) throw new Error(`boom:${definition.id}`)
      calls.push(definition)
      return async () => {}
    },
    async list() {
      return calls.map((definition) => ({ id: definition.id, broken: broken[definition.id] ?? null }))
    },
  }
}

/** Minimal host ctx: only the services declarePresets touches. */
function makeCtx(registry) {
  return {
    get: (name) => (name === 'agentPresets' ? registry : undefined),
    effect: () => {},
    logger: { warn() {}, error() {} },
  }
}

/** Fake peer sync so the suite never rewrites the workspace farm. */
async function fakeSyncPeers() {
  return { synced: true, anchor: '/fake/dsh/lib/bin.js', linked: ['@deepseek-ai/dsh-persona'], missing: [], changed: [] }
}

/** Run declarePresets with DSH_HOME isolated to a temp dir; return the status file. */
async function declare(registry) {
  const home = mkdtempSync(join(tmpdir(), 'dshom-presets-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await declarePresets(makeCtx(registry), { syncPeers: fakeSyncPeers })
    return JSON.parse(readFileSync(join(home, 'liangshen-anchored-status.json'), 'utf8'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test('declares both bundled presets with metadata and absolute composition URLs', async () => {
  const registry = makeRegistry()
  const status = await declare(registry)
  assert.equal(registry.calls.length, 2)
  const [main, empty] = registry.calls
  assert.equal(main.id, 'liangshen')
  assert.equal(main.name, '梁神模式')
  assert.equal(main.order, 5)
  assert.equal(empty.id, 'liangshen-empty-system')
  assert.equal(empty.name, '梁神模式·空系统提示词')
  assert.equal(empty.order, 6)
  for (const definition of registry.calls) {
    assert.equal(definition.plugins.length, 1)
    assert.equal(definition.plugins[0].name, '@deepseek-ai/cordis-plugin-include')
    const path = definition.plugins[0].config.path
    assert.match(path, /^file:\/\//u)
    assert.ok(existsSync(fileURLToPath(path)), `composition missing: ${path}`)
  }
  assert.match(main.plugins[0].config.path, /agent\.cordis\.yml$/u)
  assert.match(empty.plugins[0].config.path, /agent\.empty-system\.cordis\.yml$/u)
  assert.equal(status.declared, true)
  assert.equal(status.presets.length, 2)
  assert.deepEqual(status.presets.map((preset) => preset.broken), [null, null])
  assert.equal(status.peers.synced, true)
  assert.equal(status.peers.anchor, '/fake/dsh/lib/bin.js')
  // Backward-compatible single-preset projection.
  assert.equal(status.presetId, 'liangshen')
  assert.equal(status.broken, null)
})

test('a broken activation is reported per preset without failing the roster write', async () => {
  const registry = makeRegistry({ broken: { 'liangshen-empty-system': 'row never started' } })
  const status = await declare(registry)
  assert.equal(status.declared, true)
  assert.equal(status.presets[0].broken, null)
  assert.equal(status.presets[1].broken, 'row never started')
  assert.equal(status.broken, null)
})

test('one failed declaration does not block the other and is recorded', async () => {
  const registry = makeRegistry({ fail: new Set(['liangshen-empty-system']) })
  const status = await declare(registry)
  assert.equal(registry.calls.length, 1)
  assert.equal(status.declared, false)
  assert.equal(status.presets[0].declared, true)
  assert.equal(status.presets[1].declared, false)
  assert.match(status.presets[1].error, /boom:liangshen-empty-system/u)
})

test('a missing agent-presets service fails open and is recorded', async () => {
  const status = await declare(undefined)
  assert.equal(status.declared, false)
  assert.match(status.error, /agentPresets service unavailable/u)
  assert.deepEqual(status.presets, [])
})
