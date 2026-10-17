import test from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyGate } from '../presets/liangshen/context-gate.mjs'
import { apply as applyHint } from '../presets/liangshen/instruction-hint.mjs'

/**
 * Wire the two plugins exactly as the composition does —
 * `context-gate` first, `instruction-hint` second — and emulate the Cordis
 * pre-step waterfall: registration order is execution order, and both
 * listeners are `prepend` transforms that call `next()` and then edit the
 * decision on the way back, so the gate (registered first) sees the hint's
 * appended message last.
 */
function mount({ files = ['/proj/AGENTS.md'], allowKinds }) {
  const listeners = new Map()
  const ctx = {
    logger: { warn() {} },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    get(service) {
      if (service !== 'fs') return undefined
      const present = new Set(files)
      return {
        async resolve(path) { return path },
        async stat(path) { return present.has(path) ? { type: 'file' } : undefined },
      }
    },
  }
  applyGate(ctx, { promoteOn: 'either', includeSubagents: true, allowKinds })
  applyHint(ctx, { promoteOn: 'either', includeSubagents: true, recoveryHint: true })
  return listeners
}

function makeAgent(id, events) {
  return { session: { id, header: { cwd: '/proj', delegationDepth: 0 }, snapshotEvents: () => events } }
}

async function runPreStep(listeners, agent) {
  const handlers = listeners.get('agent/pre-step') ?? []
  assert.equal(handlers.length, 2, 'expected context-gate + instruction-hint')
  const claimed = []
  const invoke = (index) => {
    const handler = handlers[index]
    if (handler === undefined) return Promise.resolve({ kind: 'continue', messages: claimed })
    return handler({ agent, signal: undefined, messages: claimed }, () => invoke(index + 1))
  }
  return invoke(0)
}

const COMPACTED = [
  { seq: 1, type: 'tool/call' },
  { seq: 2, type: 'compaction/end' },
]

test('the context gate lets the post-compaction recovery hint through', async () => {
  const listeners = mount({ allowKinds: ['skill-invocation', 'recovery-hint'] })
  const decision = await runPreStep(listeners, makeAgent('s-gate-pass', COMPACTED))
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].source.kind, 'recovery-hint')
})

test('without the allowKinds entry the gate strips the recovery hint (config contract)', async () => {
  const listeners = mount({ allowKinds: ['skill-invocation'] })
  const decision = await runPreStep(listeners, makeAgent('s-gate-strip', COMPACTED))
  assert.equal(decision.messages.length, 0, 'recovery-hint must be allow-listed in context-gate.allowKinds')
})

test('the initial hint still flows only after promotion (gate open)', async () => {
  const listeners = mount({ allowKinds: ['skill-invocation', 'recovery-hint'] })
  const unpromoted = await runPreStep(listeners, makeAgent('s-gate-initial-unpromoted', []))
  assert.equal(unpromoted.messages.length, 0, 'initial hint must not leak into the first request')
  const promoted = await runPreStep(listeners, makeAgent('s-gate-initial-promoted', [{ seq: 1, type: 'tool/call' }]))
  assert.equal(promoted.messages.length, 1)
  assert.equal(promoted.messages[0].source.kind, 'instruction-hint')
})
