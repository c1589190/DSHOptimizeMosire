/**
 * goal-confirm — human confirmation gate for automatic goal rounds.
 *
 * The official `@deepseek-ai/dsh-goal-round-driver` reserves the next round of
 * an `active + armed` goal and queues a `source.kind === 'goal'` message. This
 * Host plugin registers an outermost `agent/pre-step` listener (`prepend:
 * true`): before the driver's own fence validates the reservation, the listener
 * asks the Web UI to confirm the round through the official
 * `ctx.userQuestions` card.
 *
 *   -「继续自动推进」 → `next()`; the round enters exactly as without this gate.
 *   -「取消并删除 goal」/ closing the card (`ASK_CANCELLED`) → `ctx.goals.clear`
 *     and then `next()`; the driver sees the cleared goal and rejects the round
 *     itself. The gate never fabricates a `reject`, so it cannot fight the
 *     driver's claimed-message restoration.
 *   - No answer within `timeoutSeconds` → the ask is aborted and the round
 *     continues (an unattended session must not hang).
 *
 * FAIL-OPEN BY DESIGN: a missing service, an unconvincing goal view, a
 * delegated (sub) agent, an ask error or a failed clear must never block or
 * kill a session. Every gate failure degrades to `next()` / `continue`.
 *
 * CONFIG (validated at activation, so a typo fails where it is visible):
 *   - `enabled`: boolean, default true; false registers no listener at all.
 *   - `timeoutSeconds`: integer 1..3600, default 30.
 *   - `cancelOnClose`: boolean, default true; false turns a closed card into
 *     "continue this round, keep the goal".
 *
 * The optional `goal-confirm-status.json` file in `$DSH_HOME` is a diagnostic
 * trail for end-to-end verification; writing it is best effort and can never
 * affect the gate.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { buildQuestion, decideOutcome, normalizeConfig } from './decision.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'goal-confirm'

/**
 * Deliberately NO inject list: `goals` and `userQuestions` are optional
 * services in headless/TUI compositions, and a hard injection would make the
 * plugin fail activation where there is nothing to ask. Both are resolved at
 * event time and a missing one fails open.
 */
export const inject = []

/** Diagnostic file name under `$DSH_HOME`. */
const STATUS_FILE = 'goal-confirm-status.json'

/**
 * Install the confirmation gate.
 * @param ctx - Host Cordis context.
 * @param config - raw plugin config; invalid values throw here, at activation.
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)

  /** Best-effort diagnostic write: a read-only DSH_HOME must not break the gate. */
  function writeStatus(record) {
    try {
      const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), STATUS_FILE)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(record)}\n`)
    } catch {
      // Diagnostics are best effort only.
    }
  }

  /** Warn through the Host logger without letting logging failures escape. */
  function warn(message) {
    try {
      ctx.logger?.warn?.(`${name}: ${message}`)
    } catch {
      // Logging is best effort only.
    }
  }

  writeStatus({ activated: true, pid: process.pid, config: cfg })
  if (cfg.enabled === false) return

  /**
   * Promise of the decision for one `${agent.id}:${round}` ask. Keeping the
   * promise (not just a boolean) lets a concurrent pre-step invocation await
   * the same ask instead of opening a second card.
   * @type {Map<string, Promise<{action: 'continue'|'cancel', outcome: string, code?: string}>>}
   */
  const inflight = new Map()

  /**
   * Last settled decision per agent. A second invocation for the SAME round
   * must not ask again even after the first invocation's `next()` returned;
   * one entry per agent keeps this bounded. The goal identity is part of the
   * entry so a NEW goal that happens to reach the same round number asks
   * again instead of reusing the old goal's answer.
   * @type {Map<string, {goalId: string, revision: number, round: number, result: {action: 'continue'|'cancel', outcome: string, code?: string}}>}
   */
  const decided = new Map()

  /**
   * Ask one round through the official question card, with our own timeout and
   * the step's abort signal bridged in. Never rejects: every failure becomes a
   * `continue` decision.
   * @returns {Promise<{action: 'continue'|'cancel', outcome: 'answer'|'timeout'|'cancelled'|'error', code?: string}>}
   */
  async function askRound(questions, agent, goal, round, signal) {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, cfg.timeoutSeconds * 1000)
    const abortFromStep = () => controller.abort()
    if (signal !== undefined) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', abortFromStep, { once: true })
    }
    try {
      const answer = await questions.ask({
        questions: [buildQuestion({
          round,
          maxGoalRounds: goal.maxGoalRounds,
          objective: goal.objective,
          timeoutSeconds: cfg.timeoutSeconds,
        })],
        agent,
        signal: controller.signal,
      })
      const selected = answer?.answers?.[0]?.selected ?? []
      return { action: decideOutcome({ kind: 'answer', selected }, cfg), outcome: 'answer' }
    } catch (error) {
      const code = error?.code
      // Closing the card is a user decision (ASK_CANCELLED); a rejection after
      // our own timer fired is the timeout path; any other abort means the
      // step/turn itself went away and the framework handles the cancellation.
      let outcome = 'error'
      if (code === 'ASK_CANCELLED') outcome = 'cancelled'
      else if (timedOut) outcome = 'timeout'
      else if (code === 'ASK_ABORTED') outcome = 'cancelled'
      return { action: decideOutcome({ kind: 'error', code }, cfg), outcome, code }
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', abortFromStep)
    }
  }

  /** Whether an error means the goal ref we hold is no longer the current one. */
  function isStaleRef(error) {
    return error?.code === 'GOAL_STALE_REVISION' || /stale/i.test(String(error?.message ?? ''))
  }

  /**
   * Remove the goal on a cancel, with the degraded ladder from the design:
   * clear → re-read once and clear the fresh ref → pause the fresh ref → warn
   * and let the round through. Never throws.
   * @returns {Promise<{cleared: boolean, code?: string}>} `cleared` is true only
   *   when a `goals.clear` call actually succeeded.
   */
  async function removeGoal(goals, agent, goal) {
    try {
      goals.clear(agent, { id: goal.id, revision: goal.revision })
      return { cleared: true }
    } catch (error) {
      if (!isStaleRef(error)) {
        warn(`could not clear goal "${goal.id}" (${error?.code ?? 'no code'}): ${String(error?.message ?? error)}`)
        return { cleared: false, code: error?.code }
      }
    }
    // The ref went stale between the view read and the clear; re-read ONCE and
    // retry, staying honest if the fresh ref is already invalid too.
    let fresh
    try {
      fresh = goals.get(agent)
    } catch (error) {
      warn(`could not re-read goal after a stale clear (${error?.code ?? 'no code'}): ${String(error?.message ?? error)}`)
      return { cleared: false, code: error?.code }
    }
    if (fresh === undefined) return { cleared: true }
    const ref = { id: fresh.id, revision: fresh.revision }
    try {
      goals.clear(agent, ref)
      return { cleared: true }
    } catch (error) {
      try {
        goals.pause(agent, ref)
        warn(`clear kept going stale for goal "${fresh.id}"; paused it instead`)
        return { cleared: false, code: error?.code }
      } catch (pauseError) {
        warn(`could not clear or pause goal "${fresh.id}": ${String(pauseError?.message ?? pauseError)}`)
        return { cleared: false, code: pauseError?.code ?? error?.code }
      }
    }
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    const submitted = messages.find((message) => message?.source?.kind === 'goal' && (message.source.round ?? 0) > 0)
    if (submitted === undefined) return next()

    // Optional services: a composition without goals or a human answerer must
    // behave exactly like the official driver alone.
    const goals = ctx.get('goals')
    const questions = ctx.get('userQuestions')
    if (goals === undefined || questions === undefined) return next()

    const agent = payload?.agent
    if (agent === undefined) return next()
    const round = submitted.source.round

    // Subagents cannot ask a human and must never be held or killed by the gate.
    if ((agent.session?.header?.delegationDepth ?? 0) !== 0) return next()

    let goal
    try {
      goal = goals.get(agent)
    } catch (error) {
      warn(`could not read the goal for agent "${agent.id}": ${String(error?.message ?? error)}`)
      return next()
    }
    // Only the exact next admitted round of an active + armed goal is ours to
    // gate. Everything else is left to the driver's own fence (including a
    // paused/disarmed goal and a stale reservation).
    if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return next()
    if (round !== goal.roundsStarted + 1) return next()

    const key = `${agent.id}:${round}`
    let pending = inflight.get(key)
    if (pending === undefined) {
      const remembered = decided.get(agent.id)
      const sameGoal = remembered !== undefined
        && remembered.goalId === goal.id
        && remembered.revision === goal.revision
        && remembered.round === round
      if (sameGoal) {
        // Same round handled again (e.g. a re-claimed pre-step): reuse the
        // decision instead of opening a second card.
        pending = Promise.resolve(remembered.result)
      } else {
        pending = askRound(questions, agent, goal, round, payload.signal)
        inflight.set(key, pending)
      }
    }

    let result
    try {
      result = await pending
    } catch (error) {
      // askRound never rejects, but a gate bug must never block the round.
      warn(`confirmation failed unexpectedly, continuing: ${String(error?.message ?? error)}`)
      result = { action: 'continue', outcome: 'error', code: error?.code }
    }

    let cleared = false
    if (result.action === 'cancel') {
      try {
        cleared = (await removeGoal(goals, agent, goal)).cleared
      } catch (error) {
        warn(`goal removal failed unexpectedly (${error?.code ?? 'no code'}): ${String(error?.message ?? error)}`)
      }
    }

    decided.set(agent.id, { goalId: goal.id, revision: goal.revision, round, result })
    writeStatus({
      activated: true,
      pid: process.pid,
      at: new Date().toISOString(),
      sessionId: agent.id,
      round,
      action: result.action,
      outcome: result.outcome,
      ...(result.code === undefined ? {} : { code: result.code }),
      cleared,
    })

    // On cancel the goal is already gone, so the driver's own fence rejects the
    // round and restores any other claimed messages. Hands off that decision.
    try {
      return await next()
    } finally {
      if (inflight.get(key) === pending) inflight.delete(key)
    }
  }, { prepend: true })
}
