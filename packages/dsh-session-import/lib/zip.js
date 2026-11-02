/**
 * Dependency-free ZIP reader for DSH session exports.
 *
 * The export package writes a streaming ZIP with fflate; entries may carry a
 * data descriptor (flag bit 3), so sizes are always taken from the central
 * directory, never from the local header. Only `stored` and `deflate` entries
 * are supported: an export never encrypts and never needs ZIP64.
 */
import { inflateRawSync } from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const EOCD_SIZE = 22
const MAX_COMMENT = 0xffff
/** Hard ceiling on decompressed bytes so a crafted archive cannot exhaust memory. */
const MAX_TOTAL_BYTES = 1024 ** 3

/** Raised for any archive this reader refuses to interpret. */
export class ZipError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ZipError'
  }
}

/**
 * @param {Buffer} buffer
 * @returns {boolean} whether the buffer starts with a local file header.
 */
export function isZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.readUInt32LE(0) === SIG_LOCAL
}

/**
 * @param {Buffer} buffer - complete archive bytes.
 * @returns {Map<string, Buffer>} entry name to decompressed bytes, in central-directory order.
 */
export function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_SIZE) throw new ZipError('not a zip archive')
  const eocd = findEocd(buffer)
  const count = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError('zip64 archives are not supported')
  }
  if (centralOffset + centralSize > eocd) throw new ZipError('central directory exceeds archive bounds')

  const entries = new Map()
  let total = 0
  let cursor = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new ZipError(`central directory entry ${index} is malformed`)
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    if (flags & 0x1) throw new ZipError(`entry is encrypted: ${entryName(buffer, cursor, nameLength)}`)
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('zip64 entries are not supported')
    }
    if (method !== 0 && method !== 8) throw new ZipError(`unsupported compression method ${method}`)
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new ZipError(`entry ${index} has no local header`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new ZipError(`entry ${index} data exceeds archive bounds`)
    const raw = buffer.subarray(dataStart, dataEnd)
    let data
    if (method === 0) {
      data = Buffer.from(raw)
    } else {
      try {
        data = inflateRawSync(raw)
      } catch (error) {
        throw new ZipError(`entry ${index} failed to inflate: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (data.length !== uncompressedSize) throw new ZipError(`entry ${index} size mismatch`)
    total += data.length
    if (total > MAX_TOTAL_BYTES) throw new ZipError('archive decompresses beyond the 1 GiB limit')
    entries.set(entryName(buffer, cursor, nameLength), data)
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Locate the EOCD record and require it to end exactly at the buffer end. */
function findEocd(buffer) {
  const floor = Math.max(0, buffer.length - EOCD_SIZE - MAX_COMMENT)
  for (let offset = buffer.length - EOCD_SIZE; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== SIG_EOCD) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + EOCD_SIZE + commentLength === buffer.length) return offset
  }
  throw new ZipError('missing end of central directory (truncated archive)')
}

function entryName(buffer, centralOffset, nameLength) {
  return buffer.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8')
}
