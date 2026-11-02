import test from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import { buildZip } from './helpers/zip-builder.mjs'
import { sniffLog, decodeZstdFrames, parseSessionLog, DecodeError } from '../lib/decode.js'

const HEADER = { type: 'session', version: 4, id: 'session-a', createdAt: 1, cwd: '/tmp/ws', isSeeded: false }
const line = (value) => Buffer.from(`${JSON.stringify(value)}\n`)

test('sniffs zip, zstd and jsonl by magic', () => {
  const zip = buildZip([{ name: 'a', data: Buffer.from('x'), method: 0 }])
  assert.equal(sniffLog(zip), 'zip')
  assert.equal(sniffLog(zstdCompressSync(line(HEADER))), 'zstd')
  assert.equal(sniffLog(Buffer.from(`  ${JSON.stringify(HEADER)}\n`)), 'jsonl')
  assert.throws(() => sniffLog(Buffer.from('nope')), DecodeError)
})

test('decodes concatenated zstd frames', () => {
  const a = zstdCompressSync(line(HEADER))
  const b = zstdCompressSync(line({ type: 'user/message', seq: 0, time: 1, data: {} }))
  assert.equal(
    decodeZstdFrames(Buffer.concat([a, b])).toString(),
    `${JSON.stringify(HEADER)}\n{"type":"user/message","seq":0,"time":1,"data":{}}\n`,
  )
})

test('rejects version 3 and non-session first lines', () => {
  assert.throws(() => parseSessionLog(`${JSON.stringify({ ...HEADER, version: 3 })}\n`), DecodeError)
  assert.throws(() => parseSessionLog(`${JSON.stringify({ type: 'event' })}\n`), DecodeError)
  assert.throws(() => parseSessionLog('not json\n'), DecodeError)
})

test('parses a header plus events and reports bad line numbers', () => {
  const text = `${JSON.stringify(HEADER)}\n${JSON.stringify({ type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } })}\n`
  const parsed = parseSessionLog(text)
  assert.equal(parsed.header.id, 'session-a')
  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.events[0].seq, 0)

  const broken = `${JSON.stringify(HEADER)}\n${JSON.stringify({ type: 'turn/start', seq: 0, time: 2, data: {} })}\n{"type":\n`
  assert.throws(() => parseSessionLog(broken), /line 3/u)
})
