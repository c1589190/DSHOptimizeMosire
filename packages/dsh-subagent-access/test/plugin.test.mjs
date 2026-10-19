import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

// Keep the diagnostic status file out of the real DSH_HOME.
const statusHome = mkdtempSync(join(tmpdir(), 'subagent-access-test-'))
process.env.DSH_HOME = statusHome
const statusPath = join(statusHome, 'subagent-access-status.json')

const signal = new AbortController().signal

/** Minimal Cordis context: capture listeners/effects, serve the two services. */
function makeCtx({ agents, subagents, sessions, logger } = {}) {
  const onCalls = []
  const listeners = new Map()
  const effects = []
  const services = { agents, subagents, sessions }
  return {
    onCalls,
    listeners,
    effects,
    on(event, handler, options) {
      onCalls.push({ event, handler, options })
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    get(service) {
      return services[service]
    },
    effect(callback, label) {
      effects.push({ callback, label })
      return () => {}
    },
    logger: logger ?? { warn() {} },
  }
}

/** Fake Agent: records every tool definition registered in its scope. */
function makeAgent({ id = 'session-root', delegationDepth = 0, status = 'idle', whenIdle } = {}) {
  const tools = new Map()
  const registrations = []
  return {
    id,
    status,
    whenIdle: whenIdle ?? (() => Promise.resolve()),
    session: { id, header: { delegationDepth } },
    tools,
    registrations,
    ctx: {
      tools: {
        register(definition) {
          registrations.push(definition)
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
    },
  }
}

/** Fake `ctx.agents`: a live registry with call recording. */
function makeAgents(initial = []) {
  const byId = new Map(initial.map((agent) => [agent.id, agent]))
  const calls = { list: 0, get: [] }
  return {
    calls,
    list() {
      calls.list += 1
      return [...byId.values()]
    },
    get(id) {
      calls.get.push(id)
      return byId.get(id)
    },
    add(agent) {
      byId.set(agent.id, agent)
    },
    remove(id) {
      byId.delete(id)
    },
  }
}

/** Fake `ctx.sessions`: map child id -> event array. */
function makeSessions(eventsById = {}) {
  return {
    get(id) {
      const events = eventsById[id]
      if (events === undefined) return undefined
      return { snapshotEvents: () => events }
    },
  }
}

/** Fake `ctx.subagents`: records exact calls; `hooks` override one method. */
function makeSubagents({ children = [], hooks = {} } = {}) {
  const calls = { listChildren: [], sendMessage: [], interrupt: [] }
  return {
    calls,
    async listChildren(parentSessionId, listSignal) {
      calls.listChildren.push({ parentSessionId, signal: listSignal })
      if (hooks.listChildren !== undefined) return hooks.listChildren()
      return children
    },
    async sendMessage(sender, targetId, content, options) {
      calls.sendMessage.push({ sender, targetId, content, options })
      if (hooks.sendMessage !== undefined) return hooks.sendMessage()
      return 'message-1'
    },
    interrupt(targetSessionId, authority) {
      calls.interrupt.push({ targetSessionId, authority })
      if (hooks.interrupt !== undefined) return hooks.interrupt()
    },
  }
}

function errorWith(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function makeHarness(options = {}) {
  const root = makeAgent({ id: 'session-root' })
  const child = makeAgent({ id: 'session-child', delegationDepth: 1 })
  const agents = 'agents' in options ? options.agents : makeAgents([root, child])
  const subagents = 'subagents' in options ? options.subagents : makeSubagents()
  const sessions = 'sessions' in options ? options.sessions : makeSessions()
  const ctx = makeCtx({ agents, subagents, sessions, logger: options.logger })
  apply(ctx, options.config ?? {})
  return { ctx, agents, subagents, root, child }
}

function executeTool(agent, name, args) {
  const definition = agent.tools.get(name)
  assert.ok(definition !== undefined, `${name} must be installed in ${agent.id}`)
  return definition.execute(args, { agent, signal })
}

function readStatus() {
  return JSON.parse(readFileSync(statusPath, 'utf8'))
}

test('activation installs the four tools in root scopes only and records status', () => {
  const { ctx, root, child } = makeHarness()

  assert.deepEqual([...root.tools.keys()], ['subagent_list', 'subagent_message', 'subagent_interrupt', 'subagent_wait'])
  assert.equal(child.tools.size, 0, 'a delegated scope is not a default target')
  assert.deepEqual(ctx.onCalls.map((call) => call.event), ['agent/created', 'agent/disposed'])
  assert.equal(ctx.effects.length, 1)
  assert.equal(ctx.effects[0].label, 'subagent-access.scopedTools()')

  const status = readStatus()
  assert.equal(status.activated, true)
  assert.equal(status.pid, process.pid)
  assert.deepEqual(status.config, { enabled: true, includeDelegatedAgents: false })
  assert.deepEqual(status.installed, ['session-root'])
  assert.deepEqual(status.tools, ['subagent_list', 'subagent_message', 'subagent_interrupt', 'subagent_wait'])
  assert.ok(Date.parse(status.at) > 0)
})

test('includeDelegatedAgents extends installation to delegated scopes', () => {
  const { root, child } = makeHarness({ config: { includeDelegatedAgents: true } })

  assert.equal(root.tools.size, 4)
  assert.equal(child.tools.size, 4)
  assert.deepEqual(readStatus().installed, ['session-root', 'session-child'])
})

test('agent/created installs for a new target and repeated events do not duplicate', () => {
  const { ctx, agents } = makeHarness()
  const late = makeAgent({ id: 'session-late' })
  agents.add(late)

  const created = ctx.listeners.get('agent/created')
  created({ agent: late })
  created({ agent: late })

  assert.equal(late.tools.size, 4)
  assert.equal(late.registrations.length, 4, 'each tool must be registered exactly once')
  assert.deepEqual(readStatus().installed, ['session-root', 'session-late'])
})

test('agent/disposed releases its scope tools and forgets the scope', () => {
  const { ctx, root } = makeHarness()

  ctx.listeners.get('agent/disposed')({ agent: root })

  assert.equal(root.tools.size, 0)
  assert.deepEqual(readStatus().installed, [])
})

test('plugin unload releases every installed scope', () => {
  const { ctx, root, child } = makeHarness({ config: { includeDelegatedAgents: true } })

  const cleanup = ctx.effects[0].callback()
  cleanup()

  assert.equal(root.tools.size, 0)
  assert.equal(child.tools.size, 0)
})

test('enabled:false installs no tools and registers no listeners', () => {
  const { ctx, root, child } = makeHarness({ config: { enabled: false } })

  assert.equal(root.tools.size, 0)
  assert.equal(child.tools.size, 0)
  assert.equal(ctx.onCalls.length, 0)
  assert.equal(ctx.effects.length, 0)
  assert.equal(ctx.listeners.size, 0)

  const status = readStatus()
  assert.equal(status.reason, 'disabled')
  assert.deepEqual(status.installed, [])
})

test('a missing agents or subagents service fails open and records the reason', () => {
  for (const missingService of ['agents', 'subagents']) {
    const logger = { warnings: [], warn(message) { this.warnings.push(message) } }
    const harness = makeHarness({ [missingService]: undefined, logger })

    assert.equal(harness.root.tools.size, 0, `missing ${missingService} must install nothing`)
    assert.equal(harness.ctx.onCalls.length, 0, `missing ${missingService} must register no listener`)
    assert.equal(harness.ctx.effects.length, 0, `missing ${missingService} must register no effect`)

    const status = readStatus()
    assert.equal(status.reason, 'missing-services')
    assert.deepEqual(status.missing, [missingService])
    assert.deepEqual(status.installed, [])
    assert.equal(logger.warnings.length, 1)
    assert.match(logger.warnings[0], /missing service/)
  }
})

test('an agent without a tool registry is skipped without throwing', () => {
  const bare = { id: 'session-bare', session: { header: { delegationDepth: 0 } } }
  const logger = { warnings: [], warn(message) { this.warnings.push(message) } }
  const ctx = makeCtx({ agents: makeAgents([bare]), subagents: makeSubagents(), logger })

  apply(ctx, {})

  assert.deepEqual(readStatus().installed, [])
  assert.equal(logger.warnings.length, 1)
  assert.match(logger.warnings[0], /no tool registry/)
})

test('subagent_list forwards the parent session id and signal and returns an empty catalog', async () => {
  const { root, subagents } = makeHarness({ subagents: makeSubagents({ children: [] }) })

  const value = await executeTool(root, 'subagent_list', {})

  assert.deepEqual(value, { children: [] })
  assert.deepEqual(subagents.calls.listChildren, [{ parentSessionId: 'session-root', signal }])
})

test('subagent_list maps catalog rows and reads live status', async () => {
  const root = makeAgent({ id: 'session-root' })
  const running = makeAgent({ id: 'session-running', delegationDepth: 1, status: 'running' })
  const agents = makeAgents([root, running])
  const subagents = makeSubagents({
    children: [
      { id: 'session-running', createdAt: 10, mode: 'continuable', label: 'worker' },
      { id: 'session-idle', createdAt: 11, mode: 'one-shot' },
    ],
  })
  const ctx = makeCtx({ agents, subagents })
  apply(ctx, {})

  const value = await executeTool(root, 'subagent_list', {})

  assert.deepEqual(value, {
    children: [
      { id: 'session-running', label: 'worker', mode: 'continuable', status: 'running', createdAt: 10 },
      { id: 'session-idle', mode: 'one-shot', status: 'inactive', createdAt: 11 },
    ],
  })
  assert.deepEqual(agents.calls.get, ['session-running', 'session-idle'])
})

test('subagent_list surfaces catalog errors instead of swallowing them', async () => {
  const error = errorWith('SUBAGENT_CONTROL_QUERY_UNAVAILABLE')
  const { root } = makeHarness({
    subagents: makeSubagents({ hooks: { listChildren: () => { throw error } } }),
  })

  await assert.rejects(executeTool(root, 'subagent_list', {}), (thrown) => thrown === error)
})

test('subagent_message forwards the exact sender, target, content, and signal', async () => {
  const { root, subagents } = makeHarness()

  const value = await executeTool(root, 'subagent_message', { child_id: 'session-child', message: 'report now' })

  assert.deepEqual(value, { messageId: 'message-1' })
  assert.deepEqual(subagents.calls.sendMessage, [{
    sender: root,
    targetId: 'session-child',
    content: [{ type: 'text', text: 'report now' }],
    options: { signal },
  }])
})

test('subagent_message surfaces service errors instead of swallowing them', async () => {
  const error = errorWith('NOT_RESUMABLE')
  const { root } = makeHarness({
    subagents: makeSubagents({ hooks: { sendMessage: () => { throw error } } }),
  })

  await assert.rejects(
    executeTool(root, 'subagent_message', { child_id: 'session-child', message: 'again' }),
    (thrown) => thrown === error,
  )
})

test('subagent_interrupt samples status before interrupting and forwards ancestor authority', async () => {
  const sampled = []
  const root = makeAgent({ id: 'session-root' })
  const running = makeAgent({ id: 'session-running', delegationDepth: 1, status: 'running' })
  const agents = makeAgents([root, running])
  const readStatusOf = agents.get.bind(agents)
  agents.get = (id) => {
    sampled.push(`status:${id}`)
    return readStatusOf(id)
  }
  const subagents = makeSubagents()
  const interruptChild = subagents.interrupt.bind(subagents)
  subagents.interrupt = (targetSessionId, authority) => {
    sampled.push(`interrupt:${targetSessionId}`)
    return interruptChild(targetSessionId, authority)
  }
  const ctx = makeCtx({ agents, subagents })
  apply(ctx, {})

  const value = await executeTool(root, 'subagent_interrupt', { child_id: 'session-running' })

  assert.deepEqual(value, { previousStatus: 'running' })
  assert.deepEqual(sampled, ['status:session-running', 'interrupt:session-running'])
  assert.deepEqual(subagents.calls.interrupt, [{
    targetSessionId: 'session-running',
    authority: { kind: 'ancestor', agent: root },
  }])
})

test('subagent_interrupt reports inactive for an idle or absent child', async () => {
  for (const targetStatus of ['idle', undefined]) {
    const root = makeAgent({ id: 'session-root' })
    const target = targetStatus === undefined ? undefined : makeAgent({ id: 'session-child', status: targetStatus })
    const agents = makeAgents(target === undefined ? [root] : [root, target])
    const subagents = makeSubagents()
    const ctx = makeCtx({ agents, subagents })
    apply(ctx, {})

    const value = await executeTool(root, 'subagent_interrupt', { child_id: 'session-child' })

    assert.deepEqual(value, { previousStatus: 'inactive' })
    assert.deepEqual(subagents.calls.interrupt, [{
      targetSessionId: 'session-child',
      authority: { kind: 'ancestor', agent: root },
    }])
  }
})

test('subagent_interrupt surfaces authority errors instead of swallowing them', async () => {
  const error = errorWith('UNAUTHORIZED')
  const { root } = makeHarness({
    subagents: makeSubagents({ hooks: { interrupt: () => { throw error } } }),
  })

  await assert.rejects(
    executeTool(root, 'subagent_interrupt', { child_id: 'session-foreign' }),
    (thrown) => thrown === error,
  )
})

test('the declared output renders compact model-facing JSON', () => {
  const { root } = makeHarness()
  const definition = root.tools.get('subagent_list')

  assert.deepEqual(definition.output.render({}, { children: [] }), [{ type: 'text', text: '{"children":[]}' }])
})

test('invalid config throws at activation and installs nothing', () => {
  const root = makeAgent({ id: 'session-root' })
  const ctx = makeCtx({ agents: makeAgents([root]), subagents: makeSubagents() })

  assert.throws(() => apply(ctx, { enabled: 'yes' }), /enabled must be a boolean/)
  assert.throws(() => apply(ctx, { typo: true }), /unknown config key/)
  assert.equal(root.tools.size, 0)
  assert.equal(ctx.onCalls.length, 0)
})

/** One child catalog entry used by the wait tests. */
const childCatalog = { id: 'session-child', createdAt: 1, mode: 'continuable' }

function waitHarness({ child, events } = {}) {
  const root = makeAgent({ id: 'session-root' })
  const target = child ?? makeAgent({ id: 'session-child', delegationDepth: 1 })
  const agents = makeAgents([root, target])
  const subagents = makeSubagents({ children: [childCatalog] })
  const sessions = makeSessions({ 'session-child': events ?? [] })
  const ctx = makeCtx({ agents, subagents, sessions })
  apply(ctx, {})
  return { ctx, agents, subagents, sessions, root, target }
}

const assistantMessage = (seq, time, text) => ({
  type: 'assistant/message', seq, time,
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

test('subagent_wait returns the child final assistant message when already idle', async () => {
  const { root } = waitHarness({ events: [assistantMessage(1, 111, 'child final answer')] })
  const result = await executeTool(root, 'subagent_wait', { child_id: 'session-child' })
  assert.deepEqual(result, {
    status: 'inactive',
    childId: 'session-child',
    lastMessage: { role: 'assistant', text: 'child final answer', time: 111 },
  })
})

test('subagent_wait blocks until the child becomes idle', async () => {
  let release
  const idle = new Promise((resolve) => { release = resolve })
  const child = makeAgent({ id: 'session-child', delegationDepth: 1, whenIdle: () => idle })
  const { root } = waitHarness({ child, events: [assistantMessage(1, 222, 'done later')] })
  let settled = false
  const pending = executeTool(root, 'subagent_wait', { child_id: 'session-child' }).then((value) => {
    settled = true
    return value
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(settled, false, 'the tool must wait while the child runs')
  release()
  const result = await pending
  assert.equal(result.status, 'inactive')
  assert.equal(result.lastMessage.text, 'done later')
})

test('subagent_wait honours timeout_seconds while the child keeps running', async () => {
  const child = makeAgent({
    id: 'session-child',
    delegationDepth: 1,
    whenIdle: () => new Promise(() => {}),
  })
  const { root } = waitHarness({ child })
  const result = await executeTool(root, 'subagent_wait', { child_id: 'session-child', timeout_seconds: 0.01 })
  assert.deepEqual(result, { status: 'timeout', childId: 'session-child' })
})

test('subagent_wait rejects a session that is not a direct child', async () => {
  const { root } = waitHarness()
  await assert.rejects(
    executeTool(root, 'subagent_wait', { child_id: 'session-stranger' }),
    /not a direct child/,
  )
})
