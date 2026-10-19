/**
 * `@mosire/dshom` — one Host entry for the whole feature set.
 *
 * The feature implementations stay in their own workspace packages (they have
 * independent tests and status files); this bundle only composes their
 * `apply()` functions so users install and enable ONE plugin row. The preset
 * compositions remain inside `@mosire/dsh-liangshen-anchored`, where the
 * `@deepseek-ai/*` peer symlink farm and relative `./*.mjs` rows resolve.
 */
import { apply as applyLiangshen } from '../dsh-liangshen-anchored/lib/index.js'
import { apply as applyGoalConfirm } from '../dsh-goal-confirm/lib/index.js'
import { apply as applySubagentAccess } from '../dsh-subagent-access/lib/index.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dshom'

/** Read an optional service without assuming the call succeeds. */
function service(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]
  } catch {
    return undefined
  }
}

/**
 * Install every enabled feature. A missing service never blocks the other
 * features: presets wait for `agentPresets` internally, goal-confirm resolves
 * its services at event time, and sub-agent tools defer until `agents` and
 * `subagents` exist.
 */
export function apply(ctx, config = {}) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const features = source.features !== null && typeof source.features === 'object' ? source.features : {}

  if (features.presets !== false) applyLiangshen(ctx)
  if (features.goalConfirm !== false) applyGoalConfirm(ctx, source.goalConfirm ?? {})
  if (features.subagentAccess === false) return

  const subagentConfig = source.subagentAccess ?? {}
  const mountSubagentAccess = (ready) => applySubagentAccess(ready ?? ctx, subagentConfig)
  if (service(ctx, 'agents') !== undefined && service(ctx, 'subagents') !== undefined) {
    mountSubagentAccess(ctx)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['agents', 'subagents'], (ready) => mountSubagentAccess(ready))
  }
}
