/**
 * Session-log decoding: magic sniffing, multi-frame zstd, and JSONL parsing.
 *
 * A DSH log on disk is a sequence of independent Zstandard frames (one per
 * write batch). Node's streaming decoder stops at the first frame, so frames
 * are split on the zstd magic and decompressed one by one.
 */
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ZIP_MAGIC = 0x04034b50
const SESSION_FORMAT_VERSION = 4

/** Raised when a log is not a format this importer understands. */
export class DecodeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DecodeError'
  }
}

/**
 * @param {Buffer} buffer
 * @returns {'zip'|'zstd'|'jsonl'}
 */
export function sniffLog(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new DecodeError('empty input')
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZIP_MAGIC) return 'zip'
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(ZSTD_MAGIC)) return 'zstd'
  let start = 0
  while (start < buffer.length && [0x20, 0x09, 0x0a, 0x0d].includes(buffer[start])) start += 1
  if (buffer[start] === 0x7b) return 'jsonl'
  throw new DecodeError('unrecognized session log format (expected zip, zstd or JSONL)')
}

/**
 * @param {Buffer} buffer - one or more concatenated zstd frames.
 * @returns {Buffer} concatenated plaintext.
 */
export function decodeZstdFrames(buffer) {
  const offsets = []
  let found = buffer.indexOf(ZSTD_MAGIC, 0)
  while (found !== -1) {
    offsets.push(found)
    found = buffer.indexOf(ZSTD_MAGIC, found + 4)
  }
  if (offsets.length === 0) throw new DecodeError('no zstd frame found')
  const parts = []
  let cursor = 0
  while (cursor < buffer.length) {
    if (!buffer.subarray(cursor, cursor + 4).equals(ZSTD_MAGIC)) {
      throw new DecodeError('trailing bytes between zstd frames')
    }
    let decoded
    let next = -1
    for (const end of offsets) {
      if (end <= cursor) continue
      try {
        decoded = zstdDecompressSync(buffer.subarray(cursor, end))
        next = end
        break
      } catch {
        // A magic byte inside compressed data splits the frame early; extend.
      }
    }
    if (decoded === undefined) {
      try {
        decoded = zstdDecompressSync(buffer.subarray(cursor))
        next = buffer.length
      } catch (error) {
        throw new DecodeError(`corrupt zstd frame: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    parts.push(decoded)
    cursor = next
  }
  return Buffer.concat(parts)
}

/**
 * @param {string} text - newline-delimited JSON (header line first).
 * @param {string} [location] - included in error messages.
 * @returns {{ header: object, events: object[] }}
 */
export function parseSessionLog(text, location = '') {
  const where = location === '' ? '' : ` (${location})`
  const lines = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    lines.push(raw)
  }
  if (lines.length === 0) throw new DecodeError(`empty session log${where}`)
  const header = parseLine(lines[0], 1, where)
  validateHeader(header, where)
  const events = []
  for (let index = 1; index < lines.length; index += 1) {
    events.push(parseLine(lines[index], index + 1, where))
  }
  return { header, events }
}

function parseLine(line, lineNumber, where) {
  try {
    const value = JSON.parse(line)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('a JSON object is required')
    }
    return value
  } catch (error) {
    throw new DecodeError(
      `invalid session log at line ${lineNumber}${where}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function validateHeader(header, where) {
  if (header.type !== 'session') throw new DecodeError(`first line is not a session header${where}`)
  if (header.version !== SESSION_FORMAT_VERSION) {
    throw new DecodeError(`unsupported session format version ${String(header.version)}${where} (expected 4)`)
  }
  if (typeof header.id !== 'string' || header.id.length === 0) throw new DecodeError(`session header has no id${where}`)
  if (!Number.isSafeInteger(header.createdAt)) throw new DecodeError(`session header has no createdAt${where}`)
}
