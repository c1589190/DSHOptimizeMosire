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
function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: toJsonSchema(options.parameters),
    output: options.output,
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

/**
 * Install the three tools into one exact Agent scope.
 * @param agent - live Agent owning the target scope.
 * @param agents - `ctx.agents` service for live status.
 * @param subagents - `ctx.subagents` service for listing, delivery, and interruption.
 * @returns disposer releasing every tool registered by this call.
 */
function install(agent, agents, subagents) {
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
      installed.set(agent, install(agent, agents, subagents))
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
