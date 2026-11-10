/**
 * session-inspect — read-only agent tools for looking at other DSH sessions.
 *
 * WHY: an orchestration Agent often needs to see what another (sibling) session
 * actually carried: its current model context, the raw log, one event with its
 * neighbours, or where a literal phrase appears. The official `ctx.sessionQuery`
 * service already provides every exact read; this package only wraps it into
 * three model-facing tools and never writes, resumes, or mutates a session.
 *
 * Tools installed per top-level Agent scope:
 *
 *   - `session_list` — list sessions (workspace/preset/top-level/live filters).
 *   - `session_read` — read `surface` (current model context), `raw` (complete
 *     log), or `event` (target + before/after window).
 *   - `session_find` — literal, case-insensitive text scan inside one session.
 *
 * Cross-session full-text search is NOT exposed: the Web profile's
 * `session-query-sqlite` row ships `openAt: "never"`, so the FTS backend is
 * disabled by default. Exact reads and `filterEvents` do not need it.
 *
 * @module @mosire/dsh-session-inspect
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Cross-bundle anchored bootstrap gate (see the anchored preset's
 * `tool-bootstrap.mjs`). DSH 0.2.2 keeps a scope's own tool registrations
 * exempt from `tools.restrict()`, so host features registered into the
 * Agent's scope hide themselves through the supported per-step `when`
 * condition instead: the preset publishes this symbol on the Agent and the
 * condition follows its phase. Absent symbol => ordinary visibility.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'session-inspect'

/** Model-facing tool name that lists sessions. */
export const LIST_TOOL_NAME = 'session_list'

/** Model-facing tool name that reads one session. */
export const READ_TOOL_NAME = 'session_read'

/** Model-facing tool name that scans one session's text. */
export const FIND_TOOL_NAME = 'session_find'

const STATUS_FILE = 'session-inspect-status.json'
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const DEFAULT_READ_LIMIT = 200
const MAX_READ_LIMIT = 1000
const DEFAULT_MAX_CHARS = 30_000
const MAX_MAX_CHARS = 200_000
const WINDOW_MAX = 50
const MODES = ['surface', 'raw', 'event']

/** Normalize the feature config; invalid values fall back or throw at activation. */
export function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  return {
    enabled: raw.enabled !== false,
    defaultLimit: clampInt(raw.defaultLimit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    defaultMaxChars: clampInt(raw.defaultMaxChars, DEFAULT_MAX_CHARS, 1_000, MAX_MAX_CHARS),
  }
}

function clampInt(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function readService(ctx, key) {
  try {
    return ctx.get?.(key)
  } catch {
    return undefined
  }
}

function agentId(agent) {
  const id = agent?.id
  return typeof id === 'string' ? id : undefined
}

function signalOf(exec) {
  return exec?.signal ?? new AbortController().signal
}

function objectArg(args) {
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}
}

function formatTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  if (typeof value === 'string' && value.length > 0) return value
  return '?'
}

function contentBlocks(message) {
  const content = message?.content
  return Array.isArray(content) ? content : []
}

function toolCallLine(block) {
  const tool = typeof block?.name === 'string' && block.name.length > 0 ? block.name : 'tool'
  const raw = block?.arguments ?? block?.input
  const rendered = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})
  return `[tool-call] ${tool}(${rendered})`
}

function messageText(message, includeReasoning) {
  const parts = []
  for (const block of contentBlocks(message)) {
    if (block?.type === 'text') {
      if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
    } else if (block?.type === 'tool-call') {
      parts.push(toolCallLine(block))
    } else if (block?.type === 'reasoning' && includeReasoning === true) {
      if (typeof block.text === 'string' && block.text.length > 0) parts.push(`[reasoning] ${block.text}`)
    }
  }
  return parts.join('\n')
}

function eventMessage(event) {
  const data = event?.data
  if (data !== null && typeof data === 'object') {
    if (data.message !== null && typeof data.message === 'object') return data.message
    if (Array.isArray(data.content)) return data
  }
  return event?.message
}

/** Compact, provider-independent text for one event; '' means "nothing to render". */
export function eventText(event, includeReasoning = false) {
  switch (event?.type) {
    case 'system/message':
    case 'developer/message':
    case 'user/message':
    case 'assistant/message':
      return messageText(eventMessage(event), includeReasoning)
    case 'tool/result': {
      const text = messageText(eventMessage(event), false)
      const error = event?.data?.error
      if (error === undefined || error === null) return text
      const name = typeof error.name === 'string' ? error.name : 'error'
      const code = typeof error.code === 'string' ? ` (${error.code})` : ''
      return [text, `[error] ${name}${code}`].filter((part) => part.length > 0).join('\n')
    }
    case 'tool/call': {
      const data = event?.data ?? {}
      return toolCallLine(data)
    }
    case 'request/header': {
      const header = event?.data?.header ?? {}
      const config = header.config ?? {}
      const tools = Array.isArray(header.tools) ? header.tools.length : 0
      return `request model=${config.provider ?? '?'}/${config.model ?? '?'} tools=${tools}`
    }
    case 'model/selection': {
      const data = event?.data ?? {}
      const effort = data.reasoningEffort === undefined ? '' : ` effort=${String(data.reasoningEffort)}`
      return `model ${data.provider ?? '?'}/${data.model ?? '?'}${effort}`
    }
    case 'session/title':
      return `title: ${event?.data?.title ?? ''}`
    case 'turn/end': {
      const data = event?.data ?? {}
      return `turn ${data.turn ?? '?'} end (${data.reason?.kind ?? 'unknown'})`
    }
    case 'command/run': {
      const data = event?.data ?? {}
      return `command /${data.name ?? '?'}${data.args ? ` ${data.args}` : ''}`
    }
    case 'command/done': {
      const data = event?.data ?? {}
      return `command done ${data.kind ?? '?'}${data.text ? `: ${data.text}` : ''}`
    }
    case 'compaction/start':
    case 'compaction/end':
      return `[${event.type}]`
    default:
      return ''
  }
}

function summarizeEvents(events) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  let model
  let tools
  let turns = 0
  for (const event of events) {
    if (event?.type === 'assistant/message') {
      const source = event?.data?.message?.source
      if (typeof source?.provider === 'string' && typeof source?.model === 'string') {
        model = `${source.provider}/${source.model}`
      }
      const usage = event?.data?.usage
      if (usage !== null && typeof usage === 'object') {
        tokens.input += numberOrZero(usage.inputTokens)
        tokens.output += numberOrZero(usage.outputTokens)
        tokens.cacheRead += numberOrZero(usage.cacheReadTokens)
        tokens.cacheWrite += numberOrZero(usage.cacheWriteTokens)
        tokens.total += numberOrZero(usage.totalTokens)
      }
      const turn = event?.data?.turn
      if (typeof turn === 'number' && Number.isFinite(turn)) turns = Math.max(turns, turn)
    } else if (event?.type === 'request/header') {
      const config = event?.data?.header?.config
      if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
        model = `${config.provider}/${config.model}`
      }
      const declared = event?.data?.header?.tools
      if (Array.isArray(declared)) tools = declared.length
    } else if (event?.type === 'turn/end') {
      const turn = event?.data?.turn
      if (typeof turn === 'number' && Number.isFinite(turn)) turns = Math.max(turns, turn)
    }
  }
  return { model, tools, turns, tokens }
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function headerText(session, extra = {}) {
  const header = session ?? {}
  const first = [`session ${header.id ?? '?'}`]
  if (typeof header.agentPreset === 'string' && header.agentPreset.length > 0) {
    first.push(`preset ${header.agentPreset}`)
  }
  if (typeof extra.title === 'string' && extra.title.length > 0) first.push(`"${extra.title}"`)
  const meta = []
  if (typeof header.cwd === 'string' && header.cwd.length > 0) meta.push(`cwd ${header.cwd}`)
  if (typeof header.parentSession === 'string' && header.parentSession.length > 0) {
    meta.push(`parent ${header.parentSession}`)
  }
  if (typeof header.origin === 'string' && header.origin.length > 0) meta.push(`origin ${header.origin}`)
  if (header.createdAt !== undefined) meta.push(`created ${formatTime(header.createdAt)}`)
  if (typeof extra.mode === 'string') meta.push(`mode ${extra.mode}`)
  if (typeof extra.eventCount === 'number') meta.push(`events ${extra.eventCount}`)
  if (extra.capturedThroughSeq !== undefined && extra.capturedThroughSeq !== null) {
    meta.push(`captured through seq ${extra.capturedThroughSeq}`)
  }
  if (typeof extra.inheritedEventCount === 'number') meta.push(`inherited ${extra.inheritedEventCount}`)
  const stats = []
  if (typeof extra.model === 'string' && extra.model.length > 0) stats.push(`model ${extra.model}`)
  if (typeof extra.tools === 'number') stats.push(`tools ${extra.tools}`)
  if (typeof extra.turns === 'number' && extra.turns > 0) stats.push(`turns ${extra.turns}`)
  const tokens = extra.tokens
  if (tokens !== undefined && tokens !== null) {
    const sum =
      tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.total
    if (sum > 0) {
      stats.push(
        `tokens in ${tokens.input} / out ${tokens.output} / cacheRead ${tokens.cacheRead} / cacheWrite ${tokens.cacheWrite} / total ${tokens.total}`,
      )
    }
  }
  const lines = [first.join(' · ')]
  if (meta.length > 0) lines.push(meta.join(' · '))
  if (stats.length > 0) lines.push(stats.join(' · '))
  return lines.join('\n')
}

/** Render a bounded transcript; returns text plus truncation/continuation metadata. */
function renderTranscript(events, options) {
  const all = Array.isArray(events) ? events : []
  const limit = options.limit
  const tail = options.tail === true
  let start = 0
  let truncatedByLimit = false
  if (all.length > limit) {
    truncatedByLimit = true
    start = tail ? all.length - limit : 0
  }
  const slice = all.slice(start, start + limit)
  const blocks = []
  for (const event of slice) {
    const text = eventText(event, options.includeReasoning === true)
    if (text.length === 0) continue
    blocks.push({ seq: event.seq, type: event.type, text })
  }
  const parts = []
  let used = 0
  let charTruncated = false
  let nextSeq
  for (const block of blocks) {
    const marker = block.seq === options.targetSeq ? ' target' : ''
    const body = `[${String(block.seq ?? '?')}${marker}] ${block.type}\n${block.text}`
    if (used + body.length + 2 > options.maxChars) {
      charTruncated = true
      nextSeq = block.seq
      break
    }
    parts.push(body)
    used += body.length + 2
  }
  let text = parts.join('\n\n')
  const notes = []
  if (truncatedByLimit) {
    if (tail) {
      notes.push(`[showing the last ${limit} events]`)
    } else {
      const next = all[start + limit]?.seq
      notes.push(`[showing the first ${limit} events${next === undefined ? '' : `; next seq ${next}`}]`)
      if (nextSeq === undefined) nextSeq = next
    }
  }
  if (charTruncated) {
    notes.push(`[truncated at ${options.maxChars} chars${nextSeq === undefined ? '' : `; next seq ${nextSeq}`}]`)
  }
  if (notes.length > 0) text = `${text}\n\n${notes.join('\n')}`.trim()
  return {
    text: text.length > 0 ? text : '[no renderable events]',
    truncated: truncatedByLimit || charTruncated,
    nextSeq,
  }
}

async function loadTitle(sessionQuery, sessionId, signal) {
  if (typeof sessionQuery.readTitleSnapshots !== 'function') return undefined
  try {
    const results = await sessionQuery.readTitleSnapshots([sessionId], signal)
    const hit = Array.isArray(results)
      ? results.find((item) => item?.sessionId === sessionId && item?.status === 'fulfilled')
      : undefined
    const title = hit?.value?.title?.title
    return typeof title === 'string' ? title : undefined
  } catch {
    return undefined
  }
}

async function loadTitles(sessionQuery, sessionIds, signal) {
  const titles = new Map()
  if (sessionIds.length === 0 || typeof sessionQuery.readTitleSnapshots !== 'function') return titles
  try {
    const results = await sessionQuery.readTitleSnapshots(sessionIds, signal)
    for (const item of Array.isArray(results) ? results : []) {
      const title = item?.value?.title?.title
      if (item?.status === 'fulfilled' && typeof title === 'string') titles.set(item.sessionId, title)
    }
  } catch {
    // Titles are cosmetic; a failed fold must not fail the listing.
  }
  return titles
}

async function resolveWorkspace(registry, ref) {
  if (registry === undefined || registry === null) {
    throw new Error(`${LIST_TOOL_NAME}: workspace filtering needs the workspaceRegistry service`)
  }
  let direct
  try {
    direct = typeof registry.get === 'function' ? registry.get(ref) : undefined
  } catch {
    direct = undefined
  }
  if (direct !== undefined && direct !== null) return direct
  const all = typeof registry.list === 'function' ? registry.list() : []
  const titleOf = (workspace) => workspace?.title ?? workspace?.record?.title
  const pathOf = (workspace) => workspace?.path ?? workspace?.record?.path
  const byTitle = all.find((workspace) => titleOf(workspace) === ref)
  if (byTitle !== undefined) return byTitle
  const byPath = all.find((workspace) => pathOf(workspace) === ref)
  if (byPath !== undefined) return byPath
  if (typeof registry.resolveByPath === 'function') {
    try {
      const resolved = await registry.resolveByPath(ref)
      if (resolved !== undefined && resolved !== null) return resolved
    } catch {
      // Fall through to the available-workspaces error.
    }
  }
  const available = all
    .map((workspace) => `${titleOf(workspace) ?? '?'} (${pathOf(workspace) ?? '?'})`)
    .filter((label) => label !== '? (?)')
  throw new Error(
    `${LIST_TOOL_NAME}: workspace "${ref}" not found${available.length === 0 ? '' : `; available: ${available.join(', ')}`}`,
  )
}

function snippetAround(text, needle, radius) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const haystack = text.toLowerCase()
  const lower = needle.toLowerCase()
  let index = haystack.indexOf(lower)
  if (index < 0) {
    const first = lower.split(/\s+/u).find((token) => token.length > 0)
    if (first !== undefined) index = haystack.indexOf(first)
  }
  if (index < 0) return text.slice(0, radius).trim()
  const start = Math.max(0, index - Math.floor(radius / 3))
  const end = Math.min(text.length, start + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end).trim()}${suffix}`
}

function normalizeNeedle(value) {
  return value.toLowerCase().replace(/\s+/gu, ' ').trim()
}

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
const renderText = (_args, value) => [{ type: 'text', text: value.text }]

function listParameters(cfg) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      workspace: {
        type: 'string',
        description: 'Restrict to one workspace: its id, exact title, or path.',
      },
      preset: {
        type: 'string',
        description: 'Restrict to sessions created under this agent preset id (for example minimal-prompt-lab).',
      },
      include_subagents: {
        type: 'boolean',
        description: 'Include subagent sessions. Default false (top-level sessions only).',
      },
      live: {
        type: 'boolean',
        description: 'true = only sessions live in this Host; false = only persisted sessions.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Maximum rows, newest first. Default ${cfg.defaultLimit}.`,
      },
    },
  }
}

const LIST_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          preset: { type: 'string' },
          cwd: { type: 'string' },
          parentSession: { type: 'string' },
          live: { type: 'boolean' },
          persisted: { type: 'boolean' },
        },
        required: ['sessionId', 'live', 'persisted'],
      },
    },
  },
  required: ['sessions'],
}

function readParameters(cfg) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      session: {
        type: 'string',
        description: 'Session id, as returned by session_list.',
      },
      mode: {
        type: 'string',
        enum: MODES,
        description:
          'surface = current model context (system/user/assistant/tool results; default); raw = complete persisted log; event = one target event plus a before/after window.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_READ_LIMIT,
        description: `Maximum events to render. Default ${DEFAULT_READ_LIMIT}.`,
      },
      max_chars: {
        type: 'integer',
        minimum: 1_000,
        maximum: MAX_MAX_CHARS,
        description: `Maximum characters of transcript. Default ${cfg.defaultMaxChars}.`,
      },
      tail: {
        type: 'boolean',
        description: 'Render the newest events instead of the oldest when the limit is hit.',
      },
      types: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include these event types (for example request/header, assistant/message).',
      },
      from_seq: {
        type: 'integer',
        minimum: 0,
        description: 'Only include events at or after this seq (raw/surface).',
      },
      to_seq: {
        type: 'integer',
        minimum: 0,
        description: 'Only include events at or before this seq (raw/surface).',
      },
      seq: {
        type: 'integer',
        minimum: 0,
        description: 'Target event seq for mode=event.',
      },
      before: {
        type: 'integer',
        minimum: 0,
        maximum: WINDOW_MAX,
        description: `Events before the target in mode=event (max ${WINDOW_MAX}).`,
      },
      after: {
        type: 'integer',
        minimum: 0,
        maximum: WINDOW_MAX,
        description: `Events after the target in mode=event (max ${WINDOW_MAX}).`,
      },
      include_reasoning: {
        type: 'boolean',
        description: 'Include assistant reasoning blocks. Default false.',
      },
    },
    required: ['session'],
  }
}

const READ_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' } },
  required: ['text'],
}

function findParameters() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      session: {
        type: 'string',
        description: 'Session id to scan.',
      },
      query: {
        type: 'string',
        description: 'Literal text to find (case-insensitive, whitespace-flexible).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum matches. Default 20.',
      },
    },
    required: ['session', 'query'],
  }
}

const FIND_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string' },
    query: { type: 'string' },
    total: { type: 'number' },
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          seq: { type: 'number' },
          type: { type: 'string' },
          time: { type: 'number' },
          surface: { type: 'string' },
          snippet: { type: 'string' },
        },
      },
    },
  },
  required: ['matches'],
}

/** Build the session_list tool definition. */
export function createListToolDefinition(services, cfg = normalizeConfig({})) {
  return {
    name: LIST_TOOL_NAME,
    description:
      'List logical sessions in this DSH Host (top-level sessions only by default), newest first, with title, agent preset, cwd, parent, live/persisted flags. Call this first to obtain a session id for session_read or session_find. Optional filters: workspace (id/title/path), preset, include_subagents, live. Read-only; never resumes or modifies a session.',
    parameters: listParameters(cfg),
    output: { schema: LIST_OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const input = objectArg(args)
      const signal = signalOf(exec)
      const limit = clampInt(input.limit, cfg.defaultLimit, 1, MAX_LIMIT)
      const records = await services.sessionQuery.listSessions(signal)
      let filtered = Array.isArray(records) ? records.slice() : []
      if (input.include_subagents !== true) {
        filtered = filtered.filter((record) => record?.header?.parentSession === undefined)
      }
      if (input.live === true || input.live === false) {
        filtered = filtered.filter((record) => (record?.live === true) === input.live)
      }
      if (typeof input.preset === 'string' && input.preset.length > 0) {
        filtered = filtered.filter((record) => record?.header?.agentPreset === input.preset)
      }
      if (typeof input.workspace === 'string' && input.workspace.length > 0) {
        const workspace = await resolveWorkspace(services.workspaceRegistry, input.workspace)
        const ids = new Set(Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [])
        filtered = filtered.filter((record) => ids.has(record?.header?.id))
      }
      filtered.sort((left, right) => timestampOf(right?.header?.createdAt) - timestampOf(left?.header?.createdAt))
      filtered = filtered.slice(0, limit)
      const titles = await loadTitles(services.sessionQuery, filtered.map((record) => record?.header?.id), signal)
      const sessions = filtered.map((record) => ({
        sessionId: record.header.id,
        ...(titles.has(record.header.id) ? { title: titles.get(record.header.id) } : {}),
        ...(typeof record.header.agentPreset === 'string' ? { preset: record.header.agentPreset } : {}),
        ...(typeof record.header.cwd === 'string' ? { cwd: record.header.cwd } : {}),
        ...(typeof record.header.parentSession === 'string' ? { parentSession: record.header.parentSession } : {}),
        createdAt: record.header.createdAt,
        live: record.live === true,
        persisted: record.persisted === true,
      }))
      return { sessions }
    },
  }
}

function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** Build the session_read tool definition. */
export function createReadToolDefinition(services, cfg = normalizeConfig({})) {
  return {
    name: READ_TOOL_NAME,
    description:
      'Read one DSH session without resuming it. mode=surface (default) returns the exact current model context (system, user, assistant text/tool calls, tool results; reasoning hidden unless include_reasoning). mode=raw returns the complete log and can be narrowed with types/from_seq/to_seq/tail. mode=event returns one target seq plus up to 50 events before/after. Output is a bounded transcript (max_chars) with truncation markers; use session_find or a seq window to drill down.',
    parameters: readParameters(cfg),
    output: { schema: READ_OUTPUT_SCHEMA, render: renderText },
    async execute(args, exec) {
      const input = objectArg(args)
      if (typeof input.session !== 'string' || input.session.length === 0) {
        throw new Error(`${READ_TOOL_NAME}: "session" is required`)
      }
      const mode = input.mode ?? 'surface'
      if (!MODES.includes(mode)) {
        throw new Error(`${READ_TOOL_NAME}: "mode" must be one of ${MODES.join(', ')}`)
      }
      const signal = signalOf(exec)
      const includeReasoning = input.include_reasoning === true
      const maxChars = clampInt(input.max_chars, cfg.defaultMaxChars, 1_000, MAX_MAX_CHARS)
      const limit = clampInt(input.limit, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT)
      const sessionQuery = services.sessionQuery
      const title = await loadTitle(sessionQuery, input.session, signal)

      if (mode === 'event') {
        if (typeof input.seq !== 'number' || !Number.isFinite(input.seq)) {
          throw new Error(`${READ_TOOL_NAME}: mode=event requires an integer "seq"`)
        }
        const before = clampInt(input.before, 0, 0, WINDOW_MAX)
        const after = clampInt(input.after, 0, 0, WINDOW_MAX)
        const window = await sessionQuery.readEvent(
          { sessionId: input.session, seq: Math.trunc(input.seq), before, after },
          signal,
        )
        const events = Array.isArray(window?.events) ? window.events : []
        const rendered = renderTranscript(events, {
          maxChars,
          limit: MAX_READ_LIMIT,
          tail: false,
          includeReasoning,
          targetSeq: Math.trunc(input.seq),
        })
        const summary = summarizeEvents(events)
        const header = headerText(window?.session, {
          title,
          ...summary,
          mode: 'event',
          eventCount: events.length,
          capturedThroughSeq: window?.endSeq,
          inheritedEventCount: window?.inheritedEventCount,
        })
        return { text: `${header}\n\n${rendered.text}` }
      }

      const snapshot =
        mode === 'raw' ? await sessionQuery.readSession(input.session) : await sessionQuery.readSurface(input.session)
      let events = Array.isArray(snapshot?.events) ? snapshot.events : []
      const types = Array.isArray(input.types) ? input.types.filter((type) => typeof type === 'string') : []
      if (types.length > 0) events = events.filter((event) => types.includes(event?.type))
      const fromSeq = typeof input.from_seq === 'number' && Number.isFinite(input.from_seq) ? Math.trunc(input.from_seq) : undefined
      const toSeq = typeof input.to_seq === 'number' && Number.isFinite(input.to_seq) ? Math.trunc(input.to_seq) : undefined
      if (fromSeq !== undefined || toSeq !== undefined) {
        events = events.filter(
          (event) =>
            typeof event?.seq === 'number' &&
            (fromSeq === undefined || event.seq >= fromSeq) &&
            (toSeq === undefined || event.seq <= toSeq),
        )
      }
      const rendered = renderTranscript(events, {
        maxChars,
        limit,
        tail: input.tail === true,
        includeReasoning,
      })
      const summary = summarizeEvents(events)
      const lastSeq = events.length > 0 ? events[events.length - 1]?.seq : undefined
      const header = headerText(snapshot?.session, {
        title,
        ...summary,
        mode,
        eventCount: events.length,
        capturedThroughSeq: mode === 'surface' ? snapshot?.capturedThroughSeq : lastSeq,
        inheritedEventCount: snapshot?.inheritedEventCount,
      })
      return { text: `${header}\n\n${rendered.text}` }
    },
  }
}

/** Build the session_find tool definition. */
export function createFindToolDefinition(services) {
  return {
    name: FIND_TOOL_NAME,
    description:
      'Literal, case-insensitive scan of ONE session\'s own rendered event text, including system/developer messages (no full-text index needed; the Web profile ships FTS disabled). Whitespace is normalized, so multi-line phrases match across line breaks. Returns matching seq/type with a short snippet. Use the returned seq with session_read mode=event (before/after) to see the surrounding context. Read-only.',
    parameters: findParameters(),
    output: { schema: FIND_OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const input = objectArg(args)
      if (typeof input.session !== 'string' || input.session.length === 0) {
        throw new Error(`${FIND_TOOL_NAME}: "session" is required`)
      }
      if (typeof input.query !== 'string' || input.query.length === 0) {
        throw new Error(`${FIND_TOOL_NAME}: "query" is required`)
      }
      const limit = clampInt(input.limit, 20, 1, 100)
      const snapshot = await services.sessionQuery.readSession(input.session)
      const events = Array.isArray(snapshot?.events) ? snapshot.events : []
      const needle = normalizeNeedle(input.query)
      const matches = []
      let total = 0
      for (const event of events) {
        if (typeof event?.seq !== 'number') continue
        const text = eventText(event)
        if (text.length === 0) continue
        if (!normalizeNeedle(text).includes(needle)) continue
        total += 1
        if (matches.length >= limit) continue
        matches.push({
          seq: event.seq,
          type: event.type,
          time: event.time,
          surface: typeof event.surface === 'string' ? event.surface : 'log-only',
          snippet: snippetAround(text, input.query, 240),
        })
      }
      return { sessionId: input.session, query: input.query, total, matches }
    },
  }
}

/** Build all three tool definitions for one Agent scope. */
export function createToolDefinitions(services, cfg = normalizeConfig({})) {
  return [createListToolDefinition(services, cfg), createReadToolDefinition(services, cfg), createFindToolDefinition(services)]
}

/**
 * Install the read-only tools into every top-level Agent scope.
 * @param ctx Host Cordis context.
 * @param config Raw `sessionInspect` config; invalid values throw at activation.
 */
export function apply(ctx, config = {}, gate) {
  const cfg = normalizeConfig(config)
  /** @type {Map<object, Array<() => void>>} */
  const installed = new Map()

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`${name}: ${message}`)
    } catch {
      // Logging is best effort.
    }
  }

  const writeStatus = (extra = {}) => {
    const record = {
      activated: true,
      pid: process.pid,
      tools: [LIST_TOOL_NAME, READ_TOOL_NAME, FIND_TOOL_NAME],
      installed: [...installed.keys()].map(agentId).filter((id) => typeof id === 'string'),
      config: cfg,
      at: new Date().toISOString(),
      ...extra,
    }
    try {
      const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), STATUS_FILE)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(record)}\n`)
    } catch {
      // Diagnostics are best effort.
    }
  }

  if (cfg.enabled === false) {
    writeStatus({ reason: 'disabled' })
    return
  }

  const agents = readService(ctx, 'agents')
  const sessionQuery = readService(ctx, 'sessionQuery')
  const workspaceRegistry = readService(ctx, 'workspaceRegistry')
  const missing = []
  if (agents === undefined) missing.push('agents')
  if (sessionQuery === undefined) missing.push('sessionQuery')
  if (missing.length > 0) {
    warn(`not installing tools: missing service(s) ${missing.join(', ')}`)
    writeStatus({ reason: 'missing-services', missing })
    return
  }

  const services = { sessionQuery, workspaceRegistry }

  const maybeInstall = (agent) => {
    if (agent === undefined || installed.has(agent)) return
    const header = agent.session?.header
    if (header?.parentSession !== undefined || header?.origin === 'subagent') return
    const registry = agent.ctx?.tools
    if (registry === undefined || typeof registry.register !== 'function') {
      warn(`agent "${agentId(agent) ?? 'unknown'}" has no tool registry; session-inspect tools not installed`)
      return
    }
    const mount = () => {
      const disposers = []
      try {
        for (const definition of createToolDefinitions(services, cfg)) disposers.push(registry.register(definition))
        return () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose()
            } catch {
              // Disposal is best effort.
            }
          }
        }
      } catch (error) {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // Ignore a partially registered tool.
          }
        }
        throw error
      }
    }
    try {
      installed.set(agent, gate === undefined ? mount() : gate.mount(agent, mount))
      writeStatus()
    } catch (error) {
      warn(`failed to install tools on agent "${agentId(agent) ?? 'unknown'}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const forget = (agent) => {
    const release = installed.get(agent)
    if (release === undefined) return
    installed.delete(agent)
    try {
      release()
    } catch {
      // Disposal is best effort.
    }
    writeStatus()
  }

  const list = typeof agents.list === 'function' ? agents.list() : []
  for (const agent of list) maybeInstall(agent)
  ctx.on?.('agent/created', ({ agent }) => maybeInstall(agent))
  ctx.on?.('agent/disposed', ({ agent }) => forget(agent))
  ctx.effect?.(() => () => {
    for (const agent of [...installed.keys()]) forget(agent)
  })
  writeStatus()
}
