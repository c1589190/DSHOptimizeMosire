/**
 * Minimal ZIP writer for tests. Produces EOCD + central directory + local
 * headers so the reader is exercised against real offsets instead of a fixture
 * we cannot inspect.
 */
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * @param {Array<{ name: string, data: Buffer, method?: 0 | 8, flags?: number, forceZip64?: boolean, localZeros?: boolean }>} entries
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data)
    const method = entry.method ?? 8
    const flags = entry.flags ?? 0
    const body = method === 8 ? deflateRawSync(data) : data
    const crc = crc32(data)
    const compSize = entry.forceZip64 ? 0xffffffff : body.length
    const uncompSize = entry.forceZip64 ? 0xffffffff : data.length
    const localZeros = entry.localZeros === true
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(localZeros ? 0 : crc, 14)
    local.writeUInt32LE(localZeros ? 0 : compSize, 18)
    local.writeUInt32LE(localZeros ? 0 : uncompSize, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const localOffset = offset
    const localHeader = Buffer.concat([local, name, body])
    chunks.push(localHeader)
    offset += localHeader.length
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(flags, 8)
    dir.writeUInt16LE(method, 10)
    dir.writeUInt16LE(0, 12)
    dir.writeUInt16LE(0, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(compSize, 20)
    dir.writeUInt32LE(uncompSize, 24)
    dir.writeUInt16LE(name.length, 28)
    dir.writeUInt16LE(0, 30)
    dir.writeUInt16LE(0, 32)
    dir.writeUInt16LE(0, 34)
    dir.writeUInt16LE(0, 36)
    dir.writeUInt32LE(0, 38)
    dir.writeUInt32LE(localOffset, 42)
    central.push(Buffer.concat([dir, name]))
  }
  const centralStart = offset
  const centralBuffer = Buffer.concat(central)
  offset += centralBuffer.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuffer, eocd])
}
