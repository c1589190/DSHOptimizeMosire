/**
 * Pure decision core of the goal-round confirmation gate.
 *
 * Kept free of Cordis services so the mapping from a user answer / error code
 * to the gate's action is unit-testable without a Host. The per-session switch
 * lives here too: command grammar, the state the session projection folds, and
 * the merge of a session override over the profile-level config.
 */

/** Option label that deletes the goal; the other option continues the round. */
export const CANCEL_LABEL = '取消并删除 goal'

/** Option label that lets the round continue now. */
export const CONTINUE_LABEL = '继续自动推进'

/** Option label that turns the gate off for this session and continues the round. */
export const SESSION_OFF_LABEL = '本会话不再确认'

/** Slash command that owns the per-session switch. */
export const COMMAND_NAME = 'goal-confirm'

/** Session projection key carrying the per-session override. */
export const SESSION_PROJECTION_KEY = 'goal-confirm'

/** Projection state version; bump when the state shape or fold semantics change. */
export const SESSION_STATE_VERSION = 1

/** No override: both fields follow the profile-level config. */
export const DEFAULT_SESSION_STATE = Object.freeze({ enabled: null, timeoutSeconds: null })

/** Default configuration for the gate (also what a missing config object means). */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  timeoutSeconds: 30,
  cancelOnClose: true,
})

/**
 * Validate and normalize one plugin config object. Throws on invalid input.
 * `timeoutSeconds: 0` means "wait for a human decision, never auto-continue".
 */
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
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 3600) {
    throw new TypeError('goal-confirm: timeoutSeconds must be an integer between 0 and 3600')
  }
  if (typeof cancelOnClose !== 'boolean') throw new TypeError('goal-confirm: cancelOnClose must be a boolean')
  return { enabled, timeoutSeconds, cancelOnClose }
}

/** Whether a value is one valid per-session override object. */
export function isSessionState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'enabled' && key !== 'timeoutSeconds')) return false
  const { enabled, timeoutSeconds } = value
  if (enabled !== null && typeof enabled !== 'boolean') return false
  if (timeoutSeconds !== null && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 3600)) return false
  return true
}

/** Merge a per-session override over the profile config. */
export function resolveConfig(config, sessionState) {
  const state = isSessionState(sessionState) ? sessionState : DEFAULT_SESSION_STATE
  return {
    enabled: state.enabled ?? config.enabled,
    timeoutSeconds: state.timeoutSeconds ?? config.timeoutSeconds,
    cancelOnClose: config.cancelOnClose,
  }
}

/** Whether the session carries any override at all. */
export function hasOverride(sessionState) {
  return isSessionState(sessionState) && (sessionState.enabled !== null || sessionState.timeoutSeconds !== null)
}

/** Human text for one timeout value. */
export function describeTimeout(timeoutSeconds) {
  return timeoutSeconds === 0 ? '等待人工确认（不自动继续）' : `${timeoutSeconds} 秒无操作自动继续`
}

/**
 * Parse one `/goal-confirm` input.
 * @returns {{kind:'status'} | {kind:'set', state:{enabled:boolean|null, timeoutSeconds:number|null}} | {kind:'reset'} | {kind:'error', message:string}}
 */
export function parseCommandInput(rawInput) {
  const text = String(rawInput ?? '').trim()
  if (text === '') return { kind: 'status' }
  const parts = text.split(/\s+/)
  const word = parts[0].toLowerCase()
  const rest = parts.slice(1)
  const extra = () => {
    return { kind: 'error', message: `「/${COMMAND_NAME} ${word}」不接受额外参数（收到：${rest.join(' ')}）` }
  }
  switch (word) {
    case 'on':
      if (rest.length > 0) return extra()
      return { kind: 'set', state: { enabled: true, timeoutSeconds: null } }
    case 'off':
      if (rest.length > 0) return extra()
      return { kind: 'set', state: { enabled: false, timeoutSeconds: null } }
    case 'wait':
      if (rest.length > 0) return extra()
      return { kind: 'set', state: { enabled: true, timeoutSeconds: 0 } }
    case 'timeout': {
      if (rest.length !== 1) {
        return { kind: 'error', message: '用法：/goal-confirm timeout <秒数>（0..3600，0 等同 wait）' }
      }
      const seconds = Number(rest[0])
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
        return { kind: 'error', message: `秒数必须是 0..3600 的整数（收到：${rest[0]}）` }
      }
      return { kind: 'set', state: { enabled: true, timeoutSeconds: seconds } }
    }
    case 'reset':
    case 'default':
      if (rest.length > 0) return extra()
      return { kind: 'reset' }
    default:
      return {
        kind: 'error',
        message: `未知参数「${word}」；用法：/goal-confirm on|off|wait|timeout <秒数>|reset`,
      }
  }
}

/**
 * Fold one `/goal-confirm` input into a session state. Returns the SAME
 * reference for status/error, so a projection can ignore that event at zero
 * cost.
 */
export function foldCommand(state, rawInput) {
  const current = isSessionState(state) ? state : DEFAULT_SESSION_STATE
  const parsed = parseCommandInput(rawInput)
  if (parsed.kind === 'set') return { enabled: parsed.state.enabled, timeoutSeconds: parsed.state.timeoutSeconds }
  if (parsed.kind === 'reset') return DEFAULT_SESSION_STATE
  return current
}

/** Render the three-layer status text for `/goal-confirm` with no argument. */
export function formatStatus(config, sessionState) {
  const state = isSessionState(sessionState) ? sessionState : DEFAULT_SESSION_STATE
  const effective = resolveConfig(config, state)
  const globalText = config.enabled ? describeTimeout(config.timeoutSeconds) : '关闭（enabled:false）'
  let sessionText
  if (!hasOverride(state)) sessionText = '跟随全局'
  else if (state.enabled === false) sessionText = '关闭（本会话不弹卡）'
  else sessionText = describeTimeout(state.timeoutSeconds ?? config.timeoutSeconds)
  return [
    `Goal 续轮确认：${effective.enabled ? describeTimeout(effective.timeoutSeconds) : '关闭（本会话不弹卡）'}`,
    `全局默认：${globalText}`,
    `本会话：${sessionText}`,
    `用法：/${COMMAND_NAME} on|off|wait|timeout <秒数>|reset`,
  ].join('\n')
}

/** Trim a long objective for the question detail without cutting mid-code-point. */
export function summarizeObjective(objective, maxLength = 200) {
  const text = String(objective ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1)}…`
}

/** Build the single ask_user_question item for one goal round. */
export function buildQuestion({ round, maxGoalRounds, objective, timeoutSeconds }) {
  const timeoutText = timeoutSeconds === 0
    ? '将等待人工确认，不会自动继续；关闭本卡片视为取消并删除 goal。'
    : `${timeoutSeconds} 秒无操作将自动继续；关闭本卡片视为取消并删除 goal。`
  return {
    id: 'goal-round',
    header: 'Goal 续轮',
    question: `第 ${round} 轮（上限 ${maxGoalRounds}）自动续轮：确认继续？`,
    detail: `目标：${summarizeObjective(objective)}\n\n${timeoutText}`,
    options: [
      { label: CONTINUE_LABEL, description: '放行本轮，行为与未启用确认门一致。' },
      { label: CANCEL_LABEL, description: '删除当前 goal，本轮被丢弃，之后不再自动续轮。' },
      { label: SESSION_OFF_LABEL, description: '放行本轮，并关闭本会话的续轮确认（之后不再弹卡）。' },
    ],
  }
}

/**
 * Map one ask outcome to the gate action.
 * @param {{kind:'answer', selected?: string[]} | {kind:'error', code?: string}} outcome
 * @param {{cancelOnClose: boolean}} config
 * @returns {'continue'|'cancel'|'continue-off'} 'cancel' means delete the goal;
 *   'continue-off' means continue and disable the gate for this session.
 */
export function decideOutcome(outcome, config) {
  if (outcome?.kind === 'answer') {
    const selected = Array.isArray(outcome.selected) ? outcome.selected : []
    if (selected.includes(SESSION_OFF_LABEL)) return 'continue-off'
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
