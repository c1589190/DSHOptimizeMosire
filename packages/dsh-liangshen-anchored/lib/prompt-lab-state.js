/**
 * Session state for the prompt-lab preset (`minimal-prompt-lab`).
 *
 * The effective system prompt of a prompt-lab session is a pure function of the
 * session log, folded by a `prompt-lab` session projection:
 *
 *   latest successful `/sp` selection  +  latest non-empty `system/message`
 *
 * The projection is the only sanctioned synchronous per-session read (the
 * session's own readers are deprecated), and folding the log means resume,
 * fork, and crash recovery need no sidecar file: a `/sp` whose `command/done`
 * never arrived cannot take effect.
 *
 * Rules:
 *   - before the first request a selection is pending, so the provider reads
 *     the file/text at request time; the first `system/message` is the snapshot;
 *   - after the snapshot exists the prompt is FROZEN (`lastSystemText`), even if
 *     the source file changes — an experiment run must not drift mid-session;
 *   - a later `/sp` is pending again (selection seq > snapshot seq) and the Host
 *     pre-step guard forces a new request series so the assembly REPLACES the
 *     first system message instead of appending a second one;
 *   - no selection at all means the official Minimal persona line.
 *
 * Everything here is dependency-free (node: builtins only): the anchored package
 * has no runtime dependencies of its own.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** Session projection key; also the state key in the projection cache. */
export const PROMPT_LAB_KEY = 'prompt-lab'

/** Projection state schema version (bump when the folded shape changes). */
export const PROMPT_LAB_STATE_VERSION = 1

/** Command name (without the leading slash). */
export const COMMAND_NAME = 'sp'

/** The exact official Minimal persona line used when no `/sp` has happened. */
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful software engineer assistant.'

/** `/sp blank` = one ASCII space, matching the empty-system variant. */
export const BLANK_SYSTEM_PROMPT = ' '

/** Hard cap for an imported prompt file. */
export const MAX_PROMPT_BYTES = 256 * 1024

/** Usage line printed for bad input. */
export const USAGE = '用法：/sp file <path> | /sp text <一行> | /sp blank | /sp clear | /sp show'

const SELECTION_KINDS = new Set(['file', 'text', 'blank', 'clear'])

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Lowercase hex SHA-256 of a buffer. */
function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Parse the raw input of `/sp` (the invocations' `rawInput`, i.e. everything
 * after the command name).
 *
 * Grammar (single line; paths may contain spaces, text may not span lines):
 *   file <path> | text <one line> | blank | clear | show
 *
 * @returns {{kind: 'file', path: string} | {kind: 'text', text: string} |
 *   {kind: 'blank'} | {kind: 'clear'} | {kind: 'show'} |
 *   {kind: 'error', message: string}}
 */
export function parsePromptLabInput(rawInput) {
  const text = String(rawInput ?? '').trimStart()
  if (text.length === 0) return { kind: 'error', message: USAGE }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(text)
  if (match === null) return { kind: 'error', message: USAGE }
  const [, head, tail = ''] = match
  switch (head) {
    case 'file': {
      const path = tail.trim()
      if (path.length === 0) return { kind: 'error', message: '用法：/sp file <path>' }
      return { kind: 'file', path }
    }
    case 'text': {
      const value = tail.trim()
      if (value.length === 0) return { kind: 'error', message: '用法：/sp text <一行>；多行请用 /sp file' }
      return { kind: 'text', text: value }
    }
    case 'blank':
      return tail.trim().length === 0 ? { kind: 'blank' } : { kind: 'error', message: '/sp blank 不接受参数' }
    case 'clear':
      return tail.trim().length === 0 ? { kind: 'clear' } : { kind: 'error', message: '/sp clear 不接受参数' }
    case 'show':
      return tail.trim().length === 0 ? { kind: 'show' } : { kind: 'error', message: '/sp show 不接受参数' }
    default:
      return { kind: 'error', message: USAGE }
  }
}

/**
 * Resolve a `/sp file` path against the session cwd.
 * @returns {string | null} absolute path, or null when a relative path has no cwd
 */
export function resolveSelectionPath(rawPath, cwd) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null
  if (isAbsolute(rawPath)) return rawPath
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  return resolve(cwd, rawPath)
}

/**
 * Read one prompt file: UTF-8, BOM stripped, NUL/empty/oversize rejected.
 * @returns {{ok: true, text: string, bytes: number, sha256: string, fileSha256: string} |
 *   {ok: false, error: string}}
 */
export function readPromptFile(path) {
  let buffer
  try {
    buffer = readFileSync(path)
  } catch (error) {
    return { ok: false, error: `读不到文件：${path}（${error?.code ?? 'unknown'}）` }
  }
  if (buffer.length === 0) return { ok: false, error: `文件是空的：${path}；要空提示词请用 /sp blank` }
  if (buffer.length > MAX_PROMPT_BYTES) {
    return { ok: false, error: `文件超过 ${MAX_PROMPT_BYTES} 字节上限：${path}` }
  }
  let text = buffer.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (text.length === 0) return { ok: false, error: `文件只含 BOM：${path}；要空提示词请用 /sp blank` }
  if (text.includes('\u0000')) return { ok: false, error: `文件包含 NUL 字节：${path}` }
  return { ok: true, text, bytes: buffer.length, sha256: sha256(text), fileSha256: sha256Buffer(buffer) }
}

/**
 * Resolve one selection to prompt text (sync, safe: never throws).
 * @returns {{ok: true, text: string, source: string, path?: string, bytes?: number, sha256?: string} |
 *   {ok: false, error: string, path?: string}}
 */
export function resolveSelection(selection, cwd) {
  switch (selection?.kind) {
    case 'file': {
      const path = resolveSelectionPath(selection.path, cwd)
      if (path === null) {
        return { ok: false, error: '相对路径需要一个会话工作目录；请用绝对路径' }
      }
      const file = readPromptFile(path)
      return file.ok ? { ok: true, text: file.text, source: 'file', path, bytes: file.bytes, sha256: file.sha256 } : { ok: false, error: file.error, path }
    }
    case 'text':
      return {
        ok: true,
        text: selection.text,
        source: 'text',
        bytes: Buffer.byteLength(selection.text, 'utf8'),
        sha256: sha256(selection.text),
      }
    case 'blank':
      return { ok: true, text: BLANK_SYSTEM_PROMPT, source: 'blank' }
    case 'default':
      return { ok: true, text: DEFAULT_SYSTEM_PROMPT, source: 'default' }
    default:
      return { ok: false, error: '未知的提示词选择' }
  }
}

/** True when a selection exists and has not been snapshotted yet. */
export function isSwitchPending(state) {
  if (!isPromptLabState(state) || state.selection === null) return false
  return (state.selection.seq ?? 0) > (state.lastSystemSeq ?? 0)
}

/**
 * The provider's pure decision for one assembly.
 * @returns {{text: string, source: string, seq?: number, path?: string, bytes?: number,
 *   sha256?: string, error?: string}}
 */
export function resolveLabPrompt(state) {
  if (!isPromptLabState(state)) return { text: DEFAULT_SYSTEM_PROMPT, source: 'default' }
  if (!isSwitchPending(state)) {
    if (state.lastSystemText !== '') return { text: state.lastSystemText, source: 'snapshot', seq: state.lastSystemSeq }
    return { text: DEFAULT_SYSTEM_PROMPT, source: 'default' }
  }
  const resolved = resolveSelection(state.selection, state.cwd)
  if (resolved.ok) return resolved
  // A broken source must not fail assembly: keep the last good prompt (or the
  // official line) and report the problem to the caller for a warning.
  if (state.lastSystemText !== '') {
    return { text: state.lastSystemText, source: 'snapshot', seq: state.lastSystemSeq, error: resolved.error }
  }
  return { text: DEFAULT_SYSTEM_PROMPT, source: 'default', error: resolved.error }
}

/** Initial projection state for one session. */
export function initPromptLabState(header) {
  return {
    cwd: typeof header?.cwd === 'string' ? header.cwd : '',
    selection: null,
    lastSystemText: '',
    lastSystemSeq: 0,
    pending: [],
  }
}

/** Extract text from a `system/message` payload; tombstones yield ''. */
function systemMessageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

function selectionFromParsed(parsed, seq) {
  switch (parsed.kind) {
    case 'file':
      return { kind: 'file', path: parsed.path, seq }
    case 'text':
      return { kind: 'text', text: parsed.text, seq }
    case 'blank':
      return { kind: 'blank', seq }
    case 'clear':
      return { kind: 'default', seq }
    default:
      return null
  }
}

/**
 * Fold one session event into the prompt-lab state.
 *
 * - `system/message` updates the frozen snapshot (non-empty only; a tombstone
 *   from a head replacement is empty and must not erase it);
 * - `command/run` of `sp` with a selection verb becomes pending;
 * - `command/done` settles it: only `kind === 'success'` makes the selection
 *   effective; failures and crashed runs are dropped.
 */
export function applyPromptLabEvent(state, event) {
  if (!isPromptLabState(state)) return initPromptLabState(undefined)
  const data = event?.data
  switch (event?.type) {
    case 'system/message': {
      const text = systemMessageText(data?.message)
      return text === '' ? state : { ...state, lastSystemText: text, lastSystemSeq: event.seq }
    }
    case 'command/run': {
      if (data?.name !== COMMAND_NAME) return state
      const parsed = parsePromptLabInput(data.args)
      if (!SELECTION_KINDS.has(parsed.kind)) return state
      const selection = selectionFromParsed(parsed, event.seq)
      if (selection === null) return state
      return { ...state, pending: [...state.pending, { commandId: data.commandId, selection }] }
    }
    case 'command/done': {
      if (state.pending.length === 0) return state
      const index = state.pending.findIndex((entry) => entry.commandId === data?.commandId)
      if (index === -1) return state
      const pending = [...state.pending.slice(0, index), ...state.pending.slice(index + 1)]
      if (data?.kind !== 'success') return { ...state, pending }
      return { ...state, selection: state.pending[index].selection, pending }
    }
    default:
      return state
  }
}

/** Lightweight structural validation (the package has no zod dependency). */
export function isPromptLabState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (typeof value.cwd !== 'string') return false
  if (typeof value.lastSystemText !== 'string') return false
  if (!Number.isSafeInteger(value.lastSystemSeq) || value.lastSystemSeq < 0) return false
  if (!Array.isArray(value.pending)) return false
  if (value.selection !== null) {
    const selection = value.selection
    if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) return false
    if (!SELECTION_KINDS.has(selection.kind) && selection.kind !== 'default') return false
    if (!Number.isSafeInteger(selection.seq) || selection.seq < 0) return false
    if (selection.kind === 'file' && typeof selection.path !== 'string') return false
    if (selection.kind === 'text' && typeof selection.text !== 'string') return false
  }
  for (const entry of value.pending) {
    if (entry === null || typeof entry !== 'object') return false
    if (typeof entry.commandId !== 'string' || entry.commandId.length === 0) return false
    if (entry.selection === null || typeof entry.selection !== 'object') return false
  }
  return true
}

/** Projection schema: parse is the only method the registry calls today. */
export const promptLabStateSchema = {
  parse(value) {
    if (!isPromptLabState(value)) throw new TypeError(`prompt-lab state is invalid: ${JSON.stringify(value)?.slice(0, 200)}`)
    return value
  },
  safeParse(value) {
    return isPromptLabState(value)
      ? { success: true, data: value }
      : { success: false, error: new TypeError('prompt-lab state is invalid') }
  },
}

/**
 * Build the session-projection definition registered by the Host plugin.
 */
export function makePromptLabProjection() {
  return {
    key: PROMPT_LAB_KEY,
    stateVersion: PROMPT_LAB_STATE_VERSION,
    stateSchema: promptLabStateSchema,
    init: (header) => initPromptLabState(header),
    apply: (state, event) => applyPromptLabEvent(state, event),
  }
}

/**
 * Build the Host `agent/pre-step` guard.
 *
 * The guard reads the projection BEFORE `next()` (the decision's message batch
 * does not change the pending flag), then lets the inner hooks build the
 * decision and forces a new request series when a switch is pending. That is
 * what turns `SystemPromptProjection.project` from "append a second system
 * message" into "replace the first one".
 *
 * @param {(agent: object | undefined) => object | undefined} getState
 */
export function makeSwitchGuard(getState) {
  return async (payload, next) => {
    let pending = false
    try {
      pending = isSwitchPending(getState(payload?.agent))
    } catch {
      pending = false
    }
    const decision = await next()
    if (!pending || decision?.kind !== 'enter') return decision
    return { ...decision, startsRequestSeries: true }
  }
}
