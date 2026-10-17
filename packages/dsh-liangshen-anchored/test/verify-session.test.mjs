import test from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import {
  analyzeSession,
  decodeSessionBuffer,
  splitZstdFrames,
} from '../../../tools/verify-session.mjs'

const BOOTSTRAP = ['bash', 'str_replace_editor']
const FULL = ['bash', 'str_replace_editor', 'read', 'write', 'edit', 'todo_write']
const persona = 'You are a helpful software engineer assistant.'
const EMPTY_PRESET = 'liangshen-empty-system'
const EMPTY_SYSTEM_PROMPT = ' '

const sessionHeader = (preset = 'liangshen', delegationDepth = 0) => ({
  type: 'session', version: 4, id: 'session-test', cwd: '/tmp', agentPreset: preset, delegationDepth,
})
const userMessage = (seq, kind = 'user') => ({
  type: 'user/message', seq, data: { message: { role: 'user', source: { kind }, content: [] } },
})
const systemMessage = (seq, text) => ({
  type: 'system/message', seq,
  data: { message: { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] } },
})
const requestHeader = (seq, tools) => ({
  type: 'request/header', seq, data: { header: { tools: tools.map((name) => ({ name })) }, reason: 'initial' },
})
const signal = (seq, type = 'tool/call') => ({ type, seq })
const selection = (seq, preset) => ({ type: 'agent-preset/selected', seq, data: { agentPreset: preset } })

function goodSession(overrides = {}) {
  return [
    sessionHeader(overrides.preset, overrides.delegationDepth),
    userMessage(2),
    systemMessage(3, overrides.systemText ?? persona),
    requestHeader(4, overrides.firstTools ?? BOOTSTRAP),
    signal(5),
    requestHeader(6, overrides.promotedTools ?? FULL),
    { type: 'compaction/end', seq: 7 },
    requestHeader(8, overrides.reanchorTools ?? BOOTSTRAP),
    ...(overrides.extra ?? []),
  ]
}

/** A faithful empty-system session: same protocol, system prompt is one space. */
function emptySystemSession(overrides = {}) {
  return goodSession({
    preset: EMPTY_PRESET,
    systemText: EMPTY_SYSTEM_PROMPT,
    ...overrides,
  })
}

test('a faithful anchored session passes every check', () => {
  const report = analyzeSession(goodSession())
  assert.deepEqual(report.failures, [])
  assert.ok(report.checks.every((check) => check.ok))
})

test('a wider first request fails the anchor check', () => {
  const report = analyzeSession(goodSession({ firstTools: FULL }))
  assert.match(report.failures.join('\n'), /Minimal tool pair/)
})

test('injected first-step context fails the injection check', () => {
  const events = goodSession({ extra: [] })
  events.splice(1, 0, userMessage(2, 'agent-instructions'), userMessage(2, 'runtime-context'))
  const report = analyzeSession(events)
  assert.match(report.failures.join('\n'), /auto-injected context/)
})

test('harness identity in the system prompt fails the minimal prompt check', () => {
  const report = analyzeSession(goodSession({ systemText: 'You are an AI agent powered by DeepSeek Harness.' }))
  assert.match(report.failures.join('\n'), /minimal persona/)
  assert.match(report.failures.join('\n'), /harness identity/)
})

test('a promoted request that stays at the bootstrap pair fails', () => {
  const report = analyzeSession(goodSession({ promotedTools: BOOTSTRAP }))
  assert.match(report.failures.join('\n'), /promotion widens/)
})

test('a post-compaction request that stays wide fails re-anchor', () => {
  const report = analyzeSession(goodSession({ reanchorTools: FULL }))
  assert.match(report.failures.join('\n'), /compaction re-anchor/)
})

test('a selection event before the first turn overrides the creation-time default', () => {
  const session = goodSession()
  session[0] = sessionHeader('standard') // creation default
  session.splice(1, 0, selection(1, 'liangshen'))
  const report = analyzeSession(session)
  assert.equal(report.preset, 'liangshen')
  assert.deepEqual(report.failures, [])
})

test('user-approval messages in the first step are user-originated and allowed', () => {
  const session = goodSession()
  session.splice(1, 0, userMessage(2, 'user-approval'), userMessage(2, 'user-approval'))
  const report = analyzeSession(session)
  assert.deepEqual(report.failures, [])
})

test('a preset mismatch fails', () => {
  const report = analyzeSession(goodSession({ preset: 'standard' }))
  assert.match(report.failures.join('\n'), /agent preset/)
})

test('subagent sessions are held to the same anchor', () => {
  const good = analyzeSession(goodSession({ delegationDepth: 1 }))
  assert.deepEqual(good.failures, [])
  const bad = analyzeSession(goodSession({ delegationDepth: 1, firstTools: FULL }))
  assert.match(bad.failures.join('\n'), /subagent first request/)
})

test('sessions without a promotion signal or compaction are reported as skipped', () => {
  const events = [sessionHeader(), userMessage(2), systemMessage(3, persona), requestHeader(4, BOOTSTRAP)]
  const report = analyzeSession(events)
  assert.deepEqual(report.failures, [])
  assert.equal(report.checks.find((check) => check.name === 'promotion observed')?.skipped, true)
  assert.equal(report.checks.find((check) => check.name === 'compaction re-anchor')?.skipped, true)
  assert.ok(report.warnings.length >= 2)
})

test('concatenated zstd frames decode to all rows', () => {
  const rows = goodSession()
  const batches = [rows.slice(0, 1), rows.slice(1, 4), rows.slice(4)]
  const buf = Buffer.concat(batches.map((batch) => zstdCompressSync(Buffer.from(batch.map((row) => JSON.stringify(row)).join('\n')))))
  assert.equal(splitZstdFrames(buf).length, 3)
  assert.deepEqual(decodeSessionBuffer(buf), rows)
})

test('a corrupt frame prefix is rejected', () => {
  assert.throws(() => splitZstdFrames(Buffer.from([0, 1, 2, 3])), /bad zstd magic/)
})

test('an empty-system session auto-selects space mode and passes every check', () => {
  const report = analyzeSession(emptySystemSession())
  assert.equal(report.preset, EMPTY_PRESET)
  assert.equal(report.systemPrompt, 'space')
  assert.deepEqual(report.failures, [])
  const emptyCheck = report.checks.find((check) => check.name === 'empty system prompt is a single space')
  assert.equal(emptyCheck?.ok, true)
  assert.equal(emptyCheck?.detail, 'system text is " " (expected exactly one ASCII space)')
  assert.equal(
    report.checks.find((check) => check.name === 'harness identity is absent from the first system prompt')?.ok,
    true,
  )
})

test('empty-system events analyzed as the persona preset do not pass', () => {
  const report = analyzeSession(emptySystemSession(), { preset: 'liangshen' })
  assert.equal(report.systemPrompt, 'persona')
  assert.notDeepEqual(report.failures, [])
  assert.match(report.failures.join('\n'), /minimal persona is the first system prompt/)
  // Persona mode must not silently accept the empty variant via the space check.
  assert.ok(report.checks.every((check) => check.name !== 'empty system prompt is a single space'))
  assert.equal(report.checks.find((check) => check.name === 'minimal persona is the first system prompt')?.ok, false)
})

test('a persona session analyzed with the space override fails the single-space check', () => {
  const report = analyzeSession(goodSession(), { systemPrompt: 'space' })
  assert.equal(report.systemPrompt, 'space')
  assert.notDeepEqual(report.failures, [])
  assert.match(report.failures.join('\n'), /empty system prompt is a single space/)
  assert.ok(report.failures.every((failure) => !failure.startsWith('minimal persona')))
})

test('a trimmed (empty-string) system prompt fails the single-space check (D1 deviation)', () => {
  // The adapter trims a lone space to '' in the real wire; the verifier asserts
  // the documented D1 behaviour explicitly instead of quietly widening to <= 1.
  const report = analyzeSession(emptySystemSession({ systemText: '' }))
  assert.notDeepEqual(report.failures, [])
  assert.match(report.failures.join('\n'), /empty system prompt is a single space/)
  assert.match(report.failures.join('\n'), /system text is ""/)
})

test('an unknown system prompt mode is rejected instead of silently passing', () => {
  assert.throws(
    () => analyzeSession(emptySystemSession(), { systemPrompt: 'none' }),
    /unknown system prompt mode "none"; expected persona or space/,
  )
})
