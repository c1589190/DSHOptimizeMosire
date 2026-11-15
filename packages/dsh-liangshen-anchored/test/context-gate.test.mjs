import test from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyGate } from '../presets/liangshen/context-gate.mjs'

/**
 * Build a minimal Cordis context and a fake agent-scoped systemPrompt. The
 * gate only touches `agent/created` / `agent/disposed` / `session/event` and
 * the agent's `systemPrompt`; the fake records every context registration.
 */
function mount() {
  const listeners = new Map()
  const registered = []
  const ctx = {
    logger: { warn() {} },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
  }
  const systemPrompt = {
    suppressRuntimeContext() {
      return () => {}
    },
    context(context) {
      registered.push(context)
      return () => {}
    },
    getContextOrder(name) {
      if (name === 'WORKING_DIRECTORY') return 100
      if (name === 'SUBAGENT_DELEGATION') return 650
      throw new Error(`unknown context order ${name}`)
    },
  }
  const agent = {
    session: { id: 's-required-contexts', header: { delegationDepth: 0 }, snapshotEvents: () => [] },
    ctx: { systemPrompt },
  }
  applyGate(ctx, {})
  return { listeners, registered, agent }
}

test('the unpromoted gate shadows the required working-directory context', () => {
  const { listeners, registered, agent } = mount()
  listeners.get('agent/created')[0]({ agent })
  const workingDirectory = registered.find((entry) => entry.name === 'working-directory:current')
  assert.ok(workingDirectory)
  assert.equal(workingDirectory.text, '')
  assert.equal(workingDirectory.required, true)
})

test('the unpromoted gate shadows the required subagent identity context', () => {
  const { listeners, registered, agent } = mount()
  listeners.get('agent/created')[0]({ agent })
  const identity = registered.find((entry) => entry.name === 'subagent:identity')
  assert.ok(identity, 'DSH 0.2.2-rc.3 tool-subagent-control contributes a required subagent:identity context')
  assert.equal(identity.text, '')
  assert.equal(identity.required, true)
  assert.equal(identity.order, 650)
})
