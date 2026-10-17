import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CANCEL_LABEL,
  CONTINUE_LABEL,
  DEFAULT_CONFIG,
  buildQuestion,
  decideOutcome,
  normalizeConfig,
  summarizeObjective,
} from '../lib/decision.js'

test('normalizeConfig: missing, null and empty config all mean the defaults', () => {
  assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG)
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG)
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG)
  assert.deepEqual(normalizeConfig({ enabled: true, timeoutSeconds: 30, cancelOnClose: true }), DEFAULT_CONFIG)
})

test('normalizeConfig: non-object config is rejected', () => {
  for (const invalid of ['enabled', 42, true, [], () => {}]) {
    assert.throws(() => normalizeConfig(invalid), /config must be an object/)
  }
})

test('normalizeConfig: unknown keys are rejected', () => {
  assert.throws(() => normalizeConfig({ timeout: 5 }), /unknown config key\(s\) timeout/)
  assert.throws(() => normalizeConfig({ enabled: true, cancelOnClose: false, scope: 'all' }), /unknown config key\(s\) scope/)
})

test('normalizeConfig: enabled and cancelOnClose must be booleans', () => {
  assert.throws(() => normalizeConfig({ enabled: 'yes' }), /enabled must be a boolean/)
  assert.throws(() => normalizeConfig({ enabled: 1 }), /enabled must be a boolean/)
  assert.throws(() => normalizeConfig({ cancelOnClose: 0 }), /cancelOnClose must be a boolean/)
  assert.throws(() => normalizeConfig({ cancelOnClose: 'false' }), /cancelOnClose must be a boolean/)
})

test('normalizeConfig: timeoutSeconds must be an integer in 1..3600', () => {
  for (const invalid of [0, -1, 3601, 1.5, Number.NaN, '30', Infinity]) {
    assert.throws(() => normalizeConfig({ timeoutSeconds: invalid }), /timeoutSeconds must be an integer between 1 and 3600/)
  }
  assert.equal(normalizeConfig({ timeoutSeconds: 1 }).timeoutSeconds, 1)
  assert.equal(normalizeConfig({ timeoutSeconds: 3600 }).timeoutSeconds, 3600)
})

test('normalizeConfig: valid values are preserved', () => {
  assert.deepEqual(normalizeConfig({ enabled: false, timeoutSeconds: 5, cancelOnClose: false }), {
    enabled: false,
    timeoutSeconds: 5,
    cancelOnClose: false,
  })
})

test('buildQuestion: exact header, id, labels and round text', () => {
  const question = buildQuestion({ round: 3, maxGoalRounds: 5, objective: 'ship the gate', timeoutSeconds: 30 })
  assert.equal(question.id, 'goal-round')
  assert.equal(question.header, 'Goal 续轮')
  assert.equal(question.question, '第 3 轮（上限 5）自动续轮：确认继续？')
  assert.match(question.question, /第 3 轮（上限 5）/)
  assert.equal(CONTINUE_LABEL, '继续自动推进')
  assert.equal(CANCEL_LABEL, '取消并删除 goal')
  assert.deepEqual(question.options.map((option) => option.label), [CONTINUE_LABEL, CANCEL_LABEL])
  assert.equal(question.options.length, 2)
  for (const option of question.options) assert.equal(typeof option.description, 'string')
})

test('buildQuestion: detail carries the timeout and an objective summary', () => {
  const question = buildQuestion({ round: 1, maxGoalRounds: 3, objective: '  build\n the  confirmation gate  ', timeoutSeconds: 5 })
  assert.match(question.detail, /5 秒无操作将自动继续/)
  assert.match(question.detail, /目标：build the confirmation gate/)
  assert.match(question.detail, /关闭本卡片视为取消并删除 goal/)
})

test('summarizeObjective: collapses whitespace and truncates with an ellipsis', () => {
  assert.equal(summarizeObjective('  a\n\t b  '), 'a b')
  assert.equal(summarizeObjective(undefined), '')
  const long = 'x'.repeat(500)
  const summary = summarizeObjective(long, 20)
  assert.equal(summary.length, 20)
  assert.ok(summary.endsWith('…'))
  assert.equal(summary.slice(0, 19), 'x'.repeat(19))
})

test('decideOutcome: answers map by exact option label', () => {
  const config = { cancelOnClose: true }
  assert.equal(decideOutcome({ kind: 'answer', selected: [CANCEL_LABEL] }, config), 'cancel')
  assert.equal(decideOutcome({ kind: 'answer', selected: [CONTINUE_LABEL, CANCEL_LABEL] }, config), 'cancel')
  assert.equal(decideOutcome({ kind: 'answer', selected: [CONTINUE_LABEL] }, config), 'continue')
  assert.equal(decideOutcome({ kind: 'answer', selected: [] }, config), 'continue')
  assert.equal(decideOutcome({ kind: 'answer' }, config), 'continue')
  assert.equal(decideOutcome({ kind: 'answer', selected: undefined }, config), 'continue')
  assert.equal(decideOutcome({ kind: 'answer', selected: ['something else'] }, config), 'continue')
})

test('decideOutcome: closing the card follows cancelOnClose', () => {
  assert.equal(decideOutcome({ kind: 'error', code: 'ASK_CANCELLED' }, { cancelOnClose: true }), 'cancel')
  assert.equal(decideOutcome({ kind: 'error', code: 'ASK_CANCELLED' }, { cancelOnClose: false }), 'continue')
})

test('decideOutcome: timeouts, delegation, missing providers and unknown errors continue', () => {
  const bothConfigs = [{ cancelOnClose: true }, { cancelOnClose: false }]
  const codes = ['ASK_ABORTED', 'ASK_TIMED_OUT', 'DELEGATED_CALLER', 'NO_PROVIDER', 'CALLER_NOT_LIVE', 'SOMETHING_ELSE', undefined]
  for (const config of bothConfigs) {
    for (const code of codes) {
      assert.equal(decideOutcome({ kind: 'error', code }, config), 'continue', `code=${String(code)}`)
    }
  }
  assert.equal(decideOutcome({ kind: 'error' }, { cancelOnClose: true }), 'continue')
})
