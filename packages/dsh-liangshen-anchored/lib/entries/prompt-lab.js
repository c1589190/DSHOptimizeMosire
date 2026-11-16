/** Component entry: declare only `minimal-prompt-lab` (plus its Host half). */
import { apply as applyPresets } from '../index.js'

export const name = 'preset-minimal-prompt-lab'

export function apply(ctx) {
  return applyPresets(ctx, {
    statusMode: 'merge',
    presets: { liangshen: false, emptySystem: false, promptLab: true },
  })
}
