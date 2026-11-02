import test from 'node:test'
import assert from 'node:assert/strict'
import { buildZip } from './helpers/zip-builder.mjs'
import { isZip, readZipEntries, ZipError } from '../lib/zip.js'

test('reads stored and deflated entries', () => {
  const zip = buildZip([
    { name: 'session.v4.jsonl', data: Buffer.from('{"type":"session"}\n'), method: 0 },
    { name: 'media/sha256:ab.png', data: Buffer.from('PNG'), method: 8 },
  ])
  assert.equal(isZip(zip), true)
  const entries = readZipEntries(zip)
  assert.equal(entries.get('session.v4.jsonl').toString(), '{"type":"session"}\n')
  assert.equal(entries.get('media/sha256:ab.png').toString(), 'PNG')
})

test('reads entries whose local header defers sizes to a data descriptor', () => {
  const zip = buildZip([
    { name: 'session.v4.jsonl', data: Buffer.from('{"type":"session"}\n'), method: 8, flags: 0x08, localZeros: true },
  ])
  const entries = readZipEntries(zip)
  assert.equal(entries.get('session.v4.jsonl').toString(), '{"type":"session"}\n')
})

test('rejects encrypted entries', () => {
  const zip = buildZip([{ name: 'a', data: Buffer.from('x'), method: 0, flags: 0x01 }])
  assert.throws(() => readZipEntries(zip), ZipError)
})

test('rejects zip64 sizes', () => {
  const zip = buildZip([{ name: 'a', data: Buffer.from('x'), method: 0, forceZip64: true }])
  assert.throws(() => readZipEntries(zip), ZipError)
})

test('rejects trailing garbage and truncated archives', () => {
  const zip = buildZip([{ name: 'a', data: Buffer.from('x'), method: 0 }])
  assert.throws(() => readZipEntries(Buffer.concat([zip, Buffer.from('junk')])), ZipError)
  assert.throws(() => readZipEntries(zip.subarray(0, zip.length - 4)), ZipError)
})

test('rejects a non-zip buffer', () => {
  assert.equal(isZip(Buffer.from('not a zip')), false)
  assert.throws(() => readZipEntries(Buffer.from('not a zip')), ZipError)
})
