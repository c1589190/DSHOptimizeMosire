import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../presets/liangshen/instruction-hint.mjs'

/** Minimal fs seam used by instruction-hint's probes. */
function makeFs(files) {
  const present = new Set(files)
  return {
    async resolve(path) { return path },
    async stat(path) { return present.has(path) ? { type: 'file' } : undefined },
  }
}

/** Register the plugin on a fake Cordis context and return its listener map. */
function mount(files, config = {}) {
  const listeners = new Map()
  const ctx = {
    logger: { warn() {} },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    get(service) { return service === 'fs' ? makeFs(files) : undefined },
  }
  apply(ctx, { promoteOn: 'either', includeSubagents: true, recoveryHint: true, ...config })
  return listeners
}

function makeAgent(id, events, cwd = '/proj') {
  return { session: { id, header: { cwd, delegationDepth: 0 }, snapshotEvents: () => events } }
}

/** Run the single agent/pre-step listener with an empty claimed batch. */
async function preStep(listeners, agent) {
  const handler = listeners.get('agent/pre-step')?.[0]
  assert.ok(handler, 'agent/pre-step listener missing')
  return handler({ agent, signal: undefined, messages: [] }, async () => ({ kind: 'continue', messages: [] }))
}

const messagesOf = (decision) => decision.messages ?? []
const textOf = (message) => message.content.map((block) => block.text).join(' ')

const AGENTS_FILE = '/proj/AGENTS.md'
const PROMOTED = [{ seq: 1, type: 'tool/call' }]
const COMPACTED_ONCE = [
  { seq: 1, type: 'tool/call' },
  { seq: 2, type: 'compaction/end' },
]

test('initial hint is injected once after promotion', async () => {
  const listeners = mount([AGENTS_FILE])
  const agent = makeAgent('s1', [...PROMOTED])
  const first = await preStep(listeners, agent)
  assert.equal(messagesOf(first).length, 1)
  const hint = messagesOf(first)[0]
  assert.equal(hint.source.kind, 'instruction-hint')
  assert.equal(hint.source.form, 'hint')
  assert.match(textOf(hint), /Workspace instruction files exist: AGENTS\.md/)
  assert.match(textOf(hint), /all instructions in these files are important/)
  assert.match(textOf(hint), /Read the complete files/)

  const second = await preStep(listeners, agent)
  assert.equal(messagesOf(second).length, 0, 'initial hint must not repeat')
})

test('recovery hint is injected right after compaction even while unpromoted', async () => {
  const listeners = mount([AGENTS_FILE])
  const agent = makeAgent('s2', [...COMPACTED_ONCE])
  const decision = await preStep(listeners, agent)
  assert.equal(messagesOf(decision).length, 1)
  const hint = messagesOf(decision)[0]
  assert.equal(hint.source.kind, 'recovery-hint')
  assert.equal(hint.source.form, 'hint')
  assert.equal(hint.source.boundary, 2)
  assert.equal(hint.id, 'recovery-hint-s2-2')
  assert.match(textOf(hint), /just compacted/)
  assert.match(textOf(hint), /AGENTS\.md/)
  assert.match(textOf(hint), /read the workspace instruction files completely/i)
  assert.match(textOf(hint), /all of their content is important/i)
  assert.match(textOf(hint), /skill_search/)
  assert.match(textOf(hint), /skill_load/)
})

test('recovery hint is not repeated within the same epoch', async () => {
  const listeners = mount([AGENTS_FILE])
  const agent = makeAgent('s3', [...COMPACTED_ONCE])
  assert.equal(messagesOf(await preStep(listeners, agent)).length, 1)
  assert.equal(messagesOf(await preStep(listeners, agent)).length, 0)
})

test('a second compaction boundary gets its own recovery hint', async () => {
  const listeners = mount([AGENTS_FILE])
  const agent = makeAgent('s4', [
    ...COMPACTED_ONCE,
    { seq: 3, type: 'assistant/message' },
    { seq: 4, type: 'compaction/end' },
  ])
  const decision = await preStep(listeners, agent)
  assert.equal(messagesOf(decision).length, 1)
  const hint = messagesOf(decision)[0]
  assert.equal(hint.source.boundary, 4)
  assert.equal(hint.id, 'recovery-hint-s4-4')
})

test('resume does not duplicate a recovery hint already in the durable log', async () => {
  const listeners = mount([AGENTS_FILE])
  const agent = makeAgent('s5', [
    ...COMPACTED_ONCE,
    {
      seq: 3,
      type: 'user/message',
      data: {
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'recovery hint' }],
          source: { kind: 'recovery-hint', form: 'hint', boundary: 2 },
        },
      },
    },
  ])
  assert.equal(messagesOf(await preStep(listeners, agent)).length, 0)
})

test('recovery hint without instruction files tells the model to locate the repository root', async () => {
  const listeners = mount([])
  const agent = makeAgent('s6', [...COMPACTED_ONCE], '/work/parent')
  const decision = await preStep(listeners, agent)
  assert.equal(messagesOf(decision).length, 1)
  const recoveryText = textOf(messagesOf(decision)[0])
  assert.match(recoveryText, /locate the repository root/)
  assert.match(recoveryText, /all of its content is important/)
})

test('recovery hint survives a missing fs seam with the generic text', async () => {
  const listeners = new Map()
  const ctx = {
    logger: { warn() {} },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    get() { return undefined },
  }
  apply(ctx, { promoteOn: 'either', includeSubagents: true, recoveryHint: true })
  const agent = makeAgent('s7', [...COMPACTED_ONCE])
  const decision = await preStep(listeners, agent)
  assert.equal(messagesOf(decision).length, 1)
  assert.match(textOf(messagesOf(decision)[0]), /just compacted/)
  assert.match(textOf(messagesOf(decision)[0]), /skill_search/)
})

test('recoveryHint: false keeps the legacy once-per-session behavior', async () => {
  const listeners = mount([AGENTS_FILE], { recoveryHint: false })
  const agent = makeAgent('s8', [...COMPACTED_ONCE])
  assert.equal(messagesOf(await preStep(listeners, agent)).length, 0, 'no recovery hint when disabled')
})

test('invalid recoveryHint config fails at apply time', () => {
  assert.throws(() => mount([], { recoveryHint: 'yes' }), /recoveryHint must be a boolean/)
})

test('invalid includeSubagents config fails at apply time', () => {
  assert.throws(() => mount([], { includeSubagents: 'yes' }), /includeSubagents must be a boolean/)
})
