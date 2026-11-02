/**
 * Archive parsing and session-id remapping for the session importer.
 *
 * An exported ZIP has three entry kinds under a fixed layout:
 *   session.v4.jsonl
 *   subagents/<segment>/session.v4.jsonl
 *   media/<attachmentId>.<ext>  and  files/<xx>/<digest>/<name>
 * Anything else is skipped and reported; a bare log (JSONL or zstd) is treated
 * as a single root session.
 */
import { randomUUID } from 'node:crypto'
import { readZipEntries } from './zip.js'
import { DecodeError, decodeZstdFrames, parseSessionLog, sniffLog } from './decode.js'

const ROOT_LOG = 'session.v4.jsonl'
const SUBAGENT_LOG = /^subagents\/([^/]+)\/session\.v4\.jsonl$/u
const MEDIA = /^media\/(sha256:[0-9a-f]+)\.([A-Za-z0-9]+)$/u
const FILES = /^files\/([0-9a-f]{2})\/([0-9a-f]+)\/([^/]+)$/u
const MAX_ID_ATTEMPTS = 100

/**
 * @param {Buffer} buffer - ZIP archive or a single JSONL / zstd log.
 * @param {{ fallbackCwd?: string }} [options]
 * @returns {{ sessions: Array<{header: object, events: object[], source: string}>, media: Array<{attachmentId: string, ext: string, data: Buffer}>, files: Array<{digest: string, name: string, data: Buffer}>, skipped: string[] }}
 */
export function parseArchive(buffer, { fallbackCwd } = {}) {
  const kind = sniffLog(buffer)
  if (kind !== 'zip') {
    const text = kind === 'zstd' ? decodeZstdFrames(buffer).toString('utf8') : buffer.toString('utf8')
    const { header, events } = parseSessionLog(text, '<imported log>')
    fillCwd(header, fallbackCwd)
    return { sessions: [{ header, events, source: '<imported log>' }], media: [], files: [], skipped: [] }
  }

  const sessions = []
  const media = []
  const files = []
  const skipped = []
  const seenIds = new Set()
  for (const [name, data] of readZipEntries(buffer)) {
    if (!isSafeEntryName(name)) {
      skipped.push(name)
      continue
    }
    if (name === ROOT_LOG || SUBAGENT_LOG.test(name)) {
      const { header, events } = parseSessionLog(data.toString('utf8'), name)
      if (seenIds.has(header.id)) throw new DecodeError(`duplicate session id ${header.id} in archive`)
      seenIds.add(header.id)
      fillCwd(header, fallbackCwd)
      sessions.push({ header, events, source: name })
      continue
    }
    const mediaMatch = MEDIA.exec(name)
    if (mediaMatch !== null) {
      media.push({ attachmentId: mediaMatch[1], ext: mediaMatch[2], data })
      continue
    }
    const fileMatch = FILES.exec(name)
    if (fileMatch !== null) {
      files.push({ digest: fileMatch[2], name: fileMatch[3], data })
      continue
    }
    skipped.push(name)
  }
  if (sessions.length === 0) throw new DecodeError('archive contains no session logs')
  sessions.sort((a, b) => rank(a.header) - rank(b.header))
  return { sessions, media, files, skipped }
}

/**
 * Give every session an id that is free in the target store.
 *
 * @param {Array<{header: object}>} sessions - root first (as returned by parseArchive).
 * @param {(id: string) => Promise<boolean>} isTaken
 * @param {() => string} [mintId]
 * @returns {Promise<{sessions: Array<object>, renames: Map<string, string>}>}
 */
export async function assignSessionIds(sessions, isTaken, mintId = () => `session-${randomUUID()}`) {
  const renames = new Map()
  const reserved = new Set()
  for (const session of sessions) {
    const original = session.header.id
    if (renames.has(original)) continue
    if (!(await isTaken(original))) continue
    let replacement
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const candidate = mintId()
      if (candidate === original || reserved.has(candidate)) continue
      if (await isTaken(candidate)) continue
      replacement = candidate
      break
    }
    if (replacement === undefined) throw new Error(`unable to mint a free session id for ${original}`)
    reserved.add(replacement)
    renames.set(original, replacement)
  }
  return { sessions, renames }
}

/**
 * Return a deep copy with the session id, its parent link, and every event
 * string that exactly equals a renamed id replaced.
 *
 * @param {{header: object, events: object[], source?: string}} session
 * @param {Map<string, string>} renames
 */
export function remapSession(session, renames) {
  if (renames.size === 0) return structuredClone(session)
  const clone = structuredClone(session)
  clone.header.id = renames.get(clone.header.id) ?? clone.header.id
  if (typeof clone.header.parentSession === 'string') {
    clone.header.parentSession = renames.get(clone.header.parentSession) ?? clone.header.parentSession
  }
  clone.events = clone.events.map((event) => remapValue(event, renames))
  return clone
}

function remapValue(value, renames) {
  if (typeof value === 'string') return renames.get(value) ?? value
  if (Array.isArray(value)) return value.map((item) => remapValue(item, renames))
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = remapValue(value[key], renames)
    return value
  }
  return value
}

function fillCwd(header, fallbackCwd) {
  if (typeof header.cwd === 'string' && header.cwd.length > 0) return
  if (typeof fallbackCwd === 'string' && fallbackCwd.length > 0) header.cwd = fallbackCwd
}

/** Roots sort first, then by delegation depth. */
function rank(header) {
  const depth = Number.isSafeInteger(header.delegationDepth) ? header.delegationDepth : 0
  return (typeof header.parentSession === 'string' ? 1000 : 0) + depth
}

function isSafeEntryName(name) {
  if (name.length === 0 || name.startsWith('/') || name.includes('\\')) return false
  return name.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}
