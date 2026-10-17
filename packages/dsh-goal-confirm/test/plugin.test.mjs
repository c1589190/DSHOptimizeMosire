import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { CANCEL_LABEL, CONTINUE_LABEL } from '../lib/decision.js'

// Keep the diagnostic status file out of the real DSH_HOME.
const statusHome = mkdtempSync(join(tmpdir(), 'goal-confirm-test-'))
process.env.DSH_HOME = statusHome
const statusPath = join(statusHome, 'goal-confirm-status.json')

/** Minimal Cordis context: capture listeners, serve the two optional services. */
function makeCtx({ goals, questions, logger } = {}) {
  const onCalls = []
  const listeners = new Map()
  const services = { goals, userQuestions: questions }
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
  return { id, session: { header: { delegationDepth } } }
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
  const ctx = makeCtx({ goals, questions, logger: options.logger })
  apply(ctx, options.config ?? {})
  return { ctx, goals, questions }
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
  assert.deepEqual(request.questions[0].options.map((option) => option.label), [CONTINUE_LABEL, CANCEL_LABEL])

  const status = readStatus()
  assert.equal(status.activated, true)
  assert.equal(status.pid, process.pid)
  assert.equal(status.sessionId, 'session-1')
  assert.equal(status.round, 3)
  assert.equal(status.action, 'continue')
  assert.equal(status.outcome, 'answer')
  assert.equal(status.cleared, false)
  assert.ok(Date.parse(status.at) > 0)
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
  const { ctx, goals } = makeHarness({ questions, config: { timeoutSeconds: 1 } })
  const startedAt = Date.now()
  const result = await runPreStep(ctx, [goalMessage(3)])
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed >= 900, `the gate must wait for its timeout, waited ${elapsed}ms`)
  assert.ok(elapsed < 4000, `the gate must not hang, waited ${elapsed}ms`)
  assert.equal(questions.calls.length, 1)
  assert.equal(goals.calls.clear.length, 0)
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
  const { ctx, questions } = makeHarness({ config: { enabled: false } })
  assert.equal(ctx.onCalls.length, 0)
  assert.equal(questions.calls.length, 0)
  assert.equal(readStatus().config.enabled, false)
})

test('invalid config throws at activation and registers nothing', () => {
  const ctx = makeCtx({})
  assert.throws(() => apply(ctx, { timeoutSeconds: 0 }), /timeoutSeconds must be an integer/)
  assert.throws(() => apply(ctx, { typo: true }), /unknown config key/)
  assert.equal(ctx.onCalls.length, 0)
})
