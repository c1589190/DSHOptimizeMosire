/** Component entry: declare only the `liangshen-empty-system` preset. */
import { apply as applyPresets } from '../index.js'

export const name = 'preset-liangshen-empty-system'

export function apply(ctx) {
  return applyPresets(ctx, {
    statusMode: 'merge',
    presets: { liangshen: false, emptySystem: true, promptLab: false },
  })
}
