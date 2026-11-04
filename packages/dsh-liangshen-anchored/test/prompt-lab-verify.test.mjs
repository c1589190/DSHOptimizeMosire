import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PERSONA_LINE,
  analyzePromptLabSession,
  effectiveSystemNodes,
  sha256,
} from '../../../tools/verify-prompt-lab.mjs'

const header = { type: 'session', seq: 1, id: 'session-lab', agentPreset: 'minimal-prompt-lab' }
const user = (seq) => ({
  type: 'user/message',
  seq,
  data: { source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
})
const system = (seq, text, surfaceOp) => ({
  type: 'system/message',
  seq,
  ...(surfaceOp === undefined ? {} : { surfaceOp }),
  data: { message: { role: 'system', content: text === '' ? [] : [{ type: 'text', text }] } },
})
const request = (seq) => ({
  type: 'request/header',
  seq,
  data: { header: { tools: [{ name: 'bash' }, { name: 'read_image' }] } },
})

test('a fresh session with the default persona line passes', () => {
  const events = [header, user(2), system(3, PERSONA_LINE), request(4)]
  const report = analyzePromptLabSession(events)
  assert.equal(report.preset, 'minimal-prompt-lab')
  assert.equal(report.nonEmptySystemNodes, 1)
  assert.deepEqual(report.failures, [])
})

test('a hard switch replaces the head and keeps exactly one non-empty node', () => {
  const events = [
    header,
    user(2),
    system(3, 'OLD PROMPT\n'),
    request(4),
    user(5),
    system(6, 'NEW PROMPT\n', { op: 'replace', startSeq: 3, endSeq: 3 }),
    request(7),
  ]
  const nodes = effectiveSystemNodes(events)
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].text, 'NEW PROMPT\n')
  const dir = mkdtempSync(join(tmpdir(), 'prompt-lab-verify-'))
  try {
    const initial = join(dir, 'initial.md')
    const next = join(dir, 'next.md')
    writeFileSync(initial, 'OLD PROMPT\n')
    writeFileSync(next, 'NEW PROMPT\n')
    const report = analyzePromptLabSession(events, { systemFile: next, initialFile: initial })
    assert.equal(report.headSha256, sha256('NEW PROMPT\n'))
    assert.deepEqual(report.failures, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the native append shape fails the single-node invariant', () => {
  const events = [
    header,
    user(2),
    system(3, 'OLD PROMPT\n'),
    request(4),
    user(5),
    system(6, 'NEW PROMPT\n'),
    request(7),
  ]
  const report = analyzePromptLabSession(events)
  assert.equal(report.nonEmptySystemNodes, 2)
  assert.ok(report.failures.some((failure) => failure.includes('exactly one non-empty system node')))
})

test('a sha256 mismatch fails', () => {
  const events = [header, user(2), system(3, PERSONA_LINE), request(4)]
  const report = analyzePromptLabSession(events, { systemSha256: '0'.repeat(64) })
  assert.ok(report.failures.some((failure) => failure.includes('sha256')))
})

test('harness identity in the prompt fails', () => {
  const events = [header, user(2), system(3, 'You are an AI agent powered by DeepSeek Harness'), request(4)]
  const report = analyzePromptLabSession(events)
  assert.ok(report.failures.some((failure) => failure.includes('harness identity')))
})

test('a missing request header is reported as a failure', () => {
  const events = [header, user(2), system(3, PERSONA_LINE)]
  const report = analyzePromptLabSession(events)
  assert.ok(report.failures.some((failure) => failure.includes('first request header')))
})

test('a session from another preset fails the preset check', () => {
  const events = [{ ...header, agentPreset: 'liangshen' }, user(2), system(3, PERSONA_LINE), request(4)]
  const report = analyzePromptLabSession(events)
  assert.ok(report.failures.some((failure) => failure.includes('agent preset')))
})
