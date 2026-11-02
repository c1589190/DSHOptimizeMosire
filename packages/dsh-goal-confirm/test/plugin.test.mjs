import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { CANCEL_LABEL, CONTINUE_LABEL, SESSION_OFF_LABEL } from '../lib/decision.js'

// Keep the diagnostic status file out of the real DSH_HOME.
const statusHome = mkdtempSync(join(tmpdir(), 'goal-confirm-test-'))
process.env.DSH_HOME = statusHome
const statusPath = join(statusHome, 'goal-confirm-status.json')

/** Minimal Cordis context: capture listeners, serve the optional services. */
function makeCtx({ goals, questions, logger, commands, projections, gateway } = {}) {
  const onCalls = []
  const listeners = new Map()
  const services = {
    goals,
    userQuestions: questions,
    commands,
    sessionProjections: projections,
    typertGateway: gateway,
  }
  return {
    onCalls,
    listeners,
    on(event, handler, options) {
      onCalls.push({ event, handler, options })
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    get(service) {
      return services[service]
    },
    logger: logger ?? { warn() {} },
  }
}

function makeAgent({ id = 'session-1', delegationDepth = 0 } = {}) {
  const session = { header: { delegationDepth }, id }
  return { id, session }
}

function goalMessage(round, { id = 'm1', source = {} } = {}) {
  return {
    id,
    role: 'user',
    source: { kind: 'goal', round, goalId: 'goal-1', revision: 2, ...source },
    content: [],
  }
}

function makeGoal(overrides = {}) {
  return {
    id: 'goal-1',
    revision: 2,
    objective: 'ship the confirmation gate',
    phase: 'active',
    activation: 'armed',
    maxGoalRounds: 5,
    roundsStarted: 2,
    ...overrides,
  }
}

/** Fake `ctx.goals`: tracks every call and lets a test override behaviour. */
function makeGoals(goal, hooks = {}) {
  const calls = { get: [], clear: [], pause: [] }
  let current = goal
  return {
    calls,
    set(next) {
      current = next
    },
    get(agent) {
      calls.get.push(agent)
      if (hooks.get !== undefined) return hooks.get(agent, current)
      return current
    },
    clear(agent, ref) {
      calls.clear.push({ agent, ref })
      if (hooks.clear !== undefined) return hooks.clear(agent, ref, current)
      return { id: ref.id, revision: ref.revision + 1 }
    },
    pause(agent, ref) {
      calls.pause.push({ agent, ref })
      if (hooks.pause !== undefined) return hooks.pause(agent, ref, current)
      return { ...current, revision: ref.revision + 1, phase: 'paused' }
    },
  }
}

/** Fake `ctx.userQuestions`; `respond` may throw to reject the ask. */
function makeQuestions(respond) {
  const calls = []
  return {
    calls,
    async ask(request) {
      calls.push(request)
      if (respond === undefined) return { answers: [{ id: 'goal-round', selected: [CONTINUE_LABEL] }] }
      return respond(request, calls.length)
    },
  }
}

/** Fake command service: records registrations and runs the handler on execute. */
function makeCommands() {
  const calls = { register: [], execute: [] }
  const service = {
    calls,
    register(definition) {
      calls.register.push(definition)
      return () => {}
    },
    async execute(agent, line, attachments, signal) {
      calls.execute.push({ agent, line, attachments, signal })
      const definition = calls.register[0]
      const prefix = '/goal-confirm'
      const rawInput = typeof line === 'string' && line.startsWith(prefix) ? line.slice(prefix.length) : ''
      if (definition !== undefined) await definition.handler({ agent, rawInput, signal })
      return { result: { kind: 'success' } }
    },
  }
  return service
}

/** Fake session projections: records the definition and serves one state. */
function makeProjections(stateFor = () => ({ enabled: null, timeoutSeconds: null })) {
  const calls = { register: [], stateOf: [] }
  return {
    calls,
    register(definition) {
      calls.register.push(definition)
      return () => {}
    },
    stateOf(session, key) {
      calls.stateOf.push({ session, key })
      return stateFor(session, key)
    },
  }
}

function errorWith(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function rejectWith(code) {
  return () => {
    throw errorWith(code)
  }
}

function makeHarness(options = {}) {
  const goals = Object.hasOwn(options, 'goals') ? options.goals : makeGoals(makeGoal())
  const questions = Object.hasOwn(options, 'questions') ? options.questions : makeQuestions()
  const ctx = makeCtx({
    goals,
    questions,
    logger: options.logger,
    commands: options.commands,
    projections: options.projections,
    gateway: options.gateway,
  })
  apply(ctx, options.config ?? {})
  return { ctx, goals, questions, commands: options.commands, projections: options.projections }
}

async function runPreStep(fakeCtx, messages, agent = makeAgent()) {
  const listener = fakeCtx.listeners.get('agent/pre-step')
  assert.equal(typeof listener, 'function', 'agent/pre-step listener must be registered')
  const nextCalls = []
  const next = async () => {
    nextCalls.push({ messages })
    return { kind: 'enter', messages }
  }
  const decision = await listener({
    agent,
    messages,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, next)
  return { decision, nextCalls }
}

function readStatus() {
  return JSON.parse(readFileSync(statusPath, 'utf8'))
}

test('activation writes the diagnostic status and registers one prepended pre-step listener', () => {
  const { ctx } = makeHarness({ config: { timeoutSeconds: 5 } })
  assert.equal(ctx.onCalls.length, 1)
  assert.equal(ctx.onCalls[0].event, 'agent/pre-step')
  assert.deepEqual(ctx.onCalls[0].options, { prepend: true })
  const status = readStatus()
  assert.deepEqual(status, { activated: true, pid: process.pid, config: { enabled: true, timeoutSeconds: 5, cancelOnClose: true } })
})

test('a. non-goal messages pass through without asking', async () => {
  const { ctx, goals, questions } = makeHarness()
  const human = { id: 'human-1', role: 'user', source: { kind: 'user' }, content: [] }
  const zeroRound = goalMessage(0)
  const result = await runPreStep(ctx, [human, zeroRound])
  assert.equal(result.nextCalls.length, 1)
  assert.equal(result.decision.kind, 'enter')
  assert.equal(questions.calls.length, 0)
  assert.equal(goals.calls.get.length, 0)
})

test('b. active + armed goal round asks once and the continue answer lets it through', async () => {
  const { ctx, goals, questions } = makeHarness()
  const agent = makeAgent()
  const message = goalMessage(3)
  const { decision, nextCalls } = await runPreStep(ctx, [message], agent)

  assert.equal(nextCalls.length, 1)
  assert.equal(decision.kind, 'enter')
  assert.equal(questions.calls.length, 1)
  assert.equal(goals.calls.get.length, 1)
  assert.equal(goals.calls.clear.length, 0)

  const request = questions.calls[0]
  assert.equal(request.agent, agent)
  assert.ok(request.signal instanceof AbortSignal)
  assert.equal(request.questions.length, 1)
  assert.equal(request.questions[0].id, 'goal-round')
  assert.equal(request.questions[0].header, 'Goal 续轮')
  assert.match(request.questions[0].question, /第 3 轮（上限 5）/)
  assert.deepEqual(request.questions[0].options.map((option) => option.label), [CONTINUE_LABEL, CANCEL_LABEL, SESSION_OFF_LABEL])

  const status = readStatus()
  assert.equal(status.activated, true)
  assert.equal(status.pid, process.pid)
  assert.equal(status.sessionId, 'session-1')
  assert.equal(status.round, 3)
  assert.equal(status.action, 'continue')
  assert.equal(status.outcome, 'answer')
  assert.equal(status.cleared, false)
  assert.ok(Date.parse(status.at) > 0)
  assert.deepEqual(status.effective, { enabled: true, timeoutSeconds: 30, cancelOnClose: true })
})

test('c. paused, blocked and disarmed goals pass through without asking', async () => {
  const cases = [
    ['paused', makeGoal({ phase: 'paused' })],
    ['blocked', makeGoal({ phase: 'blocked' })],
    ['disarmed', makeGoal({ activation: 'disarmed' })],
  ]
  for (const [label, goal] of cases) {
    const { ctx, questions } = makeHarness({ goals: makeGoals(goal) })
    const result = await runPreStep(ctx, [goalMessage(3)])
    assert.equal(result.nextCalls.length, 1, `${label} must call next`)
    assert.equal(questions.calls.length, 0, `${label} must not ask`)
  }
})

test('c2. no current goal passes through without asking', async () => {
  const { ctx, questions } = makeHarness({ goals: makeGoals(undefined) })
  const result = await runPreStep(ctx, [goalMessage(3)])
  assert.equal(result.nextCalls.length, 1)
  assert.equal(questions.calls.length, 0)
})

test('d. a round that is not the next admitted round passes through without asking', async () => {
  for (const round of [2, 4]) {
    const { ctx, questions } = makeHarness()
    const result = await runPreStep(ctx, [goalMessage(round)])
    assert.equal(result.nextCalls.length, 1, `round ${round} must call next`)
    assert.equal(questions.calls.length, 0, `round ${round} must not ask`)
  }
})

test('e. delegated (sub) agents pass through without asking', async () => {
  const { ctx, questions } = makeHarness()
  const result = await runPreStep(ctx, [goalMessage(3)], makeAgent({ delegationDepth: 1 }))
  assert.equal(result.nextCalls.length, 1)
  assert.equal(questions.calls.length, 0)
})

test('f. a missing goals or userQuestions service passes through without asking', async () => {
  for (const service of ['goals', 'questions']) {
    const { ctx } = makeHarness({ [service]: undefined })
    const result = await runPreStep(ctx, [goalMessage(3)])
    assert.equal(result.nextCalls.length, 1, `missing ${service} must call next`)
  }
})

test('f2. a goal read that throws passes through without asking', async () => {
  const logger = { warnings: [], warn(message) { this.warnings.push(message) } }
  const goals = makeGoals(makeGoal(), { get: () => { throw new Error('projection unavailable') } })
  const { ctx, questions } = makeHarness({ goals, logger })
  const result = await runPreStep(ctx, [goalMessage(3)])
  assert.equal(result.nextCalls.length, 1)
  assert.equal(questions.calls.length, 0)
  assert.equal(logger.warnings.length, 1)
  assert.match(logger.warnings[0], /could not read the goal/)
})

test('g. the cancel answer clears the exact goal ref and then calls next', async () => {
  const goal = makeGoal({ id: 'goal-7', revision: 4 })
  const questions = makeQuestions(() => ({ answers: [{ id: 'goal-round', selected: [CANCEL_LABEL] }] }))
  const goals = makeGoals(goal)
  const { ctx } = makeHarness({ goals, questions })
  const agent = makeAgent()
  const { nextCalls } = await runPreStep(ctx, [goalMessage(3, { source: { goalId: 'goal-7', revision: 4 } })], agent)

  assert.equal(goals.calls.clear.length, 1)
  assert.deepEqual(goals.calls.clear[0], { agent, ref: { id: 'goal-7', revision: 4 } })
  assert.equal(goals.calls.pause.length, 0)
  assert.equal(nextCalls.length, 1)

  const status = readStatus()
  assert.equal(status.action, 'cancel')
  assert.equal(status.outcome, 'answer')
  assert.equal(status.cleared, true)
})

test('h. closing the card cancels only when cancelOnClose is true', async () => {
  {
    const { ctx, goals } = makeHarness({ questions: makeQuestions(rejectWith('ASK_CANCELLED')) })
    const result = await runPreStep(ctx, [goalMessage(3)])
    assert.equal(goals.calls.clear.length, 1)
    assert.equal(result.nextCalls.length, 1)
  }
  {
    const { ctx, goals } = makeHarness({
      questions: makeQuestions(rejectWith('ASK_CANCELLED')),
      config: { cancelOnClose: false },
    })
    const result = await runPreStep(ctx, [goalMessage(3)])
    assert.equal(goals.calls.clear.length, 0)
    assert.equal(result.nextCalls.length, 1)
  }
})

test('i. ask errors such as ASK_TIMED_OUT or an immediate ASK_ABORTED continue without clearing', async () => {
  for (const code of ['ASK_TIMED_OUT', 'ASK_ABORTED']) {
    const { ctx, goals } = makeHarness({ questions: makeQuestions(rejectWith(code)) })
    const result = await runPreStep(ctx, [goalMessage(3)])
    assert.equal(goals.calls.clear.length, 0, `${code} must not clear`)
    assert.equal(result.nextCalls.length, 1, `${code} must call next`)
  }
})

test('i2. the plugin timeout aborts its own ask and continues the round', { timeout: 5000 }, async () => {
  const questions = {
    calls: [],
    ask(request) {
      questions.calls.push(request)
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(errorWith('ASK_ABORTED')), { once: true })
      })
    },
  }
  const { ctx } = makeHarness({ questions, config: { timeoutSeconds: 1 } })
  const startedAt = Date.now()
  const result = await runPreStep(ctx, [goalMessage(3)])
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed >= 900, `the gate must wait for its timeout, waited ${elapsed}ms`)
  assert.ok(elapsed < 4000, `the gate must not hang, waited ${elapsed}ms`)
  assert.equal(questions.calls.length, 1)
  assert.equal(result.nextCalls.length, 1)

  const status = readStatus()
  assert.equal(status.action, 'continue')
  assert.equal(status.outcome, 'timeout')
  assert.equal(status.code, 'ASK_ABORTED')
  assert.equal(status.cleared, false)
})

test('j. the same round handled twice sequentially asks exactly once', async () => {
  const { ctx, questions } = makeHarness()
  const agent = makeAgent()
  const message = goalMessage(3)
  const first = await runPreStep(ctx, [message], agent)
  const second = await runPreStep(ctx, [message], agent)

  assert.equal(questions.calls.length, 1)
  assert.equal(first.nextCalls.length, 1)
  assert.equal(second.nextCalls.length, 1)
})

test('j3. a new goal that reaches the same round number asks again', async () => {
  const goals = makeGoals(makeGoal({ id: 'goal-1', revision: 2 }))
  const questions = makeQuestions()
  const { ctx } = makeHarness({ goals, questions })
  const agent = makeAgent()
  await runPreStep(ctx, [goalMessage(3)], agent)

  // The first goal is replaced (a new goal id) while round 3 is asked again.
  goals.set(makeGoal({ id: 'goal-2', revision: 1 }))
  await runPreStep(ctx, [goalMessage(3, { source: { goalId: 'goal-2', revision: 1 } })], agent)
  assert.equal(questions.calls.length, 2)
})

test('j2. concurrent pre-step invocations share one in-flight ask', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const questions = makeQuestions(async () => {
    await gate
    return { answers: [{ id: 'goal-round', selected: [CONTINUE_LABEL] }] }
  })
  const { ctx } = makeHarness({ questions })
  const agent = makeAgent()
  const message = goalMessage(3)

  const first = runPreStep(ctx, [message], agent)
  const second = runPreStep(ctx, [message], agent)
  // Both handlers reached the ask step while it is still pending.
  assert.equal(questions.calls.length, 1)
  release()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(questions.calls.length, 1)
  assert.equal(firstResult.nextCalls.length, 1)
  assert.equal(secondResult.nextCalls.length, 1)
})

test('k. enabled:false registers nothing', () => {
  const commands = makeCommands()
  const projections = makeProjections()
  const { ctx, questions } = makeHarness({ config: { enabled: false }, commands, projections })
  assert.equal(ctx.onCalls.length, 0)
  assert.equal(questions.calls.length, 0)
  assert.equal(commands.calls.register.length, 0)
  assert.equal(projections.calls.register.length, 0)
  assert.equal(readStatus().config.enabled, false)
})

test('l. a session override of enabled:false skips the card for that session only', async () => {
  const projections = makeProjections((session) => (session?.id === 'session-off'
    ? { enabled: false, timeoutSeconds: null }
    : { enabled: null, timeoutSeconds: null }))
  const { ctx, questions } = makeHarness({ projections })

  const off = await runPreStep(ctx, [goalMessage(3)], makeAgent({ id: 'session-off' }))
  assert.equal(off.nextCalls.length, 1)
  assert.equal(questions.calls.length, 0)
  assert.equal(readStatus().skipped, 'session-off')

  const on = await runPreStep(ctx, [goalMessage(3)], makeAgent({ id: 'session-on' }))
  assert.equal(on.nextCalls.length, 1)
  assert.equal(questions.calls.length, 1)
})

test('m. a session timeout override reaches the card detail', async () => {
  const projections = makeProjections(() => ({ enabled: true, timeoutSeconds: 2 }))
  const { ctx, questions } = makeHarness({ projections })
  const { nextCalls } = await runPreStep(ctx, [goalMessage(3)])
  assert.equal(questions.calls.length, 1)
  assert.match(questions.calls[0].questions[0].detail, /2 秒无操作将自动继续/)
  assert.equal(nextCalls.length, 1)
})

test('n. a wait session asks without a timer and survives a live client', async () => {
  const projections = makeProjections(() => ({ enabled: true, timeoutSeconds: 0 }))
  const gateway = { hasLiveClient: () => true }
  const { ctx, questions } = makeHarness({ projections, gateway })
  const startedAt = Date.now()
  const { nextCalls } = await runPreStep(ctx, [goalMessage(3)])
  assert.ok(Date.now() - startedAt < 1000, 'a wait ask must not arm the timeout timer')
  assert.equal(questions.calls.length, 1)
  assert.match(questions.calls[0].questions[0].detail, /等待人工确认/)
  assert.equal(nextCalls.length, 1)
})

test('n2. a wait session with no live client passes the round through', async () => {
  const projections = makeProjections(() => ({ enabled: true, timeoutSeconds: 0 }))
  const gateway = { hasLiveClient: () => false }
  const { ctx, questions } = makeHarness({ projections, gateway })
  const { nextCalls } = await runPreStep(ctx, [goalMessage(3)])
  assert.equal(questions.calls.length, 0)
  assert.equal(nextCalls.length, 1)
  assert.equal(readStatus().skipped, 'no-live-client')
})

test('o. the card session-off option records off through the command and continues', async () => {
  const commands = makeCommands()
  const questions = makeQuestions(() => ({ answers: [{ id: 'goal-round', selected: [SESSION_OFF_LABEL] }] }))
  const { ctx } = makeHarness({ commands, questions })
  const agent = makeAgent()
  const { nextCalls } = await runPreStep(ctx, [goalMessage(3)], agent)

  assert.equal(commands.calls.execute.length, 1)
  assert.equal(commands.calls.execute[0].agent, agent)
  assert.equal(commands.calls.execute[0].line, '/goal-confirm off')
  assert.equal(nextCalls.length, 1)
  assert.equal(readStatus().action, 'continue-off')

  // The next round in the same session no longer asks.
  const second = await runPreStep(ctx, [goalMessage(4, { id: 'm2' })], agent)
  assert.equal(second.nextCalls.length, 1)
  assert.equal(questions.calls.length, 1)
})

test('o2. a failing command service falls back to the in-memory switch', async () => {
  const commands = {
    calls: [],
    register() {
      return () => {}
    },
    async execute() {
      throw errorWith('COMMAND_FAILED')
    },
  }
  const logger = { warnings: [], warn(message) { this.warnings.push(message) } }
  const questions = makeQuestions(() => ({ answers: [{ id: 'goal-round', selected: [SESSION_OFF_LABEL] }] }))
  const { ctx } = makeHarness({ commands, questions, logger })
  const agent = makeAgent()
  await runPreStep(ctx, [goalMessage(3)], agent)
  assert.ok(logger.warnings.some((message) => /off failed/.test(message)))

  const second = await runPreStep(ctx, [goalMessage(4, { id: 'm2' })], agent)
  assert.equal(second.nextCalls.length, 1)
  assert.equal(questions.calls.length, 1)
})

test('p. activation registers /goal-confirm and its handler reports the session state', async () => {
  const commands = makeCommands()
  const { ctx, questions } = makeHarness({ commands })
  assert.equal(commands.calls.register.length, 1)
  const definition = commands.calls.register[0]
  assert.equal(definition.name, 'goal-confirm')
  assert.equal(typeof definition.handler, 'function')

  const agent = makeAgent()
  const off = await definition.handler({ agent, rawInput: ' off ' })
  assert.equal(off.kind, 'success')
  assert.match(off.text, /本会话：关闭/)
  const status = await definition.handler({ agent, rawInput: '' })
  assert.match(status.text, /Goal 续轮确认：关闭（本会话不弹卡）/)
  const bad = await definition.handler({ agent, rawInput: 'nope' })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /on\|off\|wait\|timeout/)

  // The switch is in memory even without a projection: the next round skips.
  const result = await runPreStep(ctx, [goalMessage(3)], agent)
  assert.equal(result.nextCalls.length, 1)
  assert.equal(questions.calls.length, 0)
})

test('p2. /goal-confirm wait without a projection still asks without a timer', async () => {
  const commands = makeCommands()
  const { ctx, questions } = makeHarness({ commands })
  const agent = makeAgent()
  const definition = commands.calls.register[0]
  await definition.handler({ agent, rawInput: 'wait' })

  const { nextCalls } = await runPreStep(ctx, [goalMessage(3)], agent)
  assert.equal(questions.calls.length, 1)
  assert.match(questions.calls[0].questions[0].detail, /等待人工确认/)
  assert.equal(nextCalls.length, 1)
})

test('q. the session projection folds command/run and exposes a stable wire view', () => {
  const projections = makeProjections()
  makeHarness({ projections })
  assert.equal(projections.calls.register.length, 1)
  const definition = projections.calls.register[0]
  assert.equal(definition.key, 'goal-confirm')
  assert.equal(definition.stateVersion, 1)
  assert.deepEqual(definition.init(), { enabled: null, timeoutSeconds: null })

  const initial = definition.init()
  const off = definition.apply(initial, { type: 'command/run', data: { name: 'goal-confirm', args: 'off' } })
  assert.deepEqual(off, { enabled: false, timeoutSeconds: null })
  const wait = definition.apply(off, { type: 'command/run', data: { name: 'goal-confirm', args: 'wait' } })
  assert.deepEqual(wait, { enabled: true, timeoutSeconds: 0 })
  const reset = definition.apply(wait, { type: 'command/run', data: { name: 'goal-confirm', args: 'reset' } })
  assert.deepEqual(reset, { enabled: null, timeoutSeconds: null })

  // Ignored events keep the exact reference, so the projection does no work.
  assert.equal(definition.apply(off, { type: 'assistant/message' }), off)
  assert.equal(definition.apply(off, { type: 'command/run', data: { name: 'goal' } }), off)

  const view = definition.wire.view(off)
  assert.deepEqual(view, { enabled: false, timeoutSeconds: null, global: { enabled: true, timeoutSeconds: 30 } })
  assert.equal(definition.wire.view(off), view)
  assert.equal(definition.stateSchema.parse(off), off)
  assert.equal(definition.wire.viewSchema.parse(view), view)
  assert.throws(() => definition.stateSchema.parse({ enabled: 'yes' }), /invalid state projection value/)
  assert.equal(definition.stateSchema.safeParse({ enabled: 'yes' }).success, false)
})

test('r. a projection read that throws falls back to the default without blocking', async () => {
  const logger = { warnings: [], warn(message) { this.warnings.push(message) } }
  const projections = {
    calls: { register: [] },
    register() {
      return () => {}
    },
    stateOf() {
      throw new Error('projection unavailable')
    },
  }
  const { ctx, questions } = makeHarness({ projections, logger })
  const result = await runPreStep(ctx, [goalMessage(3)])
  assert.equal(result.nextCalls.length, 1)
  assert.equal(questions.calls.length, 1)
  assert.ok(logger.warnings.some((message) => /could not read the goal-confirm projection/.test(message)))
})

test('invalid config throws at activation and registers nothing', () => {
  const ctx = makeCtx({})
  assert.throws(() => apply(ctx, { timeoutSeconds: -1 }), /timeoutSeconds must be an integer/)
  assert.throws(() => apply(ctx, { typo: true }), /unknown config key/)
  assert.equal(ctx.onCalls.length, 0)
})
