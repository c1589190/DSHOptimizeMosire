/**
 * subagent-access — model-facing controls for the sub-agent sessions a parent
 * started, installed into each target Agent scope.
 *
 * WHY THIS EXISTS: DSH exposes two control surfaces with the same names. Agent
 * Team owns the host-level `send_message` / `list_agents` / `interrupt_agent`,
 * whose targets are Team members only; the ordinary parent → direct-child
 * control surface lives on the official `ctx.subagents` service but ships with
 * no distinct model-facing names. On a Web profile the Team tools shadow that
 * surface, so a top-level session can start a sub-agent but can then neither
 * list nor message nor interrupt it.
 *
 * This Host plugin closes exactly that gap with three tools whose names are
 * deliberately different from the Team tools, and which call only official
 * public services:
 *
 *   - `subagent_list`      → `ctx.subagents.listChildren` + `ctx.agents` status
 *   - `subagent_message`   → `ctx.subagents.sendMessage`
 *   - `subagent_interrupt` → `ctx.agents` status sample + `ctx.subagents.interrupt`
 *
 * INSTALLATION follows the official Team tool plugin: install into every live
 * Agent scope at activation, follow `agent/created` / `agent/disposed`,
 * collect each scope's tool disposers, and release them through `ctx.effect`.
 * By default only top-level sessions (`delegationDepth` 0) receive the tools;
 * `includeDelegatedAgents: true` extends installation to sub-agent sessions.
 *
 * FAIL-OPEN: a missing `agents` / `subagents` service installs nothing and only
 * warns. The optional `$DSH_HOME/subagent-access-status.json` file is a
 * diagnostic trail; writing it is best effort and can never affect the tools.
 *
 * CONFIG (validated at activation, so a typo fails where it is visible):
 *   - `enabled`: boolean, default true; false installs no tools and registers
 *     no listeners.
 *   - `includeDelegatedAgents`: boolean, default false; true also installs the
 *     tools into delegated (sub-agent) scopes.
 *
 * @module @mosire/dsh-subagent-access
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { TOOL_NAMES, catalogRows, normalizeConfig, shouldInstall } from './catalog.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'subagent-access'

/**
 * Services the tools call. `agents` supplies live status and the calling
 * scope's session; `subagents` owns listing, delivery, and interruption.
 * Both are also re-checked at activation so the plugin fails open (installs
 * nothing) in a composition that lacks either one.
 */
export const inject = ['agents', 'subagents']

/** Diagnostic file name under `$DSH_HOME`. */
const STATUS_FILE = 'subagent-access-status.json'

/** One row promised by `subagent_list`. */
const CHILD_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    label: { type: 'string' },
    mode: { type: 'string', required: true, enum: ['continuable', 'one-shot', 'unknown'] },
    status: { type: 'string', required: true, enum: ['running', 'inactive'] },
    createdAt: { type: 'number', required: true },
  },
}

const LIST_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    children: { type: 'array', required: true, items: CHILD_ROW_SCHEMA },
  },
}

const MESSAGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messageId: { type: 'string', required: true },
  },
}

const LAST_MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', required: true },
    text: { type: 'string', required: true },
    time: { type: 'number', required: true },
  },
}

const WAIT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, enum: ['inactive', 'timeout'] },
    childId: { type: 'string', required: true },
    lastMessage: LAST_MESSAGE_SCHEMA,
  },
}

const INTERRUPT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    previousStatus: { type: 'string', required: true, enum: ['running', 'inactive'] },
  },
}

/**
 * Declare one canonical output schema with compact model-facing JSON, matching
 * the accepted `output` shape used by the official Team tool plugin.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by {@link defineTool}.
 */
function jsonOutput(schema) {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/** Compile the compact parameter spec used by the three tool definitions. */
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

/**
 * Local `defineTool` equivalent: compile the compact parameter spec into a
 * JSON Schema and register the tool definition unchanged. DSH 0.2.1 no longer
 * ships `@deepseek-ai/dsh-tools` in the dsh dependency tree, and this package
 * only needs the plain definition object the registry accepts.
 */
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

/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent, toolName) {
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/** Stable diagnostic identity for one Agent. */
function agentId(agent) {
  return agent?.id ?? agent?.session?.id
}

/**
 * Read an optional service without assuming the call succeeds.
 * @param ctx - Host Cordis context.
 * @param key - service name.
 * @returns the service instance, or undefined when unavailable.
 */
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

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('aborted')
}

/** Wait for one live Agent to finish its current turn (or time out). */
function waitForIdle(child, agents, childId, timeoutSeconds, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    const finish = (value, error) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const onAbort = () => finish(undefined, abortError(signal))
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (timeoutSeconds > 0) timer = setTimeout(() => finish('timeout'), timeoutSeconds * 1000)
    const wait = typeof child.whenIdle === 'function'
      ? child.whenIdle()
      : pollUntilIdle(agents, childId, signal)
    Promise.resolve(wait).then(() => finish('inactive'), (error) => finish(undefined, error))
  })
}

/** Poll a child's live status when the Agent has no whenIdle() helper. */
async function pollUntilIdle(agents, childId, signal) {
  for (;;) {
    const agent = agents.get(childId)
    if (agent === undefined || agent.status === 'idle') return
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 500)
      const onAbort = () => { clearTimeout(timer); reject(abortError(signal)) }
      if (signal?.aborted === true) onAbort()
      else signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }
}

/** Read one child's session events from the live store or a persisted snapshot. */
async function readChildEvents(ctx, childId) {
  const sessions = readService(ctx, 'sessions')
  const live = sessions?.get?.(childId)
  if (live !== undefined && typeof live.snapshotEvents === 'function') {
    try {
      return live.snapshotEvents()
    } catch {
      // Fall through to the query service.
    }
  }
  const query = readService(ctx, 'sessionQuery')
  if (query !== undefined && typeof query.readSession === 'function') {
    try {
      const snapshot = await query.readSession(childId)
      return snapshot?.events
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Select the last non-empty assistant message from a child's events. */
function lastAssistantMessage(events) {
  if (!Array.isArray(events)) return null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const blocks = event.data?.message?.content
    if (!Array.isArray(blocks)) continue
    const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('')
    if (text.trim() === '') continue
    return { role: 'assistant', text, time: event.time }
  }
  return null
}

/**
 * Install the four tools into one exact Agent scope.
 * @param agent - live Agent owning the target scope.
 * @param agents - `ctx.agents` service for live status.
 * @param subagents - `ctx.subagents` service for listing, delivery, and interruption.
 * @returns disposer releasing every tool registered by this call.
 */
function install(ctx, agent, agents, subagents) {
  const registry = agent.ctx.tools
  const disposers = []
  const register = (definition) => {
    disposers.push(registry.register(definition))
  }
  try {
    register(defineTool({
      name: 'subagent_list',
      description: 'List the sub-agent sessions started by this session. One row per direct child: its id, optional label, lifecycle mode, and live status (running while a turn executes, inactive otherwise).',
      parameters: {},
      output: jsonOutput(LIST_OUTPUT_SCHEMA),
      async execute(_args, exec) {
        const caller = callingAgent(exec.agent, 'subagent_list')
        const children = await subagents.listChildren(caller.session.id, exec.signal)
        return { children: catalogRows(children, (id) => agents.get(id)?.status) }
      },
    }))
    register(defineTool({
      name: 'subagent_message',
      description: 'Send a message to a sub-agent session started by this session. A running child receives it at its nearest step boundary; an inactive continuable child starts a new turn; a one-shot child cannot continue. Returns the accepted message id, not the child reply.',
      parameters: {
        child_id: {
          type: 'string',
          required: true,
          description: 'Direct-child session id from subagent_list.',
        },
        message: {
          type: 'string',
          required: true,
          description: 'Self-contained message for the child.',
        },
      },
      output: jsonOutput(MESSAGE_OUTPUT_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'subagent_message')
        const messageId = await subagents.sendMessage(
          caller,
          args.child_id,
          [{ type: 'text', text: args.message }],
          { signal: exec.signal },
        )
        return { messageId }
      },
    }))
    register(defineTool({
      name: 'subagent_interrupt',
      description: 'Interrupt the current turn of a sub-agent session started by this session. The child stays continuable and its own descendants keep running. Returns the status observed before the interrupt.',
      parameters: {
        child_id: {
          type: 'string',
          required: true,
          description: 'Direct-child session id from subagent_list.',
        },
      },
      output: jsonOutput(INTERRUPT_OUTPUT_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'subagent_interrupt')
        const previousStatus = agents.get(args.child_id)?.status === 'running' ? 'running' : 'inactive'
        subagents.interrupt(args.child_id, { kind: 'ancestor', agent: caller })
        return { previousStatus }
      },
    }))
    register(defineTool({
      name: 'subagent_wait',
      description: 'Wait for a direct child sub-agent to stop (become idle), then return its final assistant message. Use this after spawning a background child or after subagent_message when the child result is needed in the same step. Blocks the calling step until the child stops; timeout_seconds bounds the wait (0 or omitted waits indefinitely).',
      parameters: {
        child_id: {
          type: 'string',
          required: true,
          description: 'Direct-child session id from subagent_list.',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Optional maximum wait in seconds; 0 or omitted waits indefinitely.',
        },
      },
      output: jsonOutput(WAIT_OUTPUT_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'subagent_wait')
        const timeoutSeconds = args.timeout_seconds === undefined ? 0 : args.timeout_seconds
        if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
          throw new Error('subagent_wait: timeout_seconds must be a non-negative number')
        }
        const children = await subagents.listChildren(caller.session.id, exec.signal)
        if (!Array.isArray(children) || !children.some((entry) => entry?.id === args.child_id)) {
          throw new Error(`subagent_wait: "${args.child_id}" is not a direct child of this session`)
        }
        const child = agents.get(args.child_id)
        const outcome = child === undefined
          ? 'inactive'
          : await waitForIdle(child, agents, args.child_id, timeoutSeconds, exec.signal)
        if (outcome === 'timeout') return { status: 'timeout', childId: args.child_id }
        const events = await readChildEvents(ctx, args.child_id)
        const lastMessage = lastAssistantMessage(events)
        return {
          status: 'inactive',
          childId: args.child_id,
          ...(lastMessage === null ? {} : { lastMessage }),
        }
      },
    }))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/**
 * Install the parent → child control surface.
 * @param ctx - Host Cordis context.
 * @param config - raw plugin config; invalid values throw here, at activation.
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)

  /** One entry per Agent scope currently receiving the tools. @type {Map<object, () => void>} */
  const installed = new Map()

  /** Warn through the Host logger without letting logging failures escape. */
  function warn(message) {
    try {
      ctx.logger?.warn?.(`${name}: ${message}`)
    } catch {
      // Logging is best effort only.
    }
  }

  /** Best-effort diagnostic write: a read-only DSH_HOME must not break the plugin. */
  function writeStatus(extra) {
    const record = {
      activated: true,
      pid: process.pid,
      config: cfg,
      installed: [...installed.keys()].map(agentId).filter((id) => typeof id === 'string'),
      tools: [...TOOL_NAMES],
      at: new Date().toISOString(),
      ...extra,
    }
    try {
      const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), STATUS_FILE)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(record)}\n`)
    } catch {
      // Diagnostics are best effort only.
    }
  }

  if (cfg.enabled === false) {
    writeStatus({ reason: 'disabled' })
    return
  }

  const agents = readService(ctx, 'agents')
  const subagents = readService(ctx, 'subagents')
  const missing = []
  if (agents === undefined) missing.push('agents')
  if (subagents === undefined) missing.push('subagents')
  if (missing.length > 0) {
    warn(`not installing tools: missing service(s) ${missing.join(', ')}`)
    writeStatus({ reason: 'missing-services', missing })
    return
  }

  /** Install into one Agent scope when it is a target and not already covered. */
  function maybeInstall(agent) {
    if (agent === undefined || installed.has(agent)) return
    if (!shouldInstall(agent, cfg)) return
    if (typeof agent.ctx?.tools?.register !== 'function') {
      warn(`agent "${agentId(agent) ?? 'unknown'}" has no tool registry; tools not installed`)
      return
    }
    try {
      installed.set(agent, install(ctx, agent, agents, subagents))
      writeStatus()
    } catch (error) {
      warn(`could not install tools for agent "${agentId(agent) ?? 'unknown'}": ${String(error?.message ?? error)}`)
    }
  }

  /** Release one Agent scope's tools and forget it. */
  function forget(agent) {
    const dispose = installed.get(agent)
    if (dispose === undefined) return
    installed.delete(agent)
    try {
      dispose()
    } catch (error) {
      warn(`could not release tools for agent "${agentId(agent) ?? 'unknown'}": ${String(error?.message ?? error)}`)
    }
    writeStatus()
  }

  try {
    for (const agent of agents.list()) maybeInstall(agent)
  } catch (error) {
    warn(`could not enumerate live agents: ${String(error?.message ?? error)}`)
  }

  ctx.on('agent/created', ({ agent }) => {
    maybeInstall(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    forget(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) {
      try {
        dispose()
      } catch (error) {
        warn(`could not release tools during unload: ${String(error?.message ?? error)}`)
      }
    }
    installed.clear()
  }, 'subagent-access.scopedTools()')

  writeStatus()
}
