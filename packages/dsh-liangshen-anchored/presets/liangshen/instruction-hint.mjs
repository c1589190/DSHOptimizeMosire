/**
 * instruction-hint — replace `dsh-agent-instructions`' full AGENTS.md/CLAUDE.md
 * injection with a minimal hint, and re-arm that hint after every compaction.
 *
 * WHY: the full workspace-instruction digest is a large injected block. After
 * the anchored bootstrap promotes, we want the model to KNOW the instruction
 * files exist (so it reads them before acting) without dumping their content
 * into every request. The model reads the files itself via the filesystem
 * tools when it needs them.
 *
 * Behavior:
 *  - INITIAL hint: after the session records its first durable promotion signal
 *    (`promoteOn`, default `either`), ONE hint message is injected (once per
 *    session — durable event scan, resume-safe), listing which instruction
 *    files were found:
 *      - user-global: `$DSH_HOME/AGENTS.md`
 *      - project chain: AGENTS.md / CLAUDE.md / AGENTS.local.md / CLAUDE.local.md
 *        walking up from the session cwd to the project root (a directory
 *        containing `.git`, or the cwd itself).
 *    The hint instructs the model to READ the files before acting when
 *    relevant, without embedding their content. Pre-promotion requests get NO
 *    initial hint (matches the anchored bootstrap).
 *
 *  - RECOVERY hint (feature 5): a `compaction/end` rewrites the visible
 *    surface, so the initial hint (and any AGENTS.md content the model read)
 *    can disappear. The FIRST request after EVERY compaction therefore gets a
 *    second hint — injected even while the new epoch is still unpromoted — that
 *    tells the model to restore the working environment: re-read the
 *    instruction files (or locate the repository root first when the workspace
 *    lives elsewhere), recover the status/handoff document that AGENTS.md
 *    points at, and rediscover skills with `skill_search` / `skill_load`
 *    (this preset keeps no skill catalog). The recovery hint is once per
 *    compaction boundary and durable-event deduped, so resume/restart cannot
 *    duplicate it. It uses `source.kind = 'recovery-hint'`, which the
 *    composition's `context-gate.allowKinds` lets through during the gated
 *    first post-compaction request (the tool surface there stays the Minimal
 *    pair). Set `recoveryHint: false` to restore the legacy once-per-session
 *    behavior.
 *
 *  - Files are probed via `ctx.fs` (the host filesystem seam); for the initial
 *    hint a missing fs service or an empty probe degrades to no hint, while the
 *    recovery hint always injects (generic text when no files were found).
 *  - A hint bug must never hurt the session: every failure path degrades to
 *    skipping the hint, never throwing.
 *
 * ROW ORDER: this plugin registers its `agent/pre-step` handler with
 * `prepend: true` and after `tool-bootstrap`, so it runs inside the
 * bootstrap's outermost strip. Initial hint source kind `instruction-hint` and
 * recovery source kind `recovery-hint` are NOT in `suppressedContextSources`,
 * so they are never stripped by the bootstrap filter; the recovery kind is
 * allow-listed in `context-gate.allowKinds` on purpose.
 */

import { createEpochPromotion } from './compaction-epoch.mjs'
import { snapshotSessionEvents } from './session-events.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'instruction-hint'

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Candidate file names, in probe order, for the project chain and user-global. */
const PROJECT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
const USER_GLOBAL_CANDIDATE = 'AGENTS.md'

/** Source kinds this plugin injects. */
const INSTRUCTION_HINT_KIND = 'instruction-hint'
const RECOVERY_HINT_KIND = 'recovery-hint'

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

/** Validate an optional boolean flag with a default. */
function booleanOption(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${name}: ${field} must be a boolean`)
  return value
}

/** Find the project root: first ancestor containing any root marker (e.g. .git). */
async function findProjectRoot(fs, cwd, signal) {
  let current = cwd
  for (;;) {
    for (const marker of ['.git', '.hg', '.svn']) {
      try {
        const target = await fs.resolve(joinPath(current, marker), { cwd, signal })
        const info = await fs.stat(target, signal)
        if (info !== undefined) return current
      } catch {
        // Probe failure = marker absent; continue.
      }
    }
    const parent = parentPath(current)
    if (parent === current || parent.length === 0) return cwd
    current = parent
  }
}

/** List instruction files present in one directory (project candidates). */
async function presentInDir(fs, dir, candidates, signal) {
  const found = []
  for (const candidate of candidates) {
    try {
      const target = await fs.resolve(joinPath(dir, candidate), { cwd: dir, signal })
      const info = await fs.stat(target, signal)
      if (info !== undefined && info.type === 'file') found.push(candidate)
    } catch {
      // Absent or unreadable — skip.
    }
  }
  return found
}

/** Join one path segment onto a directory (platform-agnostic string join). */
function joinPath(dir, segment) {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + segment
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir + sep + segment
}

/** Parent of an absolute Windows or POSIX path. */
function parentPath(path) {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (idx <= 0) return path
  const parent = path.slice(0, idx)
  return parent.length === 0 ? path : parent
}

/** Resolve the DSH home directory used for the user-global instruction file. */
function resolveDshHome() {
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME
  const home = process.env.USERPROFILE ?? process.env.HOME
  return home === undefined || home.length === 0 ? undefined : joinPath(home, '.dsh')
}

/**
 * Probe the workspace instruction files through the host fs seam.
 * Returns `{ fs, cwd, root, projectFiles, userGlobalFiles }`; `fs` is undefined
 * when the service is unavailable, and probe failures degrade to empty lists.
 */
async function probeInstructionFiles(ctx, session, signal) {
  const fs = ctx.get('fs')
  const cwd = session.header?.cwd ?? process.cwd()
  const probe = { fs, cwd, root: undefined, projectFiles: [], userGlobalFiles: [] }
  if (fs === undefined) return probe
  try {
    probe.root = await findProjectRoot(fs, cwd, signal)
    probe.projectFiles = await presentInDir(fs, probe.root, PROJECT_CANDIDATES, signal)
  } catch {
    // Unreadable project probe — keep the generic text.
  }
  try {
    const dshHome = resolveDshHome()
    if (dshHome !== undefined) {
      probe.userGlobalFiles = await presentInDir(fs, dshHome, [USER_GLOBAL_CANDIDATE], signal)
    }
  } catch {
    // Unreadable home probe — ignore.
  }
  return probe
}

/** Text of the once-per-session initial hint, or undefined when nothing was found. */
function composeInitialText(probe) {
  const sections = []
  if (probe.projectFiles.length > 0) {
    sections.push(`Workspace instruction files exist: ${probe.projectFiles.join(', ')} (project root: ${probe.root}).`)
  }
  if (probe.userGlobalFiles.length > 0) {
    sections.push(`A user-global instruction file exists: ${USER_GLOBAL_CANDIDATE}.`)
  }
  if (sections.length === 0) return undefined
  return [
    ...sections,
    'Do NOT assume their content. When a task touches this workspace, read the relevant instruction files first and follow them.',
  ].join(' ')
}

/** Text of the per-compaction recovery hint (always emitted, generic when no files). */
function composeRecoveryText(probe) {
  const parts = [
    'The conversation history was just compacted, so earlier workspace guidance may no longer be visible. Restore the working environment before continuing.',
  ]
  if (probe.projectFiles.length > 0) {
    parts.push(`Read the workspace instruction files and follow them: ${probe.projectFiles.join(', ')} (project root: ${probe.root}).`)
  } else {
    parts.push('If the workspace lives in a parent or subdirectory, locate the repository root first (for example with `git rev-parse --show-toplevel`) and read its AGENTS.md or CLAUDE.md before continuing.')
  }
  if (probe.userGlobalFiles.length > 0) {
    parts.push(`A user-global instruction file exists: ${USER_GLOBAL_CANDIDATE}.`)
  }
  parts.push('If the instruction files point to a status or handoff document, re-read it to restore progress.')
  parts.push('This session keeps no skill catalog: use skill_search to discover skills and skill_load to activate one when the task matches.')
  return parts.join(' ')
}

/** Durable hint already recorded for this session (optionally for one boundary). */
function hasDurableHint(session, kind, boundary) {
  return snapshotSessionEvents(session).some((event) => {
    if (event.type !== 'user/message') return false
    const source = event.data?.message?.source ?? event.data?.source
    if (source?.kind !== kind) return false
    return boundary === undefined || source.boundary === boundary
  })
}

/** Append one hint message to the step decision. */
function appendHint(decision, message) {
  return { ...decision, messages: [...(decision.messages ?? []), message] }
}

/** Build one hint message payload. */
function hintMessage(id, text, source) {
  return { id, role: 'user', content: [{ type: 'text', text }], source }
}

/** Register the promotion/recovery hint injector. */
export function apply(ctx, config = {}) {
  const promoteEvents = parsePromoteOn(config.promoteOn)
  const includeSubagents = booleanOption(config.includeSubagents, 'includeSubagents', false)
  const recoveryEnabled = booleanOption(config.recoveryHint, 'recoveryHint', true)
  const promotion = createEpochPromotion(promoteEvents, { includeSubagents })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  /** Sessions that already received the initial hint. */
  const initialHinted = new Set()
  /** Sessions -> set of compaction boundaries that already received a recovery hint. */
  const recoveryHinted = new Map()
  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    try {
      const session = agent.session
      if (session === undefined) return decision
      const status = promotion.status(agent)

      // ── recovery hint: first request of every post-compaction epoch ──────
      if (recoveryEnabled && status.boundary >= 0) {
        const done = recoveryHinted.get(session.id) ?? new Set()
        if (done.has(status.boundary)) return decision
        // Claim this epoch before any await so concurrent re-entry cannot pass
        // through; the durable scan below covers resume/restart.
        done.add(status.boundary)
        recoveryHinted.set(session.id, done)
        if (hasDurableHint(session, RECOVERY_HINT_KIND, status.boundary)) return decision
        const probe = await probeInstructionFiles(ctx, session, signal)
        return appendHint(decision, hintMessage(
          `recovery-hint-${session.id}-${status.boundary}`,
          composeRecoveryText(probe),
          { kind: RECOVERY_HINT_KIND, form: 'hint', boundary: status.boundary },
        ))
      }

      // ── initial hint: once, after the first promotion ───────────────────
      if (status.promoted !== true) return decision
      if (initialHinted.has(session.id)) return decision
      // Claim this process before inspecting durable state or probing the
      // filesystem, so concurrent re-entry cannot pass through an await. The
      // event scan makes resume safe, but is not an atomic cross-process claim:
      // simultaneous writers can both observe no hint before either persists it.
      initialHinted.add(session.id)
      if (hasDurableHint(session, INSTRUCTION_HINT_KIND)) return decision
      const probe = await probeInstructionFiles(ctx, session, signal)
      if (probe.fs === undefined) return decision
      const text = composeInitialText(probe)
      if (text === undefined) return decision
      return appendHint(decision, hintMessage(
        `instruction-hint-${session.id}`,
        text,
        { kind: INSTRUCTION_HINT_KIND, form: 'hint' },
      ))
    } catch (error) {
      // A hint bug must never hurt the session: skip the hint.
      warnOnce(`${name}: hint injection failed, skipping: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
