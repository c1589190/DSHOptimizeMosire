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
import { apply as applyJobTools } from '../dsh-job-tools/lib/index.js'

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
/** Mount one feature once every service it needs exists. */
function whenReady(ctx, services, mount) {
  if (services.every((name) => service(ctx, name) !== undefined)) {
    mount(ctx)
    return
  }
  if (typeof ctx.inject === 'function') ctx.inject(services, (ready) => mount(ready ?? ctx))
}

export function apply(ctx, config = {}) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const features = source.features !== null && typeof source.features === 'object' ? source.features : {}

  if (features.presets !== false) applyLiangshen(ctx)
  if (features.goalConfirm !== false) applyGoalConfirm(ctx, source.goalConfirm ?? {})
  if (features.subagentAccess !== false) {
    const subagentConfig = source.subagentAccess ?? {}
    whenReady(ctx, ['agents', 'subagents'], (ready) => applySubagentAccess(ready, subagentConfig))
  }
  if (features.jobTools !== false) {
    const jobConfig = source.jobTools ?? {}
    whenReady(ctx, ['agents', 'jobs'], (ready) => applyJobTools(ready, jobConfig))
  }
}
