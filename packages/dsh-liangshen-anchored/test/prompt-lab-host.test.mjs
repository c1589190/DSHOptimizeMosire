import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { PROMPT_LAB_KEY, initPromptLabState } from '../lib/prompt-lab-state.js'

function fakeCtx(state) {
  const listeners = []
  const injections = []
  const definitions = []
  const ctx = {
    get(name) {
      if (name !== 'sessionProjections') return undefined
      return {
        register(definition) {
          definitions.push(definition)
          return () => {}
        },
        stateOf() {
          return state
        },
      }
    },
    inject(services, callback) {
      injections.push({ services, callback })
    },
    on(event, handler, options) {
      listeners.push({ event, handler, options })
    },
    effect() {},
    logger: { warn() {}, error() {} },
  }
  return { ctx, listeners, injections, definitions }
}

test('apply installs the prompt-lab projection and a prepended pre-step guard', () => {
  const { ctx, listeners, definitions } = fakeCtx(initPromptLabState({ cwd: '/work' }))
  apply(ctx)
  assert.equal(definitions.length, 1)
  assert.equal(definitions[0].key, PROMPT_LAB_KEY)
  assert.equal(definitions[0].stateVersion, 1)
  const guard = listeners.find((listener) => listener.event === 'agent/pre-step')
  assert.ok(guard, 'missing agent/pre-step guard')
  assert.equal(guard.options.prepend, true)
  assert.equal(typeof guard.handler, 'function')
})

test('the wired guard forces a fresh series only while a switch is pending', async () => {
  const pending = {
    ...initPromptLabState({ cwd: '/work' }),
    selection: { kind: 'blank', seq: 4 },
  }
  const { ctx, listeners } = fakeCtx(pending)
  apply(ctx)
  const guard = listeners.find((listener) => listener.event === 'agent/pre-step').handler
  const decision = { kind: 'enter', messages: [] }
  const result = await guard({ agent: { session: {} } }, async () => decision)
  assert.equal(result.startsRequestSeries, true)
  assert.equal(result.messages, decision.messages)

  const frozenState = { ...pending, lastSystemSeq: 9 }
  const frozen = fakeCtx(frozenState)
  apply(frozen.ctx)
  const frozenGuard = frozen.listeners.find((listener) => listener.event === 'agent/pre-step').handler
  const unchanged = await frozenGuard({ agent: { session: {} } }, async () => decision)
  assert.equal(unchanged, decision)

  const rejected = await guard({ agent: { session: {} } }, async () => ({ kind: 'reject' }))
  assert.equal(rejected.kind, 'reject')
  assert.equal(rejected.startsRequestSeries, undefined)
})
