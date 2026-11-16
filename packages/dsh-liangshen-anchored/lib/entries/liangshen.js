/**
 * Component entry: declare only the `liangshen` preset.
 *
 * The dshom bundle mounts this subpath as one component; toggling it in the
 * plugin manager writes a `disabled` row to the profile patch.
 */
import { apply as applyPresets } from '../index.js'

export const name = 'preset-liangshen'

export function apply(ctx) {
  return applyPresets(ctx, {
    statusMode: 'merge',
    presets: { liangshen: true, emptySystem: false, promptLab: false },
  })
}
