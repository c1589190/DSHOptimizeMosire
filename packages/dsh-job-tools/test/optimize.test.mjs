import test from 'node:test'
import assert from 'node:assert/strict'

import {
  byteLength,
  collapseCarriageReturns,
  dedupeAdjacent,
  normalizeOutput,
  optimizeJobOutput,
  stripTerminalNoise,
} from '../lib/optimize.js'

test('strips ANSI colors and OSC hyperlinks but keeps the text', () => {
  const input = '\u001b[31mred\u001b[0m \u001b]8;;https://example.com\u0007link\u001b]8;;\u0007'
  assert.equal(stripTerminalNoise(input), 'red link')
})

test('collapses carriage-return progress to the last non-empty segment', () => {
  assert.equal(collapseCarriageReturns('download 10%\rdownload 55%\rdownload 100%\n'), 'download 100%\n')
  assert.equal(collapseCarriageReturns('a\rb\rc'), 'c')
  assert.equal(collapseCarriageReturns('plain\n'), 'plain\n')
})

test('normalizes control bytes, trailing spaces, and blank-line runs', () => {
  const input = 'a\x00\x08  \n\n\n\nb\r\n'
  assert.equal(normalizeOutput(input), 'a\n\nb')
})

test('dedupes only adjacent identical lines and counts them', () => {
  assert.deepEqual(dedupeAdjacent(['a', 'a', 'a', 'b', 'a']), {
    lines: ['a (×3)', 'b', 'a'],
    deduped: 2,
  })
  assert.deepEqual(dedupeAdjacent([]), { lines: [], deduped: 0 })
})

test('raw mode is byte-for-byte unchanged', () => {
  const input = '\u001b[31mred\u001b[0m\rprogress\n'
  const result = optimizeJobOutput(input, { mode: 'raw', maxBytes: 1 })
  assert.equal(result.text, input)
  assert.equal(result.mode, 'raw')
  assert.equal(result.outputBytes, byteLength(input))
})

test('auto uses full while the output fits, then summary with omitted markers', () => {
  const small = 'line 1\nline 2\n'
  assert.equal(optimizeJobOutput(small, { mode: 'auto', lines: 10 }).mode, 'full')

  const many = Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n')
  const result = optimizeJobOutput(many, { mode: 'auto', lines: 10, maxBytes: 4096 })
  assert.equal(result.mode, 'summary')
  assert.match(result.text, /line 0/u)
  assert.match(result.text, /line 59/u)
  assert.match(result.text, /omitted/u)
  assert.ok(result.omittedLines > 0)
})

test('tail and head keep the requested line budget', () => {
  const input = 'a\nb\nc\nd\ne\n'
  assert.equal(optimizeJobOutput(input, { mode: 'tail', lines: 2 }).text, 'd\ne')
  assert.equal(optimizeJobOutput(input, { mode: 'head', lines: 2 }).text, 'a\nb')
})

test('errors keeps error-like lines with one line of context', () => {
  const input = 'start\nok\nerror: boom\ntraceback line\nafter\n'
  const result = optimizeJobOutput(input, { mode: 'errors' })
  assert.match(result.text, /ok/u)
  assert.match(result.text, /error: boom/u)
  assert.match(result.text, /traceback line/u)
  assert.equal(result.matchedErrors, 2)
  assert.doesNotMatch(result.text, /^start/u)
})

test('byte cap keeps head and tail with an explicit omitted marker', () => {
  const input = Array.from({ length: 200 }, (_, index) => `row ${index} ${'x'.repeat(20)}`).join('\n')
  const result = optimizeJobOutput(input, { mode: 'full', maxBytes: 1024 })
  assert.ok(result.outputBytes <= 1024)
  assert.match(result.text, /\[optimized: omitted/u)
  assert.match(result.text, /row 0 /u)
  assert.match(result.text, /row 199 /u)
  assert.ok(result.omittedBytes > 0)
})
