/**
 * Pure decision core of the goal-round confirmation gate.
 *
 * Kept free of Cordis services so the mapping from a user answer / error code
 * to the gate's action is unit-testable without a Host.
 */

/** Option label that deletes the goal; the other option continues the round. */
export const CANCEL_LABEL = '取消并删除 goal'

/** Option label that lets the round continue now. */
export const CONTINUE_LABEL = '继续自动推进'

/** Default configuration for the gate (also what a missing config object means). */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  timeoutSeconds: 30,
  cancelOnClose: true,
})

/** Validate and normalize one plugin config object. Throws on invalid input. */
export function normalizeConfig(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('goal-confirm: config must be an object')
  }
  const unknown = Object.keys(source).filter((key) => !(key in DEFAULT_CONFIG))
  if (unknown.length > 0) {
    throw new TypeError(`goal-confirm: unknown config key(s) ${unknown.join(', ')} — allowed: ${Object.keys(DEFAULT_CONFIG).join(', ')}`)
  }
  const enabled = source.enabled ?? DEFAULT_CONFIG.enabled
  const timeoutSeconds = source.timeoutSeconds ?? DEFAULT_CONFIG.timeoutSeconds
  const cancelOnClose = source.cancelOnClose ?? DEFAULT_CONFIG.cancelOnClose
  if (typeof enabled !== 'boolean') throw new TypeError('goal-confirm: enabled must be a boolean')
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new TypeError('goal-confirm: timeoutSeconds must be an integer between 1 and 3600')
  }
  if (typeof cancelOnClose !== 'boolean') throw new TypeError('goal-confirm: cancelOnClose must be a boolean')
  return { enabled, timeoutSeconds, cancelOnClose }
}

/** Trim a long objective for the question detail without cutting mid-code-point. */
export function summarizeObjective(objective, maxLength = 200) {
  const text = String(objective ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1)}…`
}

/** Build the single ask_user_question item for one goal round. */
export function buildQuestion({ round, maxGoalRounds, objective, timeoutSeconds }) {
  return {
    id: 'goal-round',
    header: 'Goal 续轮',
    question: `第 ${round} 轮（上限 ${maxGoalRounds}）自动续轮：确认继续？`,
    detail: `目标：${summarizeObjective(objective)}\n\n${timeoutSeconds} 秒无操作将自动继续；关闭本卡片视为取消并删除 goal。`,
    options: [
      { label: CONTINUE_LABEL, description: '放行本轮，行为与未启用确认门一致。' },
      { label: CANCEL_LABEL, description: '删除当前 goal，本轮被丢弃，之后不再自动续轮。' },
    ],
  }
}

/**
 * Map one ask outcome to the gate action.
 * @param {{kind:'answer', selected?: string[]} | {kind:'error', code?: string}} outcome
 * @param {{cancelOnClose: boolean}} config
 * @returns {'continue'|'cancel'} 'cancel' means delete the goal.
 */
export function decideOutcome(outcome, config) {
  if (outcome?.kind === 'answer') {
    const selected = Array.isArray(outcome.selected) ? outcome.selected : []
    return selected.includes(CANCEL_LABEL) ? 'cancel' : 'continue'
  }
  const code = outcome?.code
  // Closing the card is a user decision: cancel by default, continue when the
  // deployment opts out of delete-on-close.
  if (code === 'ASK_CANCELLED') return config.cancelOnClose ? 'cancel' : 'continue'
  // Timeout, turn cancellation, delegation, missing provider, unknown errors:
  // never block or kill a goal because the gate itself could not ask.
  return 'continue'
}
