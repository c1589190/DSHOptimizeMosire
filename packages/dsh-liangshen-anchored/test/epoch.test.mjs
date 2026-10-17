import test from 'node:test'
import assert from 'node:assert/strict'
import { createEpochPromotion } from '../presets/liangshen/compaction-epoch.mjs'

const EITHER = ['tool/call', 'assistant/message']

function makeSession(id, events, delegationDepth = 0) {
  return { id, header: { delegationDepth }, snapshotEvents: () => events }
}
const agentOf = (session) => ({ session })

test('empty session stays unpromoted at boundary -1', () => {
  const p = createEpochPromotion(EITHER)
  assert.deepEqual(p.status(agentOf(makeSession('s-empty', []))), { boundary: -1, promoted: false })
})

test('first durable tool call promotes', () => {
  const p = createEpochPromotion(['tool/call'])
  const s = makeSession('s-tool', [{ seq: 1, type: 'tool/call' }])
  assert.deepEqual(p.status(agentOf(s)), { boundary: -1, promoted: true })
})

test('assistant message promotes only when it is a configured signal', () => {
  const both = createEpochPromotion(EITHER)
  const toolOnly = createEpochPromotion(['tool/call'])
  const s = makeSession('s-asst', [{ seq: 1, type: 'assistant/message' }])
  assert.equal(both.status(agentOf(s)).promoted, true)
  assert.equal(toolOnly.status(agentOf(s)).promoted, false)
})

test('compaction boundary demotes and only later signals promote', () => {
  const p = createEpochPromotion(EITHER)
  const s = makeSession('s-compact', [
    { seq: 1, type: 'tool/call' },
    { seq: 2, type: 'compaction/end' },
  ])
  assert.deepEqual(p.status(agentOf(s)), { boundary: 2, promoted: false })

  const after = makeSession('s-compact-after', [
    { seq: 1, type: 'tool/call' },
    { seq: 2, type: 'compaction/end' },
    { seq: 3, type: 'assistant/message' },
  ])
  assert.deepEqual(p.status(agentOf(after)), { boundary: 2, promoted: true })
})

test('signal before the compaction boundary does not promote', () => {
  const p = createEpochPromotion(EITHER)
  const s = makeSession('s-before', [
    { seq: 1, type: 'assistant/message' },
    { seq: 2, type: 'compaction/end' },
  ])
  assert.equal(p.status(agentOf(s)).promoted, false)
})

test('subagents are promoted by default but follow the phase when included', () => {
  const events = []
  const child = makeSession('s-child', events, 1)
  assert.equal(createEpochPromotion(EITHER).status(agentOf(child)).promoted, true)
  assert.equal(createEpochPromotion(EITHER, { includeSubagents: true }).status(agentOf(child)).promoted, false)
})

test('observe advances an already-scanned session without rescan', () => {
  const p = createEpochPromotion(EITHER)
  const s = makeSession('s-observe', [])
  assert.equal(p.status(agentOf(s)).promoted, false)
  p.observe(s, { seq: 1, type: 'tool/call' })
  assert.equal(p.status(agentOf(s)).promoted, true)
  p.observe(s, { seq: 2, type: 'compaction/end' })
  assert.deepEqual(p.status(agentOf(s)), { boundary: 2, promoted: false })
})

test('outside an agent the phase is open', () => {
  const p = createEpochPromotion(EITHER)
  assert.deepEqual(p.status(undefined), { boundary: -1, promoted: true })
})
