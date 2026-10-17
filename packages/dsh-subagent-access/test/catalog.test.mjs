import assert from 'node:assert/strict'
import test from 'node:test'

import { TOOL_NAMES, catalogRows, normalizeConfig, shouldInstall } from '../lib/catalog.js'

/** Minimal Agent double exposing only the delegation depth under test. */
function makeAgent(delegationDepth) {
  return { id: `session-${delegationDepth}`, session: { header: { delegationDepth } } }
}

test('normalizeConfig returns the documented defaults for an absent config', () => {
  assert.deepEqual(normalizeConfig(undefined), { enabled: true, includeDelegatedAgents: false })
  assert.deepEqual(normalizeConfig(null), { enabled: true, includeDelegatedAgents: false })
  assert.deepEqual(normalizeConfig({}), { enabled: true, includeDelegatedAgents: false })
})

test('normalizeConfig keeps explicit booleans', () => {
  assert.deepEqual(normalizeConfig({ enabled: false }), { enabled: false, includeDelegatedAgents: false })
  assert.deepEqual(normalizeConfig({ includeDelegatedAgents: true }), { enabled: true, includeDelegatedAgents: true })
  assert.deepEqual(normalizeConfig({ enabled: false, includeDelegatedAgents: true }), { enabled: false, includeDelegatedAgents: true })
})

test('normalizeConfig rejects non-object, unknown, and non-boolean configuration', () => {
  for (const value of ['yes', 1, true, [], [{ enabled: true }]]) {
    assert.throws(() => normalizeConfig(value), /must be an object/, `config ${JSON.stringify(value)} must be rejected`)
  }
  assert.throws(() => normalizeConfig({ typo: true }), /unknown config key "typo"/)
  assert.throws(() => normalizeConfig({ enabled: 'yes' }), /enabled must be a boolean/)
  assert.throws(() => normalizeConfig({ includeDelegatedAgents: 1 }), /includeDelegatedAgents must be a boolean/)
})

test('catalogRows maps every lifecycle mode and omits an absent label', () => {
  const entries = [
    { id: 'child-a', createdAt: 100, mode: 'continuable', label: 'worker' },
    { id: 'child-b', createdAt: 101, mode: 'one-shot' },
    { id: 'child-c', createdAt: 102, mode: 'unknown' },
  ]
  const statuses = new Map([['child-a', 'running'], ['child-b', 'idle']])
  const rows = catalogRows(entries, (id) => statuses.get(id))

  assert.deepEqual(rows, [
    { id: 'child-a', label: 'worker', mode: 'continuable', status: 'running', createdAt: 100 },
    { id: 'child-b', mode: 'one-shot', status: 'inactive', createdAt: 101 },
    { id: 'child-c', mode: 'unknown', status: 'inactive', createdAt: 102 },
  ])
  assert.equal(Object.hasOwn(rows[1], 'label'), false, 'an absent label must not become undefined')
})

test('catalogRows maps any non-running or unknown status to inactive', () => {
  const entries = [{ id: 'child-a', createdAt: 1, mode: 'continuable', label: 'worker' }]
  for (const status of [undefined, 'idle', 'inactive', 'provisioning']) {
    const [row] = catalogRows(entries, () => status)
    assert.equal(row.status, 'inactive', `status ${String(status)} must map to inactive`)
  }
  assert.equal(catalogRows(entries, () => 'running')[0].status, 'running')
})

test('catalogRows normalizes an unknown mode and tolerates an empty catalog', () => {
  const [row] = catalogRows([{ id: 'child-a', createdAt: 1, mode: 'legacy', label: 'old' }], () => 'running')
  assert.equal(row.mode, 'unknown')
  assert.deepEqual(catalogRows([], () => 'running'), [])
  assert.deepEqual(catalogRows(undefined, () => 'running'), [])
})

test('catalogRows preserves catalog order', () => {
  const entries = [
    { id: 'first', createdAt: 3, mode: 'one-shot' },
    { id: 'second', createdAt: 2, mode: 'one-shot' },
    { id: 'third', createdAt: 1, mode: 'one-shot' },
  ]
  assert.deepEqual(catalogRows(entries, () => 'idle').map((row) => row.id), ['first', 'second', 'third'])
})

test('shouldInstall targets root sessions by default', () => {
  const config = { enabled: true, includeDelegatedAgents: false }
  assert.equal(shouldInstall(makeAgent(0), config), true)
  assert.equal(shouldInstall(makeAgent(1), config), false)
  assert.equal(shouldInstall(makeAgent(2), config), false)
  assert.equal(shouldInstall({ id: 'no-header', session: { header: {} } }, config), true)
  assert.equal(shouldInstall({}, config), true)
})

test('shouldInstall honors includeDelegatedAgents and enabled', () => {
  assert.equal(shouldInstall(makeAgent(1), { enabled: true, includeDelegatedAgents: true }), true)
  assert.equal(shouldInstall(makeAgent(0), { enabled: false, includeDelegatedAgents: false }), false)
  assert.equal(shouldInstall(makeAgent(0), { enabled: false, includeDelegatedAgents: true }), false)
  assert.equal(shouldInstall(makeAgent(1), undefined), false)
})

test('TOOL_NAMES is the fixed, collision-free registration order', () => {
  assert.deepEqual([...TOOL_NAMES], ['subagent_list', 'subagent_message', 'subagent_interrupt'])
  assert.equal(Object.isFrozen(TOOL_NAMES), true)
})
