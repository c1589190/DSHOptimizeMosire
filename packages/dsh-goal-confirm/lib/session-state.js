/**
 * Per-session state of the goal-round confirmation gate.
 *
 * The session log is the authority: `/goal-confirm` runs through the official
 * command service, which appends `command/run { name, args }` before the
 * handler. A `sessionProjections` unit folds those events into
 * `{ enabled, timeoutSeconds }`, so resume, replay and fork rebuild the
 * setting without a sidecar file or a new event type.
 *
 * Two deliberate limitations, both documented in the design:
 *   - the projection schemas are duck-typed (`parse`/`safeParse`): this
 *     workspace has no zod dependency and the plugin stays version-agnostic
 *     (no static `@deepseek-ai/*` import). The projection service only calls
 *     `.parse()` today;
 *   - without `sessionProjections` (or `commands`) the state falls back to a
 *     process-local Map, which does not survive a restart.
 */

import {
  COMMAND_NAME,
  DEFAULT_SESSION_STATE,
  SESSION_PROJECTION_KEY,
  SESSION_STATE_VERSION,
  foldCommand,
  isSessionState,
} from './decision.js'

/** Whether a value is the wire view the Web client reads. */
function isWireView(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'enabled' && key !== 'timeoutSeconds' && key !== 'global')) return false
  if (value.enabled !== null && typeof value.enabled !== 'boolean') return false
  if (value.timeoutSeconds !== null
    && (!Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds < 0 || value.timeoutSeconds > 3600)) return false
  const global = value.global
  return global !== null
    && typeof global === 'object'
    && typeof global.enabled === 'boolean'
    && Number.isInteger(global.timeoutSeconds)
    && global.timeoutSeconds >= 0
    && global.timeoutSeconds <= 3600
}

/**
 * Minimal schema object for the projection service: only `parse` is read by
 * `@deepseek-ai/dsh-session-projection`, `safeParse` is provided for parity.
 */
function schemaOf(validate, label) {
  const parse = (value) => {
    if (!validate(value)) throw new TypeError(`goal-confirm: invalid ${label} projection value`)
    return value
  }
  return {
    parse,
    safeParse(value) {
      try {
        return { success: true, data: parse(value) }
      } catch (error) {
        return { success: false, error }
      }
    },
  }
}

/**
 * One projection definition for the gate's session state.
 * @param {{enabled: boolean, timeoutSeconds: number, cancelOnClose: boolean}} config
 */
export function makeProjectionDefinition(config) {
  const global = Object.freeze({ enabled: config.enabled, timeoutSeconds: config.timeoutSeconds })
  let cachedState
  let cachedView
  return {
    key: SESSION_PROJECTION_KEY,
    stateVersion: SESSION_STATE_VERSION,
    stateSchema: schemaOf(isSessionState, 'state'),
    init() {
      return DEFAULT_SESSION_STATE
    },
    apply(state, event) {
      if (event === null || typeof event !== 'object' || event.type !== 'command/run') return state
      const data = event.data
      if (data === null || typeof data !== 'object' || data.name !== COMMAND_NAME) return state
      return foldCommand(state, data.args)
    },
    wire: {
      viewSchema: schemaOf(isWireView, 'view'),
      view(state) {
        if (state === cachedState) return cachedView
        const current = isSessionState(state) ? state : DEFAULT_SESSION_STATE
        cachedState = state
        cachedView = Object.freeze({
          enabled: current.enabled,
          timeoutSeconds: current.timeoutSeconds,
          global,
        })
        return cachedView
      },
    },
  }
}

/** Read one service without trusting `ctx.get`. */
function service(ctx, key) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key]
  } catch {
    return undefined
  }
}

/**
 * Own the per-session state: register the projection when the service exists,
 * keep an in-memory fallback, and answer "what is this agent's override".
 *
 * @param ctx - Host Cordis context.
 * @param config - normalized plugin config.
 * @param warn - best-effort logger.
 */
export function createSessionState(ctx, config, warn = () => {}) {
  const memory = new Map()
  const definition = makeProjectionDefinition(config)
  let registry = service(ctx, 'sessionProjections')
  let installed = false

  const install = (serviceValue) => {
    if (installed || serviceValue === undefined || typeof serviceValue.register !== 'function') return
    try {
      // The service registers itself as an effect on the calling fiber.
      serviceValue.register(definition)
      installed = true
    } catch (error) {
      warn(`could not register the ${SESSION_PROJECTION_KEY} projection: ${String(error?.message ?? error)}`)
    }
  }

  install(registry)
  if (!installed && typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['sessionProjections'], (ready) => {
        registry = service(ready ?? ctx, 'sessionProjections') ?? registry
        install(registry)
      })
    } catch (error) {
      warn(`could not wait for the sessionProjections service: ${String(error?.message ?? error)}`)
    }
  }

  return {
    definition,
    /**
     * Current override for one agent: the log-derived projection first (it
     * survives resume/fork), the process-local note second, absent last.
     */
    stateFor(agent) {
      if (installed && registry !== undefined && agent?.session !== undefined) {
        try {
          const state = registry.stateOf(agent.session, SESSION_PROJECTION_KEY)
          if (state !== undefined) return state
        } catch (error) {
          warn(`could not read the ${SESSION_PROJECTION_KEY} projection: ${String(error?.message ?? error)}`)
        }
      }
      return memory.get(agent?.id)
    },
    /** Fold one command input into the fallback memory (never throws). */
    note(agentId, rawInput) {
      if (typeof agentId !== 'string' || agentId === '') return undefined
      const next = foldCommand(memory.get(agentId) ?? DEFAULT_SESSION_STATE, rawInput)
      memory.set(agentId, next)
      return next
    },
  }
}
