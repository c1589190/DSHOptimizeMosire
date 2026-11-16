import assert from 'node:assert/strict'
import test from 'node:test'

import { createToolGate } from '../tool-gate.js'

/** Minimal Host stand-in: registration + emit + effect cleanup. */
function fakeCtx() {
  const listeners = new Map()
  return {
    logger: { warn() {} },
    on(name, callback) {
      const list = listeners.get(name) ?? []
      list.push(callback)
      listeners.set(name, list)
      return () => {
        const index = list.indexOf(callback)
        if (index >= 0) list.splice(index, 1)
      }
    },
    emit(name, ...args) {
      for (const callback of [...(listeners.get(name) ?? [])]) callback(...args)
    },
    effect(callback) {
      callback()
    },
  }
}

function session(id, preset, events = [], delegationDepth = 0) {
  return {
    id,
    header: { agentPreset: preset, delegationDepth },
    snapshotEvents: () => events,
  }
}

test('non-anchored sessions mount immediately', () => {
  const gate = createToolGate(fakeCtx())
  let mounts = 0
  let disposes = 0
  const release = gate.mount({ session: session('s1', 'standard') }, () => {
    mounts += 1
    return () => {
      disposes += 1
    }
  })
  assert.equal(mounts, 1)
  release()
  assert.equal(disposes, 1)
  release()
  assert.equal(disposes, 1, 'release is idempotent')
})

test('anchored sessions defer until the first durable signal', () => {
  const ctx = fakeCtx()
  const gate = createToolGate(ctx)
  const s = session('s2', 'liangshen')
  let mounts = 0
  gate.mount({ session: s }, () => {
    mounts += 1
    return () => {}
  })
  assert.equal(mounts, 0, 'first request stays anchored')

  ctx.emit('session/event', s, { type: 'tool/call', seq: 3 })
  assert.equal(mounts, 1, 'promotion mounts the tool group')
  ctx.emit('session/event', s, { type: 'assistant/message', seq: 4 })
  assert.equal(mounts, 1, 'later signals do not double-mount')
})

test('compaction demotes and the next signal mounts again', () => {
  const ctx = fakeCtx()
  const gate = createToolGate(ctx)
  const s = session('s3', 'liangshen-empty-system')
  let mounts = 0
  let disposes = 0
  gate.mount({ session: s }, () => {
    mounts += 1
    return () => {
      disposes += 1
    }
  })
  ctx.emit('session/event', s, { type: 'tool/call', seq: 1 })
  assert.deepEqual([mounts, disposes], [1, 0])
  ctx.emit('session/event', s, { type: 'compaction/end', seq: 5 })
  assert.deepEqual([mounts, disposes], [1, 1], 'compaction releases the group')
  ctx.emit('session/event', s, { type: 'tool/call', seq: 9 })
  assert.deepEqual([mounts, disposes], [2, 1], 'post-compaction promotion mounts again')
})

test('a resumed promoted session mounts immediately', () => {
  const gate = createToolGate(fakeCtx())
  const s = session('s4', 'liangshen', [{ type: 'tool/call', seq: 2 }])
  let mounts = 0
  gate.mount({ session: s }, () => {
    mounts += 1
  })
  assert.equal(mounts, 1)
})

test('subagents keep their full catalog', () => {
  const gate = createToolGate(fakeCtx())
  const child = session('s5', 'liangshen', [], 1)
  let mounts = 0
  gate.mount({ session: child }, () => {
    mounts += 1
  })
  assert.equal(mounts, 1)
})

test('a preset selected before the first turn defers the group', () => {
  const ctx = fakeCtx()
  const gate = createToolGate(ctx)
  const events = []
  const s = session('s6', 'standard', events)
  let mounts = 0
  let disposes = 0
  gate.mount({ session: s }, () => {
    mounts += 1
    return () => {
      disposes += 1
    }
  })
  assert.deepEqual([mounts, disposes], [1, 0], 'a standard session mounts at once')

  const selected = { type: 'agent-preset/selected', seq: 1, data: { agentPreset: 'liangshen' } }
  events.push(selected)
  ctx.emit('session/event', s, selected)
  assert.deepEqual([mounts, disposes], [1, 1], 'joining the anchored preset releases the group')

  ctx.emit('session/event', s, { type: 'tool/call', seq: 2 })
  assert.deepEqual([mounts, disposes], [2, 1], 'promotion mounts the group again')
})
