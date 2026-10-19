/**
 * Pure configuration and catalog helpers for the subagent-access bundle.
 *
 * Deliberately free of DSH imports and I/O: the mapping between the official
 * `ctx.subagents` / `ctx.agents` vocabulary and the model-facing tool payloads
 * is ordinary plain data, so it can be unit-tested without a Host.
 *
 * @module @mosire/dsh-subagent-access/catalog
 */

/**
 * Model-facing tool names installed into each target Agent scope, in
 * registration order. None of them collides with an Agent Team tool.
 * @type {readonly ['subagent_list', 'subagent_message', 'subagent_interrupt', 'subagent_wait']}
 */
export const TOOL_NAMES = Object.freeze(['subagent_list', 'subagent_message', 'subagent_interrupt', 'subagent_wait'])

/** Defaults for the two supported configuration keys. */
const DEFAULTS = Object.freeze({ enabled: true, includeDelegatedAgents: false })

/**
 * Validate and complete the plugin configuration.
 *
 * Only the two documented boolean keys are accepted; an unknown key or a
 * non-boolean value throws here, at activation, where the row's config is
 * visible. `undefined` / `null` mean "all defaults" (an absent `config:` row).
 * @param {unknown} config - raw plugin config from the bundle row.
 * @returns {{enabled: boolean, includeDelegatedAgents: boolean}} resolved config.
 * @throws {TypeError} when the config is not an object or carries an invalid key.
 */
export function normalizeConfig(config) {
  if (config === undefined || config === null) return { ...DEFAULTS }
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('subagent-access config must be an object')
  }
  for (const key of Object.keys(config)) {
    if (!Object.hasOwn(DEFAULTS, key)) {
      throw new TypeError(`unknown config key "${key}"; supported keys are enabled and includeDelegatedAgents`)
    }
  }
  for (const key of Object.keys(DEFAULTS)) {
    if (Object.hasOwn(config, key) && typeof config[key] !== 'boolean') {
      throw new TypeError(`${key} must be a boolean`)
    }
  }
  return {
    enabled: Object.hasOwn(config, 'enabled') ? config.enabled : DEFAULTS.enabled,
    includeDelegatedAgents: Object.hasOwn(config, 'includeDelegatedAgents')
      ? config.includeDelegatedAgents
      : DEFAULTS.includeDelegatedAgents,
  }
}

/**
 * Whether this plugin should install its tools into one Agent scope.
 *
 * Top-level sessions (absent `delegationDepth`, i.e. zero) are the default
 * target; `includeDelegatedAgents` extends installation to sub-agent sessions.
 * A disabled plugin installs nothing regardless.
 * @param {unknown} agent - live Agent (or a test double) with a session header.
 * @param {{enabled?: boolean, includeDelegatedAgents?: boolean}} config - resolved or raw config.
 * @returns {boolean} whether this scope receives the tools.
 */
export function shouldInstall(agent, config) {
  const resolved = config ?? {}
  if (resolved.enabled === false) return false
  if (resolved.includeDelegatedAgents === true) return true
  return (agent?.session?.header?.delegationDepth ?? 0) === 0
}

/** Coerce an unknown lifecycle mode to the model-facing three-value vocabulary. */
function normalizeMode(mode) {
  return mode === 'continuable' || mode === 'one-shot' ? mode : 'unknown'
}

/**
 * Project official subagent-catalog entries into the rows `subagent_list`
 * promises.
 *
 * Keeps the catalog's parent-event order, drops every field the model does not
 * need, and turns the caller-supplied status lookup into the binary
 * `running` / `inactive` vocabulary: only an Agent currently executing a turn
 * counts as running; a released or never-resident child is inactive.
 * @param {readonly {id: string, mode?: string, label?: string, createdAt: number}[]} entries -
 *   direct-child catalog rows from `ctx.subagents.listChildren`.
 * @param {(id: string) => string | undefined} statusOf - live status lookup,
 *   normally `(id) => ctx.agents.get(id)?.status`.
 * @returns {{id: string, label?: string, mode: 'continuable'|'one-shot'|'unknown', status: 'running'|'inactive', createdAt: number}[]}
 *   model-facing rows; `label` is omitted when the catalog has none.
 */
export function catalogRows(entries, statusOf) {
  if (!Array.isArray(entries)) return []
  const status = typeof statusOf === 'function' ? statusOf : () => undefined
  return entries.map((entry) => {
    const label = typeof entry?.label === 'string' ? entry.label : undefined
    return {
      id: entry.id,
      ...(label === undefined ? {} : { label }),
      mode: normalizeMode(entry.mode),
      status: status(entry.id) === 'running' ? 'running' : 'inactive',
      createdAt: entry.createdAt,
    }
  })
}
