/**
 * Persona provider of the prompt-lab preset.
 *
 * Replaces the official `@deepseek-ai/dsh-persona` row: instead of a static
 * `prefix`, it registers the same `deployment:persona-prefix` section in the
 * preset's scope with a text *provider*. The provider is evaluated at every
 * assembly and derives the prompt from the session's `prompt-lab` projection:
 *
 *   - pending selection  -> read the file / inline text / blank / official line;
 *   - frozen snapshot    -> replay the first `system/message` text;
 *   - no selection       -> the official Minimal persona line.
 *
 * `complete: true` keeps the session's system message exactly equal to the
 * selected prompt (the assembly restores a complete section as the sole prompt
 * section), `interpolate: false` keeps `{{...}}` literal, and
 * `suppressRuntimeContext()` keeps the runtime-context blob out of the prompt —
 * the same wire shape as the official Minimal preset.
 */

import {
  DEFAULT_SYSTEM_PROMPT,
  PROMPT_LAB_KEY,
  resolveLabPrompt,
} from '../../lib/prompt-lab-state.js'

/** Stable section name owned by `@deepseek-ai/dsh-system-prompt`. */
const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

export const name = 'prompt-lab-persona'

export const inject = ['systemPrompt']

export function apply(ctx) {
  const warned = new Set()
  const warnOnce = (message) => {
    if (warned.has(message)) return
    if (warned.size >= 100) warned.clear()
    warned.add(message)
    ctx.logger?.warn?.(`prompt-lab: ${message}`)
  }

  ctx.systemPrompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    complete: true,
    interpolate: false,
    text: (context) => readPrompt(ctx, context?.agent, warnOnce),
  })
  ctx.systemPrompt.suppressRuntimeContext()
}

function readPrompt(ctx, agent, warn) {
  try {
    const registry = ctx.get?.('sessionProjections')
    if (registry && typeof registry.stateOf === 'function' && agent?.session) {
      const resolved = resolveLabPrompt(registry.stateOf(agent.session, PROMPT_LAB_KEY))
      if (resolved.error !== undefined) warn(resolved.error)
      return resolved.text
    }
  } catch (error) {
    warn(error?.message ?? String(error))
  }
  return DEFAULT_SYSTEM_PROMPT
}
