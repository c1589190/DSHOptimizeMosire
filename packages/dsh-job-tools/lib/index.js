/**
 * job-tools — model-facing `job_wait` and `job_read` for background jobs.
 *
 * WHY: `job_output` can block, but its wait defaults to 30 s and `wait` defaults
 * to false, so long builds get collected through repeated `sleep` + reads. The
 * two tools here separate the verbs:
 *
 *   job_wait(job_id)  → block until the job settles, return status only
 *   job_read(job_id)  → read output at an absolute offset, apply deterministic
 *                       character compaction, never consume job_output's cursor
 *
 * Creation stays with the producer (`bash` with `run_in_background`): a new
 * start tool would have to duplicate sandbox, policy, persistent-shell, and
 * job-registry admission. Jobs from every producer share the same registry.
 *
 * Installation follows the official per-Agent tool model: register into each
 * live Agent scope, follow `agent/created` / `agent/disposed`, and release all
 * registrations through `ctx.effect`. The tools need only official services
 * (`ctx.agents`, `ctx.jobs`); a missing service installs nothing and warns.
 *
 * @module @mosire/dsh-job-tools
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { OPTIMIZE_DEFAULTS, optimizeJobOutput } from './optimize.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'job-tools'

/** Diagnostic file under `$DSH_HOME`. */
const STATUS_FILE = 'job-tools-status.json'

/** Job lifecycle values exposed by `ctx.jobs`. */
const JOB_STATUSES = ['running', 'stopping', 'completed', 'failed', 'killed']

/** Read modes understood by the optimizer. */
const READ_MODES = ['auto', 'full', 'head', 'tail', 'errors', 'summary', 'raw']

const WAIT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jobId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: JOB_STATUSES },
    detail: { type: 'string' },
    timedOut: { type: 'boolean', required: true },
    elapsedMs: { type: 'integer', required: true },
    startedAt: { type: 'integer', required: true },
    finishedAt: { type: 'integer' },
  },
}

const READ_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jobId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: JOB_STATUSES },
    detail: { type: 'string' },
    mode: { type: 'string', required: true },
    text: { type: 'string', required: true },
    inputLines: { type: 'integer', required: true },
    outputLines: { type: 'integer', required: true },
    inputBytes: { type: 'integer', required: true },
    outputBytes: { type: 'integer', required: true },
    dedupedLines: { type: 'integer', required: true },
    omittedLines: { type: 'integer', required: true },
    omittedBytes: { type: 'integer', required: true },
    matchedErrors: { type: 'integer', required: true },
    lossy: { type: 'boolean', required: true },
    nextOffset: { type: 'integer', required: true },
    spillPaths: { type: 'array', items: { type: 'string' } },
    source: { type: 'string', enum: ['ring', 'result'] },
  },
}

/** Compact parameter spec → JSON Schema. */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec ?? {})) {
    const property = { type: meta.type }
    if (meta.description !== undefined) property.description = meta.description
    if (Array.isArray(meta.enum)) property.enum = meta.enum
    properties[key] = property
    if (meta.required === true) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Compile one compact value spec into the JSON Schema the registry accepts. */
function compileSchema(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return spec
  const result = {}
  if (typeof spec.type === 'string') result.type = spec.type
  if (typeof spec.description === 'string') result.description = spec.description
  if (Array.isArray(spec.enum)) result.enum = spec.enum
  if (spec.type === 'array' && spec.items !== undefined) result.items = compileSchema(spec.items)
  if (spec.properties !== undefined && spec.properties !== null) {
    const properties = {}
    const required = []
    for (const [key, meta] of Object.entries(spec.properties)) {
      const property = compileSchema(meta)
      if (property !== null && typeof property === 'object') delete property.required
      properties[key] = property
      if (meta !== null && typeof meta === 'object' && meta.required === true) required.push(key)
    }
    result.type = 'object'
    result.properties = properties
    if (required.length > 0) result.required = required
    result.additionalProperties = spec.additionalProperties ?? false
  }
  return result
}

function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: toJsonSchema(options.parameters),
    output: {
      schema: compileSchema(options.output.schema),
      render: options.output.render,
    },
    execute: options.execute,
  }
}

function jsonOutput(schema) {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/** Read an optional service without assuming the call succeeds. */
function readService(ctx, key) {
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get(key)
    } catch {
      return undefined
    }
  }
  return ctx[key]
}

/** Validate and fill the activation config. Invalid values throw at mount. */
export function normalizeConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const positive = (value, field, fallback, min, max) => {
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new TypeError(`${name}: ${field} must be a number between ${min} and ${max}`)
    }
    return value
  }
  const cfg = {
    enabled: source.enabled !== false,
    defaultTimeoutSeconds: positive(source.defaultTimeoutSeconds, 'defaultTimeoutSeconds', 600, 1, 86_400),
    maxTimeoutSeconds: positive(source.maxTimeoutSeconds, 'maxTimeoutSeconds', 3600, 1, 86_400),
    maxBytes: Math.trunc(positive(source.maxBytes, 'maxBytes', OPTIMIZE_DEFAULTS.maxBytes, 1024, 262_144)),
    defaultLines: Math.trunc(positive(source.defaultLines, 'defaultLines', OPTIMIZE_DEFAULTS.lines, 1, 2000)),
  }
  if (cfg.defaultTimeoutSeconds > cfg.maxTimeoutSeconds) {
    throw new TypeError(`${name}: defaultTimeoutSeconds must not exceed maxTimeoutSeconds`)
  }
  return cfg
}

/** Stable identity for one Agent scope. */
function agentId(agent) {
  return agent?.id ?? agent?.session?.id
}

/** Join chunk text, keeping stdout and stderr separated and dropping narration. */
export function chunksToText(chunks) {
  const visible = (Array.isArray(chunks) ? chunks : []).filter((chunk) => chunk?.channel !== 'log')
  const stdout = visible.filter((chunk) => chunk.channel !== 'stderr').map((chunk) => chunk.text ?? '').join('')
  const stderr = visible.filter((chunk) => chunk.channel === 'stderr').map((chunk) => chunk.text ?? '').join('')
  const separator = stdout.length > 0 && !stdout.endsWith('\n') ? '\n' : ''
  return stdout + (stderr.length > 0 ? `${separator}[stderr]\n${stderr}` : '')
}

/** Format an optional spill-path list for a loss notice. */
function spillSuffix(spillPaths) {
  return Array.isArray(spillPaths) && spillPaths.length > 0 ? `: ${spillPaths.join(', ')}` : ''
}

/** Register both tools into one exact Agent scope. */
function installTools(agent, jobs, cfg) {
  const registry = agent.ctx?.tools
  if (registry === undefined || typeof registry.register !== 'function') {
    throw new Error(`agent "${agentId(agent) ?? 'unknown'}" has no tool registry`)
  }
  const disposers = []
  try {
    disposers.push(registry.register(defineTool({
      name: 'job_wait',
      description: 'Wait for a background job to finish and return only its final status. Use this after `bash` with `run_in_background` instead of sleeping or polling. A timed-out wait leaves the job running; call job_read for output.',
      parameters: {
        job_id: {
          type: 'string',
          required: true,
          description: 'Job id returned by the tool that started the background work.',
        },
        timeout_seconds: {
          type: 'number',
          description: `Maximum wait in seconds (default ${cfg.defaultTimeoutSeconds}, cap ${cfg.maxTimeoutSeconds}); a timeout leaves the job running.`,
        },
      },
      output: jsonOutput(WAIT_OUTPUT_SCHEMA),
      async execute(args, exec) {
        const caller = exec.agent?.id
        if (caller === undefined) throw new Error('job_wait requires a calling Agent')
        const seconds = args.timeout_seconds === undefined ? cfg.defaultTimeoutSeconds : args.timeout_seconds
        if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
          throw new Error('job_wait: timeout_seconds must be a positive number')
        }
        const bounded = Math.min(seconds, cfg.maxTimeoutSeconds)
        const view = await jobs.wait(args.job_id, bounded * 1000, caller, exec.signal)
        const live = view.status === 'running' || view.status === 'stopping'
        const ended = view.finishedAt ?? Date.now()
        return {
          jobId: view.id,
          status: view.status,
          ...(view.detail === undefined ? {} : { detail: view.detail }),
          timedOut: live,
          elapsedMs: Math.max(0, ended - view.startedAt),
          startedAt: view.startedAt,
          ...(view.finishedAt === undefined ? {} : { finishedAt: view.finishedAt }),
        }
      },
    })))

    disposers.push(registry.register(defineTool({
      name: 'job_read',
      description: 'Read a background job output with deterministic character compaction (ANSI/CR cleanup, adjacent duplicate collapse, head/tail/errors/summary modes). Reads at an absolute offset without consuming job_output\'s cursor; pass the previous nextOffset as from_offset for increments.',
      parameters: {
        job_id: {
          type: 'string',
          required: true,
          description: 'Job id returned by the tool that started the background work.',
        },
        mode: {
          type: 'string',
          enum: READ_MODES,
          description: 'auto (default) uses full when it fits, otherwise summary; raw bypasses every transform.',
        },
        lines: {
          type: 'number',
          description: `Line budget for head/tail/summary (default ${cfg.defaultLines}).`,
        },
        max_bytes: {
          type: 'number',
          description: `UTF-8 byte budget after compaction (default ${cfg.maxBytes}, capped by configuration).`,
        },
        from_offset: {
          type: 'number',
          description: 'Absolute ring byte offset to read from; defaults to 0. Use the previous call\'s nextOffset for an increment.',
        },
      },
      output: jsonOutput(READ_OUTPUT_SCHEMA),
      async execute(args, exec) {
        const caller = exec.agent?.id
        if (caller === undefined) throw new Error('job_read requires a calling Agent')
        const from = args.from_offset === undefined ? 0 : args.from_offset
        if (typeof from !== 'number' || !Number.isSafeInteger(from) || from < 0) {
          throw new Error('job_read: from_offset must be a non-negative integer')
        }
        const view = jobs.get(args.job_id, caller)
        let read = jobs.readAt(args.job_id, from, caller)
        let chunks = read.chunks ?? []
        let lossy = read.lossy === true
        let source = 'ring'
        let resultText
        if (chunks.length === 0 && from === 0 && view.status !== 'running' && view.status !== 'stopping') {
          try {
            const consumed = jobs.read(args.job_id, caller)
            if (Array.isArray(consumed.chunks) && consumed.chunks.length > 0) {
              chunks = consumed.chunks
              lossy = consumed.lossy === true
            }
            if (typeof consumed.result === 'string' && consumed.result.length > 0) {
              resultText = consumed.result
              source = 'result'
            }
          } catch {
            // A consumed final result is unavailable; the ring is still authoritative for stream jobs.
          }
        }
        const spillPaths = view.output?.spillPaths
        let text = chunksToText(chunks)
        if (resultText !== undefined) text = text.length > 0 ? `${text}\n${resultText}` : resultText
        if (lossy || chunks.some((chunk) => chunk?.gapBefore === true)) {
          const notice = `[some output was dropped from memory; full output${spillSuffix(spillPaths) || ': (unavailable)'}]`
          text = text.length > 0 && !text.endsWith('\n') ? `${text}\n${notice}` : `${text}${notice}`
        }
        const optimized = optimizeJobOutput(text, {
          mode: args.mode,
          lines: args.lines ?? cfg.defaultLines,
          maxBytes: Math.min(args.max_bytes ?? cfg.maxBytes, cfg.maxBytes),
        })
        return {
          jobId: view.id,
          status: view.status,
          ...(view.detail === undefined ? {} : { detail: view.detail }),
          mode: optimized.mode,
          text: optimized.text,
          inputLines: optimized.inputLines,
          outputLines: optimized.outputLines,
          inputBytes: optimized.inputBytes,
          outputBytes: optimized.outputBytes,
          dedupedLines: optimized.dedupedLines,
          omittedLines: optimized.omittedLines,
          omittedBytes: optimized.omittedBytes,
          matchedErrors: optimized.matchedErrors,
          lossy,
          nextOffset: read.next ?? view.output?.total ?? 0,
          ...(Array.isArray(spillPaths) && spillPaths.length > 0 ? { spillPaths } : {}),
          ...(source === 'result' ? { source } : {}),
        }
      },
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/**
 * Install the job tools into every Agent scope.
 * @param ctx Host Cordis context.
 * @param config Raw `jobTools` config; invalid values throw at activation.
 */
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  /** @type {Map<object, () => void>} */
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
      tools: ['job_wait', 'job_read'],
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
  const jobs = readService(ctx, 'jobs')
  const missing = []
  if (agents === undefined) missing.push('agents')
  if (jobs === undefined) missing.push('jobs')
  if (missing.length > 0) {
    warn(`not installing tools: missing service(s) ${missing.join(', ')}`)
    writeStatus({ reason: 'missing-services', missing })
    return
  }

  const maybeInstall = (agent) => {
    if (agent === undefined || installed.has(agent)) return
    if (typeof agent.ctx?.tools?.register !== 'function') {
      warn(`agent "${agentId(agent) ?? 'unknown'}" has no tool registry; job tools not installed`)
      return
    }
    try {
      installed.set(agent, installTools(agent, jobs, cfg))
      writeStatus()
    } catch (error) {
      warn(`could not install job tools for agent "${agentId(agent) ?? 'unknown'}": ${String(error?.message ?? error)}`)
    }
  }

  const forget = (agent) => {
    const dispose = installed.get(agent)
    if (dispose === undefined) return
    installed.delete(agent)
    try {
      dispose()
    } catch (error) {
      warn(`could not release job tools for agent "${agentId(agent) ?? 'unknown'}": ${String(error?.message ?? error)}`)
    }
    writeStatus()
  }

  try {
    for (const agent of agents.list()) maybeInstall(agent)
  } catch (error) {
    warn(`could not enumerate live agents: ${String(error?.message ?? error)}`)
  }

  const offCreated = ctx.on?.('agent/created', ({ agent }) => maybeInstall(agent))
  const offDisposed = ctx.on?.('agent/disposed', ({ agent }) => forget(agent))
  ctx.effect?.(() => () => {
    offCreated?.()
    offDisposed?.()
    for (const dispose of installed.values()) {
      try {
        dispose()
      } catch {
        // Unload must not throw.
      }
    }
    installed.clear()
  })

  writeStatus()
}
