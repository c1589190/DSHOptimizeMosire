/**
 * Import one exported session archive through the official persistence API.
 *
 * The archive is fully parsed and validated before the first write, so a
 * rejected archive leaves no partial session behind. Attachment writes are
 * best-effort: a failed attachment is reported but never blocks the session,
 * matching how the log references attachments by content-addressed id.
 */
import { parseArchive, assignSessionIds, remapSession } from './archive.js'

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const IMAGE_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
])
const DEFAULT_MAX_BYTES = 1024 ** 3

/** Raised when an archive cannot be imported. */
export class SessionImportError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SessionImportError'
  }
}

/**
 * @param {object} options
 * @param {Buffer} options.buffer - ZIP archive or a single log.
 * @param {{stat: Function, create: Function}} options.persistence
 * @param {{saveImage?: Function, saveFile?: Function}} [options.attachments]
 * @param {string} [options.fallbackCwd]
 * @param {number} [options.maxBytes]
 * @param {AbortSignal} [options.signal]
 * @param {() => string} [options.mintId]
 * @returns {Promise<{sessions: Array<{id: string, previousId: string, cwd?: string, events: number}>, failures: Array<{id: string, error: string}>, attachmentErrors: Array<{name: string, error: string}>, skipped: string[], renames: Array<[string, string]>, attachments: number}>}
 */
export async function importArchive(options) {
  const { buffer, persistence, attachments, fallbackCwd, maxBytes = DEFAULT_MAX_BYTES, signal, mintId } = options
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new SessionImportError('empty archive')
  if (buffer.length > maxBytes) {
    throw new SessionImportError(`archive is too large (${buffer.length} bytes, limit ${maxBytes})`)
  }
  const parsed = parseArchive(buffer, { fallbackCwd })
  for (const session of parsed.sessions) {
    if (session.header.isSeeded === true) {
      throw new SessionImportError(`seeded session ${session.header.id} cannot be imported (isSeeded:true)`)
    }
  }
  const { renames } = await assignSessionIds(
    parsed.sessions,
    async (id) => (await persistence.stat(id, signal === undefined ? undefined : { signal })) !== undefined,
    mintId,
  )
  const prepared = parsed.sessions.map((session) => remapSession(session, renames))
  for (const session of prepared) validateImportedSession(session)

  const attachmentErrors = []
  let savedAttachments = 0
  if (attachments !== undefined && attachments !== null) {
    for (const media of parsed.media) {
      const mediaType = IMAGE_TYPES.get(media.ext.toLowerCase())
      if (mediaType === undefined || typeof attachments.saveImage !== 'function') {
        attachmentErrors.push({ name: `media/${media.attachmentId}.${media.ext}`, error: 'unsupported image type' })
        continue
      }
      try {
        await attachments.saveImage({ data: media.data, mediaType, name: `${media.attachmentId}.${media.ext}` })
        savedAttachments += 1
      } catch (error) {
        attachmentErrors.push({ name: `media/${media.attachmentId}.${media.ext}`, error: errorMessage(error) })
      }
    }
    for (const file of parsed.files) {
      if (typeof attachments.saveFile !== 'function') {
        attachmentErrors.push({ name: file.name, error: 'attachment store has no file support' })
        continue
      }
      try {
        await attachments.saveFile({ data: file.data, name: file.name })
        savedAttachments += 1
      } catch (error) {
        attachmentErrors.push({ name: file.name, error: errorMessage(error) })
      }
    }
  }

  const report = {
    sessions: [],
    failures: [],
    attachmentErrors,
    skipped: parsed.skipped,
    renames: [...renames],
    attachments: savedAttachments,
  }
  for (const session of prepared) {
    const id = session.header.id
    const previousId = previousIdOf(renames, id)
    let handle
    try {
      handle = await persistence.create(toStoredHeader(session.header), signal === undefined ? undefined : { signal })
      await handle.append(session.events, signal === undefined ? undefined : { signal })
      await handle.flush()
      report.sessions.push({ id, previousId, cwd: session.header.cwd, events: session.events.length })
    } catch (error) {
      report.failures.push({ id, error: errorMessage(error) })
    } finally {
      if (handle !== undefined && handle !== null) {
        try {
          await handle.close()
        } catch {
          // A close failure never changes the import outcome.
        }
      }
    }
  }
  return report
}

/**
 * @param {{header: object, events: object[]}} session
 * @returns {void}
 */
export function validateImportedSession(session) {
  const { header, events } = session
  if (header === null || typeof header !== 'object') throw new SessionImportError('session has no header')
  if (typeof header.id !== 'string' || header.id.length === 0) throw new SessionImportError('session header has no id')
  if (!Array.isArray(events)) throw new SessionImportError(`session ${header.id} has no events array`)
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new SessionImportError(`session ${header.id} event ${index} is not an object`)
    }
    if (event.seq !== index) {
      throw new SessionImportError(`session ${header.id} event ${index} has seq ${String(event.seq)}, expected ${index}`)
    }
    if (typeof event.type !== 'string' || event.type.length === 0) {
      throw new SessionImportError(`session ${header.id} event ${index} has no type`)
    }
    if (!Number.isFinite(event.time)) {
      throw new SessionImportError(`session ${header.id} event ${index} has no time`)
    }
    if (SURFACE_TYPES.has(event.type)) {
      if (!isSurfaceOp(event.surfaceOp)) {
        throw new SessionImportError(`session ${header.id} event ${index} requires a surfaceOp marker`)
      }
      if (event.type === 'assistant/message' && event.sourceEventSeqs !== undefined) {
        throw new SessionImportError(`session ${header.id} event ${index} cannot carry sourceEventSeqs`)
      }
      if (event.sourceEventSeqs !== undefined && !isSeqList(event.sourceEventSeqs)) {
        throw new SessionImportError(`session ${header.id} event ${index} has invalid sourceEventSeqs`)
      }
    } else if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
      throw new SessionImportError(`session ${header.id} event ${index} is not surface-eligible`)
    }
  }
}

/** The serialized log line carries `type: "session"`; create() wants the logical header. */
function toStoredHeader(header) {
  const { type: _type, ...rest } = header
  return {
    ...rest,
    version: 4,
    isSeeded: rest.isSeeded === true,
    delegationDepth: Number.isSafeInteger(rest.delegationDepth) ? rest.delegationDepth : 0,
  }
}

function isSurfaceOp(value) {
  if (value === 'append') return true
  return (
    value !== null &&
    typeof value === 'object' &&
    value.op === 'replace' &&
    Number.isSafeInteger(value.startSeq) &&
    Number.isSafeInteger(value.endSeq) &&
    value.startSeq <= value.endSeq
  )
}

function isSeqList(value) {
  return Array.isArray(value) && value.every((seq) => Number.isSafeInteger(seq))
}

function previousIdOf(renames, id) {
  for (const [from, to] of renames) {
    if (to === id) return from
  }
  return id
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
