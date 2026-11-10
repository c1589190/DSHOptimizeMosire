/**
 * prompt-lab-session — agent-callable orchestration tools for prompt experiments.
 *
 * WHY: batch prompt experiments need many *independent top-level sessions*, each
 * running the same task under a different system prompt and model. A subagent is
 * the wrong shape (it inherits the caller's context and tool surface), and the
 * official headless runner refuses sessions that carry an agent preset. This
 * package creates a sibling session through the official `sessionController`,
 * inside an existing DSH workspace, and applies a prompt with the preset-scoped
 * `/sp` command.
 *
 * Two tools are installed per top-level Agent scope:
 *
 *   - `prompt_lab_workspaces` — list the configured DSH workspaces so the caller
 *     can choose one before creating anything.
 *   - `prompt_lab_session` — create a sibling session in one existing workspace,
 *     optionally select its system prompt and model, and optionally run one task.
 *
 * The preset is fixed to `minimal-prompt-lab`: the point of the tool is to vary
 * the system prompt, not the agent composition. The prompt text itself is never
 * stored here — the created session's `prompt-lab` projection is the authority.
 *
 * @module @mosire/dsh-prompt-lab-session
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { readPromptFile, sha256 } from '../../dsh-liangshen-anchored/lib/prompt-lab-state.js'

/**
 * Cross-bundle anchored bootstrap gate (see the anchored preset's
 * `tool-bootstrap.mjs`). DSH 0.2.2 keeps a scope's own tool registrations
 * exempt from `tools.restrict()`, so host features registered into the
 * Agent's scope hide themselves through the supported per-step `when`
 * condition instead: the preset publishes this symbol on the Agent and the
 * condition follows its phase. Absent symbol => ordinary visibility.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'prompt-lab-session'

/** Model-facing tool name that creates a session. */
export const TOOL_NAME = 'prompt_lab_session'

/** Model-facing tool name that lists configured workspaces. */
export const WORKSPACES_TOOL_NAME = 'prompt_lab_workspaces'

/** Preset every created session runs. */
export const DEFAULT_PRESET = 'minimal-prompt-lab'

/** Diagnostic file under `$DSH_HOME`. */
const STATUS_FILE = 'prompt-lab-session-status.json'

/** Prompt kinds accepted by the tool. */
const PROMPT_KINDS = ['file', 'text', 'blank', 'default']

const SESSION_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['workspace'],
  properties: {
    workspace: {
      type: 'string',
      description:
        'Configured DSH workspace to create the sibling session in: workspace id, exact title, or path. Call prompt_lab_workspaces first to see the available workspaces.',
    },
    prompt: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: PROMPT_KINDS },
        path: {
          type: 'string',
          description:
            'Prompt file path for kind "file"; relative paths resolve against the workspace path. The file is validated now and read again at the session\'s next request.',
        },
        text: { type: 'string', description: 'Single-line prompt text for kind "text".' },
      },
      description:
        'System prompt selection: file <path>, text <one line>, blank (single space), or default (official persona, clears a selection). Omit to keep the preset default.',
    },
    model: {
      type: 'object',
      additionalProperties: false,
      required: ['provider', 'model'],
      properties: {
        provider: { type: 'string', description: 'LLM provider id, for example "deepseek".' },
        model: { type: 'string', description: 'Model id inside the provider, for example "deepseek-chat".' },
        reasoning_effort: { type: 'string', description: 'Optional reasoning effort advertised by that model.' },
      },
      description: 'Optional per-session model selection. Omit to use the deployment default model.',
    },
    task: {
      type: 'string',
      description:
        'Optional task sent to the new session after the prompt is selected. When present the tool waits for the turn to settle and returns the final assistant text.',
    },
    timeout_seconds: {
      type: 'number',
      description: 'Maximum wait for the task turn (default 600, cap 3600). A timeout returns the session id without killing it.',
    },
  },
}

const SESSION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'preset', 'workspaceId', 'workspacePath', 'cwd', 'status', 'taskSent', 'elapsedMs'],
  properties: {
    sessionId: { type: 'string' },
    preset: { type: 'string' },
    workspaceId: { type: 'string' },
    workspaceTitle: { type: 'string' },
    workspacePath: { type: 'string' },
    cwd: { type: 'string' },
    prompt: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: PROMPT_KINDS },
        path: { type: 'string' },
        bytes: { type: 'integer' },
        sha256: { type: 'string' },
      },
    },
    model: {
      type: 'object',
      additionalProperties: false,
      required: ['provider', 'model'],
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        reasoningEffort: { type: 'string' },
      },
    },
    status: { type: 'string', enum: ['created', 'idle', 'timeout'] },
    taskSent: { type: 'boolean' },
    answer: { type: 'string' },
    elapsedMs: { type: 'integer' },
  },
}

const WORKSPACES_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {},
}

const WORKSPACES_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workspaces'],
  properties: {
    workspaces: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['workspaceId', 'title', 'path', 'sessionCount'],
        properties: {
          workspaceId: { type: 'string' },
          title: { type: 'string' },
          path: { type: 'string' },
          sessionCount: { type: 'integer' },
        },
      },
    },
  },
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

/** Stable identity for one Agent scope. */
function agentId(agent) {
  return agent?.id ?? agent?.session?.id
}

/** Join message text blocks the same way the session verifier does. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('\n')
}

/** Extract the message carried by a message-bearing session event. */
function messageOf(event) {
  return event?.data?.message ?? event?.data
}

/** The last non-empty assistant message in a session snapshot. */
export function lastAssistantText(events) {
  if (!Array.isArray(events)) return ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const text = textOf(messageOf(event)?.content).trim()
    if (text.length > 0) return text
  }
  return ''
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
  }
  if (cfg.defaultTimeoutSeconds > cfg.maxTimeoutSeconds) {
    throw new TypeError(`${name}: defaultTimeoutSeconds must not exceed maxTimeoutSeconds`)
  }
  return cfg
}

/** List the configured workspaces in durable registry order. */
export function listWorkspaces(services) {
  const registry = services.workspaces
  if (registry === undefined || typeof registry.list !== 'function') {
    throw new Error(`${WORKSPACES_TOOL_NAME}: the workspace registry is unavailable`)
  }
  let entities
  try {
    entities = registry.list()
  } catch (error) {
    throw new Error(`${WORKSPACES_TOOL_NAME}: could not list workspaces: ${String(error?.message ?? error)}`, {
      cause: error,
    })
  }
  return (entities ?? []).map((entity) => ({
    workspaceId: String(entity.id),
    title: String(entity.title ?? entity.path ?? entity.id),
    path: String(entity.path ?? ''),
    sessionCount: Array.isArray(entity.sessionIds) ? entity.sessionIds.length : 0,
  }))
}

/** Resolve a workspace argument (id, exact title, or path) to a configured entity. */
async function resolveWorkspace(value, services) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `${TOOL_NAME}: workspace is required; call ${WORKSPACES_TOOL_NAME} to list the configured workspaces`,
    )
  }
  const registry = services.workspaces
  if (registry === undefined) throw new Error(`${TOOL_NAME}: the workspace registry is unavailable`)
  const wanted = value.trim()

  let entity
  try {
    entity = registry.get(wanted)
  } catch {
    entity = undefined
  }
  if (entity === undefined) {
    try {
      entity = registry.list().find((item) => item.title === wanted || item.path === wanted)
    } catch {
      entity = undefined
    }
  }
  if (entity === undefined) {
    try {
      entity = await registry.resolveByPath(wanted)
    } catch {
      entity = undefined
    }
  }
  if (entity === undefined) {
    let available = []
    try {
      available = registry.list().map((item) => `${item.title ?? item.id} (${item.path ?? ''})`)
    } catch {
      // The error below already names the unknown workspace.
    }
    throw new Error(
      `${TOOL_NAME}: workspace "${wanted}" is not configured${available.length > 0 ? `; available: ${available.join(', ')}` : ''}`,
    )
  }
  const workspacePath = String(entity.path ?? '')
  if (workspacePath.length === 0) throw new Error(`${TOOL_NAME}: workspace "${wanted}" has no path`)
  return {
    workspaceId: String(entity.id),
    workspacePath,
    workspaceTitle: String(entity.title ?? workspacePath),
  }
}

/**
 * Validate an optional model selection against the live catalog.
 * @param model - `{provider, model, reasoning_effort?}` as supplied by the caller.
 * @param services - Resolved Host services.
 * @returns The normalized `model/selection` event payload, or undefined.
 */
export async function resolveModel(model, services) {
  if (model === undefined) return undefined
  if (model === null || typeof model !== 'object' || Array.isArray(model)) {
    throw new Error(`${TOOL_NAME}: model must be an object with provider and model`)
  }
  const provider = typeof model.provider === 'string' ? model.provider.trim() : ''
  const id = typeof model.model === 'string' ? model.model.trim() : ''
  const effort = model.reasoning_effort === undefined ? undefined : String(model.reasoning_effort).trim()
  if (provider.length === 0) throw new Error(`${TOOL_NAME}: model.provider must be a non-empty string`)
  if (id.length === 0) throw new Error(`${TOOL_NAME}: model.model must be a non-empty string`)
  if (effort !== undefined && effort.length === 0) {
    throw new Error(`${TOOL_NAME}: model.reasoning_effort must be a non-empty string`)
  }
  if (typeof services.controller?.modelCatalog !== 'function') {
    return { provider, model: id, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
  }
  let catalog
  try {
    catalog = await services.controller.modelCatalog()
  } catch (error) {
    throw new Error(`${TOOL_NAME}: could not read the model catalog: ${String(error?.message ?? error)}`, {
      cause: error,
    })
  }
  const group = (catalog?.groups ?? []).find((item) => item.id === provider)
  const entry = (group?.models ?? []).find((item) => item.id === id)
  if (entry === undefined) {
    const available = (catalog?.groups ?? []).flatMap((item) =>
      (item.models ?? []).map((candidate) => `${item.id}/${candidate.id}`),
    )
    throw new Error(
      `${TOOL_NAME}: model "${provider}/${id}" is not available${available.length > 0 ? `; available: ${available.join(', ')}` : ''}`,
    )
  }
  if (effort !== undefined) {
    const efforts = entry.reasoning?.efforts
    if (
      Array.isArray(efforts) &&
      efforts.length > 0 &&
      !efforts.some((candidate) => (typeof candidate === 'string' ? candidate : candidate?.id) === effort)
    ) {
      throw new Error(`${TOOL_NAME}: reasoning effort "${effort}" is not advertised by ${provider}/${id}`)
    }
  }
  return { provider, model: id, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
}

/** Record one validated model selection for the created session's next request. */
function applyModelSelection(agent, selection) {
  const append = agent?.session?.append
  if (typeof append !== 'function') {
    throw new Error(`${TOOL_NAME}: the created session cannot record a model selection`)
  }
  append.call(agent.session, 'model/selection', selection)
}

/** Validate one prompt selection before any session is created. */
export function preparePrompt(prompt, base) {
  if (prompt === null || typeof prompt !== 'object' || Array.isArray(prompt)) {
    throw new Error(`${TOOL_NAME}: prompt must be an object`)
  }
  const kind = prompt.kind
  if (kind === 'file') {
    if (typeof prompt.path !== 'string' || prompt.path.trim().length === 0) {
      throw new Error(`${TOOL_NAME}: prompt.kind "file" requires prompt.path`)
    }
    const absolute = isAbsolute(prompt.path) ? prompt.path : resolve(base, prompt.path)
    const read = readPromptFile(absolute)
    if (!read.ok) throw new Error(`${TOOL_NAME}: prompt file rejected: ${read.error}`)
    return {
      line: `/sp file ${absolute}`,
      info: { kind: 'file', path: absolute, bytes: read.bytes, sha256: read.sha256 },
    }
  }
  if (kind === 'text') {
    if (typeof prompt.text !== 'string' || prompt.text.length === 0) {
      throw new Error(`${TOOL_NAME}: prompt.kind "text" requires prompt.text`)
    }
    if (/[\r\n]/u.test(prompt.text)) {
      throw new Error(`${TOOL_NAME}: text prompts must be a single line; put multi-line prompts in a file`)
    }
    return {
      line: `/sp text ${prompt.text}`,
      info: { kind: 'text', bytes: Buffer.byteLength(prompt.text, 'utf8'), sha256: sha256(prompt.text) },
    }
  }
  if (kind === 'blank') return { line: '/sp blank', info: { kind: 'blank' } }
  if (kind === 'default') return { line: '/sp clear', info: { kind: 'default' } }
  throw new Error(`${TOOL_NAME}: prompt.kind must be one of ${PROMPT_KINDS.join(', ')}`)
}

/** Wait until the new session's turn settles, or the timeout fires. */
function waitForIdle(agent, seconds, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted === true) {
      reject(new Error(`${TOOL_NAME}: aborted`))
      return
    }
    let settled = false
    let timer
    const finish = (action) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      action()
    }
    const onAbort = () => finish(() => reject(new Error(`${TOOL_NAME}: aborted`)))
    timer = setTimeout(() => finish(() => resolvePromise('timeout')), Math.max(1, seconds) * 1000)
    timer.unref?.()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    Promise.resolve(agent.whenIdle?.()).then(
      () => finish(() => resolvePromise('idle')),
      (error) => finish(() => reject(error)),
    )
  })
}

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]

/** Build the workspace-listing tool definition. */
export function createWorkspacesToolDefinition(services) {
  return {
    name: WORKSPACES_TOOL_NAME,
    description:
      'List the DSH workspaces configured in this Host (workspace id, title, path, and how many sessions each already holds). Call this before prompt_lab_session and pass one of the returned workspace ids, titles, or paths as the "workspace" argument. Sessions created there appear under that workspace in the Web UI.',
    parameters: WORKSPACES_PARAMETERS,
    output: { schema: WORKSPACES_OUTPUT_SCHEMA, render: renderJson },
    async execute() {
      return { workspaces: listWorkspaces(services) }
    },
  }
}

/** Build the session-creating tool definition. */
export function createSessionToolDefinition(services, cfg) {
  return {
    name: TOOL_NAME,
    description:
      'Create a new top-level (sibling) session inside an existing DSH workspace under the minimal-prompt-lab preset, optionally select its system prompt (file, inline text, blank, or default) and model, and optionally run one task. Returns the session id, workspace, applied prompt hash, model, and the final assistant answer when a task runs. The session is independent and appears in the workspace, not as a subagent. Call prompt_lab_workspaces first; the preset is fixed.',
    parameters: SESSION_PARAMETERS,
    output: { schema: SESSION_OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      if (input.cwd !== undefined) {
        throw new Error(
          `${TOOL_NAME}: "cwd" is no longer supported; pass an existing "workspace" (list them with ${WORKSPACES_TOOL_NAME})`,
        )
      }
      if (input.preset !== undefined) {
        throw new Error(`${TOOL_NAME}: the preset is fixed to "${DEFAULT_PRESET}"; remove the "preset" argument`)
      }
      const caller = exec?.agent
      const signal = exec?.signal ?? new AbortController().signal
      if (caller === undefined) throw new Error(`${TOOL_NAME} requires a calling Agent`)
      const timeoutSeconds =
        input.timeout_seconds === undefined
          ? cfg.defaultTimeoutSeconds
          : (() => {
              if (
                typeof input.timeout_seconds !== 'number' ||
                !Number.isFinite(input.timeout_seconds) ||
                input.timeout_seconds <= 0
              ) {
                throw new Error(`${TOOL_NAME}: timeout_seconds must be a positive number`)
              }
              return Math.min(input.timeout_seconds, cfg.maxTimeoutSeconds)
            })()
      const task = typeof input.task === 'string' && input.task.length > 0 ? input.task : undefined

      const target = await resolveWorkspace(input.workspace, services)
      const plan = input.prompt === undefined ? undefined : preparePrompt(input.prompt, target.workspacePath)
      const model = await resolveModel(input.model, services)

      const created = await services.controller.create({
        workspaceId: target.workspaceId,
        agentPreset: DEFAULT_PRESET,
      })
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error(`${TOOL_NAME}: session creation returned no session id`)
      }
      if (created?.agentPreset !== undefined && created.agentPreset !== DEFAULT_PRESET) {
        throw new Error(
          `${TOOL_NAME}: session "${sessionId}" runs preset "${created.agentPreset}", not "${DEFAULT_PRESET}"`,
        )
      }
      const agent = services.agents.get(sessionId)
      if (agent === undefined) throw new Error(`${TOOL_NAME}: created session "${sessionId}" has no live Agent`)
      const startedAt = Date.now()

      if (model !== undefined) applyModelSelection(agent, model)

      if (plan !== undefined) {
        const outcome = await services.commands.execute(agent, plan.line, [], signal)
        if (outcome?.result?.kind !== 'success') {
          throw new Error(`${TOOL_NAME}: ${plan.line.split(' ')[1]} failed: ${outcome?.result?.text ?? 'no result'}`)
        }
      }

      const response = {
        sessionId,
        preset: typeof created?.agentPreset === 'string' ? created.agentPreset : DEFAULT_PRESET,
        workspaceId: target.workspaceId,
        workspaceTitle: target.workspaceTitle,
        workspacePath: target.workspacePath,
        cwd:
          typeof agent.session?.header?.cwd === 'string' && agent.session.header.cwd.length > 0
            ? agent.session.header.cwd
            : target.workspacePath,
        status: 'created',
        taskSent: task !== undefined,
        elapsedMs: 0,
        ...(plan === undefined ? {} : { prompt: plan.info }),
        ...(model === undefined ? {} : { model }),
      }

      if (task !== undefined) {
        await services.controller.prompt(
          { sessionId, content: [{ type: 'text', text: task }], requestId: `prompt-lab-${randomUUID()}` },
          signal,
        )
        response.status = await waitForIdle(agent, timeoutSeconds, signal)
        response.answer = lastAssistantText(agent.session?.snapshotEvents?.() ?? [])
      }

      response.elapsedMs = Math.max(0, Date.now() - startedAt)
      return response
    },
  }
}

/** Build both tool definitions for one Agent scope. */
export function createToolDefinitions(services, cfg = normalizeConfig({})) {
  return [createSessionToolDefinition(services, cfg), createWorkspacesToolDefinition(services)]
}

/**
 * Install both tools into every top-level Agent scope.
 * @param ctx Host Cordis context.
 * @param config Raw `promptLabSession` config; invalid values throw at activation.
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
      tools: [TOOL_NAME, WORKSPACES_TOOL_NAME],
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
  const controller = readService(ctx, 'sessionController')
  const commands = readService(ctx, 'commands')
  const workspaces = readService(ctx, 'workspaceRegistry')
  const missing = []
  if (agents === undefined) missing.push('agents')
  if (controller === undefined) missing.push('sessionController')
  if (commands === undefined) missing.push('commands')
  if (workspaces === undefined) missing.push('workspaceRegistry')
  if (missing.length > 0) {
    warn(`not installing tools: missing service(s) ${missing.join(', ')}`)
    writeStatus({ reason: 'missing-services', missing })
    return
  }

  const services = { agents, controller, commands, workspaces }

  const maybeInstall = (agent) => {
    if (agent === undefined || installed.has(agent)) return
    const header = agent.session?.header
    if (header?.parentSession !== undefined || header?.origin === 'subagent') return
    const registry = agent.ctx?.tools
    if (registry === undefined || typeof registry.register !== 'function') {
      warn(`agent "${agentId(agent) ?? 'unknown'}" has no tool registry; prompt-lab tools not installed`)
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
      warn(`could not install prompt-lab tools for agent "${agentId(agent) ?? 'unknown'}": ${String(error?.message ?? error)}`)
    }
  }

  const forget = (agent) => {
    const release = installed.get(agent)
    if (release === undefined) return
    installed.delete(agent)
    try {
      release()
    } catch (error) {
      warn(`could not release prompt-lab tools for agent "${agentId(agent) ?? 'unknown'}": ${String(error?.message ?? error)}`)
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
    for (const release of installed.values()) {
      try {
        release()
      } catch {
        // Best effort while unloading.
      }
    }
    installed.clear()
    writeStatus({ activated: false })
  })
  writeStatus()
}
