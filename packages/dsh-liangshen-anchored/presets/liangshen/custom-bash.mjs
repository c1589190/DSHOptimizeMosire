/**
 * custom-bash — a Windows-capable `bash` tool that registers under the SAME
 * name (`bash`) as the official persistent bash, with a Minimal-compatible
 * description, but executes through `ctx.subprocess.spawn` instead of a PTY.
 *
 * WHY: DeepSeek's first-request trajectory anchor keys on the tool SCHEMA
 * matching the RL training distribution (issue #11: persistent
 * bash + str_replace_editor anchored 5/5 at maxTokens=256000, pwsh/read
 * 8/8 standard-like). The official persistent bash uses a PTY, and DSH's PTY
 * backend is linux/darwin-only — `subprocess-local` throws "terminal
 * inspection is unsupported on platform win32". A custom tool that presents
 * the same name and a Minimal-like description but spawns Git Bash through
 * the ordinary (cross-platform) subprocess seam keeps the schema anchor
 * without the PTY dependency.
 *
 * Executable resolution, in order (an explicit entry is the ONLY candidate:
 * a miss fails loudly instead of silently substituting a guess):
 *  1. explicit `config.bashPath` or the `DSH_TUI_LIANGSHEN_BASH_PATH`
 *     environment variable (absolute path to a Git Bash bash.exe);
 *  2. a `git` on PATH followed to its installation tree — every Windows Git
 *     install ships bash next to git, wherever it was installed, so this
 *     covers installer, portable, and Scoop layouts (a Scoop `.shim` sidecar
 *     is followed to the real target) — yielding `<root>\bin\bash.exe` and
 *     `<root>\usr\bin\bash.exe`;
 *  3. conventional install roots (`ProgramFiles`, `ProgramFiles(x86)`,
 *     `%LOCALAPPDATA%\Programs\Git`);
 *  4. Scoop's conventional roots (`%SCOOP%`, else `%USERPROFILE%\scoop`)
 *     under `apps\git\current\` — Scoop does not always export `SCOOP`;
 *  5. bare `bash` on PATH.
 * `C:\Windows\System32\bash.exe` (and Sysnative) is the WSL launcher, not
 * the Git Bash executor: it is ALWAYS rejected, so a PATH lookup can never
 * silently hand the model a WSL shell. Resolution runs ONCE at apply time —
 * a total miss warns and SKIPS registration, so `tool-bootstrap`'s
 * missing-tool path fails open to the full catalog instead of registering a
 * `bash` tool whose every call would fail mid-session.
 *
 * Semantics mirror the official bash tool: `bash -c <command>` in a fresh
 * process, bounded output, non-zero exit reported not thrown. No sandbox
 * confinement on Windows (the sandbox backend is linux-only); the tool
 * description says so. The bootstrap catalog pairs this with
 * `str_replace_editor` (Minimal's two tools).
 *
 * OPTIONAL BACKGROUND JOBS (`config.backgroundJobs: true`, default `false`):
 * the tool registers with one extra optional parameter, `run_in_background`,
 * and a call that sets it starts the same `bash -c` process through the host
 * job registry (`ctx.get('jobs')`), returning the registry's job id
 * immediately. Output chunks are pushed into the job ring as they arrive, so
 * `job_output` collects them and `job_kill` terminates the process. The
 * registry is required at apply time and the calling agent session at call
 * time: a deployment that could not collect or stop the work fails loudly at
 * mount, and a call with no owner fails loudly instead of starting an orphan.
 * The default stays OFF, so the existing foreground behavior — and the
 * verified Linux session behavior — is unchanged unless a composition opts in.
 *
 * VERIFICATION: only the foreground path has run in a real session. The
 * background path is unit-tested against fake seams; NOT real-machine
 * verified on Windows, because no Windows host with a Git Bash installation
 * was available to this change.
 */

import { readFileSync } from 'node:fs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'custom-bash'

/** The subprocess and tools services must exist before this tool can register. */
export const inject = ['subprocess', 'tools']

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 64000

/** Longest command excerpt kept as a background job's one-line label. */
const MAX_JOB_LABEL_LENGTH = 80

/** Tool parameter schema for the model-facing command. */
const commandSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The bash command to execute (`bash -c` string domain).',
    },
    workdir: {
      type: 'string',
      description: 'Optional working directory; defaults to the session cwd.',
    },
  },
  required: ['command'],
  additionalProperties: false,
}

/** Opt-in parameter: absent from the schema unless `backgroundJobs` is enabled. */
const runInBackgroundProperty = {
  type: 'boolean',
  description: 'Run the command as a background job and return its job id immediately (collect with job_output, stop with job_kill); no timeout applies. The calling session owns the job.',
}

/** Tool parameter schema used only when `backgroundJobs` is enabled. */
const backgroundCommandSchema = {
  ...commandSchema,
  properties: {
    ...commandSchema.properties,
    run_in_background: runInBackgroundProperty,
  },
}

function addCandidate(candidates, seen, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return
  const key = candidate.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  candidates.push(candidate)
}

/** The explicit override, if any: `config.bashPath`, else the environment variable. */
function explicitBashPath(config, environment) {
  for (const value of [config.bashPath, environment.DSH_TUI_LIANGSHEN_BASH_PATH]) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Return conventional Git Bash locations in deterministic order (explicit config first). */
export function windowsBashCandidates(config = {}, environment = process.env) {
  const explicit = explicitBashPath(config, environment)
  if (explicit !== undefined) return [explicit]

  const candidates = []
  const seen = new Set()
  for (const root of [
    environment.ProgramFiles,
    environment['ProgramFiles(x86)'],
  ]) {
    if (typeof root !== 'string' || root.length === 0) continue
    addCandidate(candidates, seen, `${root}\\Git\\bin\\bash.exe`)
    addCandidate(candidates, seen, `${root}\\Git\\usr\\bin\\bash.exe`)
  }
  if (typeof environment.LOCALAPPDATA === 'string' && environment.LOCALAPPDATA.length > 0) {
    addCandidate(candidates, seen, `${environment.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`)
    addCandidate(candidates, seen, `${environment.LOCALAPPDATA}\\Programs\\Git\\usr\\bin\\bash.exe`)
  }
  // Scoop keeps Git under its own root; SCOOP is exported by some setups, but
  // the per-user default location works without it.
  const scoopRoots = []
  if (typeof environment.SCOOP === 'string' && environment.SCOOP.length > 0) {
    scoopRoots.push(environment.SCOOP)
  }
  if (typeof environment.USERPROFILE === 'string' && environment.USERPROFILE.length > 0) {
    scoopRoots.push(`${environment.USERPROFILE}\\scoop`)
  }
  for (const root of scoopRoots) {
    addCandidate(candidates, seen, `${root}\\apps\\git\\current\\bin\\bash.exe`)
    addCandidate(candidates, seen, `${root}\\apps\\git\\current\\usr\\bin\\bash.exe`)
  }
  addCandidate(candidates, seen, 'bash')
  return candidates
}

/** Windows' System32 bash.exe is a WSL launcher, not the Git Bash executor. */
export function isWindowsSubsystemLauncher(path) {
  return /[\\/]windows[\\/](?:system32|sysnative)[\\/]bash\.exe$/i.test(path)
}

/**
 * Scoop-style shim launchers keep the real target in a sibling `.shim` text
 * file (`path = "..."`); follow it so a PATH-resolved git.exe still yields
 * its installation tree.
 */
export function resolveShimTarget(exePath, reader = readFileSync) {
  for (const sidecar of [exePath.replace(/\.exe$/i, '') + '.shim', `${exePath}.shim`]) {
    try {
      const text = reader(sidecar, 'utf8')
      const match = text.match(/^\s*path\s*=\s*"?(.+?)"?\s*$/mi)
      if (match !== null) return match[1]
    } catch { /* not a shim launcher */ }
  }
  return exePath
}

/** Bash candidates derived from a git.exe inside a Git for Windows tree. */
export function bashCandidatesFromGit(gitPath) {
  if (typeof gitPath !== 'string' || gitPath.length === 0) return []
  const parts = gitPath.replace(/\//g, '\\').split('\\').filter(part => part.length > 0)
  if (parts.at(-1)?.toLowerCase() !== 'git.exe') return []
  const roots = []
  const push = root => {
    if (root.length > 0 && !roots.includes(root)) roots.push(root)
  }
  // <root>\cmd\git.exe and <root>\bin\git.exe -> <root>
  if (parts.length >= 3) push(parts.slice(0, -2).join('\\'))
  // <root>\mingw64\bin\git.exe -> <root>; a plain <root>\cmd layout must not
  // also strip its real root.
  if (parts.length >= 5
    && parts.at(-2)?.toLowerCase() === 'bin'
    && /^mingw(32|64)$/.test(parts.at(-3) ?? '')) {
    push(parts.slice(0, -3).join('\\'))
  }
  const candidates = []
  for (const root of roots) {
    candidates.push(`${root}\\bin\\bash.exe`, `${root}\\usr\\bin\\bash.exe`)
  }
  return candidates
}

/**
 * Follow the PATH-visible git executable to its installation tree: every
 * Windows Git install ships git-bash next to git, wherever it was installed,
 * so this covers installer, portable, and Scoop layouts without hardcoding.
 */
async function gitTreeCandidates(subprocess, failures) {
  let gitPath
  try {
    gitPath = await subprocess.resolveExecutable('git')
  } catch (error) {
    failures.push(`git: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  return bashCandidatesFromGit(resolveShimTarget(gitPath))
}

/** Resolve Git Bash without accidentally accepting the WSL compatibility shim. */
export async function resolveWindowsBash(subprocess, config = {}, environment = process.env) {
  const failures = []
  const explicit = explicitBashPath(config, environment)
  const candidates = explicit !== undefined
    // An explicit path is honored as-is: never silently substitute a guess.
    ? [explicit]
    : [...await gitTreeCandidates(subprocess, failures), ...windowsBashCandidates(config, environment)]
  for (const candidate of candidates) {
    try {
      const resolved = await subprocess.resolveExecutable(candidate)
      if (isWindowsSubsystemLauncher(resolved)) {
        failures.push(`${candidate}: resolved to the Windows Subsystem for Linux launcher`)
        continue
      }
      return resolved
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`Git Bash executable unavailable (${failures.join('; ')})`)
}

/**
 * Validate the opt-in background-job switch and resolve its default.
 *
 * Runs before executable discovery and registration, so a misspelled value
 * fails at mount instead of silently selecting foreground-only behavior.
 * @param config - the raw plugin config; `undefined` means every default.
 * @returns the resolved `{ backgroundJobs }` switch.
 * @throws TypeError when `backgroundJobs` is present and is not a boolean.
 */
export function resolveBackgroundJobsConfig(config) {
  const source = config === undefined ? {} : config
  const backgroundJobs = source.backgroundJobs
  if (backgroundJobs !== undefined && typeof backgroundJobs !== 'boolean') {
    throw new TypeError(`custom-bash: config.backgroundJobs must be a boolean, got ${JSON.stringify(backgroundJobs)}`)
  }
  return { backgroundJobs: backgroundJobs === true }
}

/**
 * One-line job label for a command: its first line with whitespace collapsed,
 * truncated for the model-facing roster. The full command still identifies the
 * work in the job's output ring, so the label only has to be recognizable.
 * @param command - the model's command string.
 * @returns a non-empty label of at most {@link MAX_JOB_LABEL_LENGTH} characters.
 */
export function backgroundJobLabel(command) {
  const firstLine = typeof command === 'string'
    ? command.split(/\r?\n/u)[0].trim().replace(/\s+/gu, ' ')
    : ''
  if (firstLine.length === 0) return 'bash command'
  if (firstLine.length <= MAX_JOB_LABEL_LENGTH) return firstLine
  return `${firstLine.slice(0, MAX_JOB_LABEL_LENGTH - 3)}...`
}

/**
 * The job identity fields fixed before execution starts. Pure, so the
 * `kind`/`label`/`owner` mapping is testable without a job registry.
 * @param shape - the command to label and the owning agent session id.
 * @returns the JobSpec identity subset (`kind`, `label`, `owner`).
 */
export function buildJobSpecShape({ command, owner }) {
  return { kind: 'bash', label: backgroundJobLabel(command), owner }
}

/**
 * Map a settled subprocess onto the jobs seam's terminal outcome vocabulary:
 * cancellation is `killed`, a zero exit is `completed`, and anything else
 * (non-zero code, signal death) is `failed` with the exit code or signal in
 * the detail. This differs from the official bash tool, which reports a
 * non-zero exit as `completed`; here a failed command is a failed job, while
 * the full output still reaches the model through the job ring.
 * @param outcome - the subprocess exit facts.
 * @param cancellation - whether the registry cancelled the job, and its reason.
 * @returns the `JobOutcome` the registry records.
 */
export function backgroundJobOutcome(outcome, { cancelled = false, reason } = {}) {
  if (cancelled) {
    const detail = typeof reason === 'string' && reason.length > 0 ? reason : 'cancelled'
    return { status: 'killed', detail }
  }
  if (outcome.exitCode === 0) return { status: 'completed', detail: 'exit code: 0' }
  const detail = outcome.exitCode === null
    ? `signal: ${outcome.signal ?? 'unknown'}`
    : `exit code: ${outcome.exitCode}`
  return { status: 'failed', detail }
}

/**
 * The owning agent session id for a job, or `undefined` when the call has no
 * live agent. `Agent.id` and `Agent.session.id` are the same SessionId by the
 * runtime's own invariant; the session form is preferred because the jobs
 * seam names ownership by session.
 * @param exec - the tool execution, when the runtime supplied one.
 * @returns the owning session id, when available.
 */
export function backgroundJobOwner(exec) {
  const sessionId = exec?.agent?.session?.id
  if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId
  const agentId = exec?.agent?.id
  if (typeof agentId === 'string' && agentId.length > 0) return agentId
  return undefined
}

/** Read the host job registry, or `undefined` when this composition has none. */
function jobRegistry(ctx) {
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined
    return registry !== null && registry !== undefined && typeof registry.start === 'function' ? registry : undefined
  } catch {
    return undefined
  }
}

function warn(ctx, message) {
  try {
    ctx.logger.warn(message)
  } catch {
    // Logger unavailable — registration is skipped either way.
  }
}

/**
 * Start one background command and wire its process into the job handle.
 *
 * The spawn is synchronous because the jobs seam requires `run()` to return
 * its hooks synchronously; stdout/stderr arrive as raw pipes and are pushed
 * into the job's output ring as chunks, so the model collects them with
 * `job_output` exactly like any other background job. `done` never rejects:
 * every failure path becomes a `JobOutcome` the registry can record.
 *
 * NOT real-machine verified on Windows: this path needs a resolvable Git Bash
 * and a live job registry, and no Windows host was available to exercise it.
 * Only the foreground spawn path has run in a real session.
 *
 * @param ctx - the plugin context (its `subprocess` seam starts the process).
 * @param command - the resolved executable facts and per-call directory.
 * @param job - the producer face the registry issued for this job.
 * @returns the `JobHooks` (`cancel`, `done`) the registry expects.
 */
// NOT real-machine verified on Windows: unit-tested with fake seams only.
function startBackgroundBash(ctx, { bashPath, command, workdir }, job) {
  let handle
  let cancelled = false
  let cancelReason
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  try {
    handle = ctx.subprocess.spawn({
      argv: [bashPath, '-c', command],
      ...workdir !== undefined ? { cwd: workdir } : {},
      stdio: {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
      graceMs: 3000,
    })
  } catch (error) {
    // Keep the job registered and settle it as failed: the model received an
    // id, so the failure must be collectable instead of vanishing.
    settle({ status: 'failed', detail: `bash spawn failed: ${String(error)}` })
    return { cancel: () => {}, done }
  }

  const append = (channel, chunk) => {
    try {
      const text = typeof chunk === 'string' ? chunk : String(chunk)
      if (text.length > 0) job.append(text, { channel })
    } catch {
      // Writes after settlement are dropped by contract, and a throwing
      // producer must never break its own teardown path.
    }
  }
  const wire = (stream, channel) => {
    if (stream === null || stream === undefined) return
    if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8')
    stream.on('data', (chunk) => append(channel, chunk))
    stream.on('error', () => {
      // A stream failure surfaces through the handle's outcome instead.
    })
  }
  wire(handle.stdout, 'stdout')
  wire(handle.stderr, 'stderr')

  handle.done.then(
    (outcome) => settle(backgroundJobOutcome(outcome, { cancelled, reason: cancelReason })),
    (error) => settle(cancelled
      ? backgroundJobOutcome({ exitCode: null, signal: null }, { cancelled, reason: cancelReason })
      : { status: 'failed', detail: `bash spawn failed: ${String(error)}` }),
  )

  return {
    cancel(reason) {
      if (cancelled) return
      cancelled = true
      cancelReason = typeof reason === 'string' && reason.length > 0 ? reason : undefined
      try {
        // The seam's only termination verb; the provider escalates to SIGKILL
        // after its grace period, and `done` settles once the range is gone.
        handle.terminate()
      } catch {
        // The managed range is already gone; `done` still settles.
      }
    },
    done,
  }
}

/**
 * Execute one `run_in_background` call: register the command as a job and
 * return its id without waiting.
 *
 * Both missing prerequisites fail loudly with guidance rather than starting
 * work the calling agent could never collect or stop.
 *
 * NOT real-machine verified on Windows (see {@link startBackgroundBash}).
 *
 * @param ctx - the plugin context (jobs registry and subprocess seam).
 * @param args - the parsed tool arguments.
 * @param exec - the tool execution carrying the calling agent and session cwd.
 * @param runtime - the resolved executable and limits shared with the foreground path.
 * @returns the immediate `started background job <id>` result.
 * @throws Error when the registry or the owning session is unavailable.
 */
function runBackground(ctx, args, exec, { bashPath }) {
  const registry = jobRegistry(ctx)
  if (registry === undefined) {
    throw new Error('custom-bash: background jobs are unavailable in this composition (no job registry exposes start); run this command in the foreground by omitting run_in_background.')
  }
  const owner = backgroundJobOwner(exec)
  if (owner === undefined) {
    throw new Error('custom-bash: run_in_background needs a calling agent session to own the job; run this command in the foreground by omitting run_in_background.')
  }
  const workdir = typeof args.workdir === 'string' && args.workdir.length > 0
    ? args.workdir
    : exec?.agent?.session?.header?.cwd
  const id = registry.start({
    ...buildJobSpecShape({ command: args.command, owner }),
    run(job) {
      return startBackgroundBash(ctx, { bashPath, command: args.command, workdir }, job)
    },
  })
  return { text: `started background job ${id}` }
}

/** Register the model-facing `bash` tool. */
export async function apply(ctx, config) {
  const source = config === undefined ? {} : config
  const { backgroundJobs } = resolveBackgroundJobsConfig(source)
  // Fail at activation, not on the first call: a composition that enables
  // background jobs must mount the host registry (and the model controls).
  if (backgroundJobs && jobRegistry(ctx) === undefined) {
    throw new TypeError('custom-bash: backgroundJobs is enabled but the host job registry is unavailable — ctx.get(\'jobs\') must exist and expose start(spec). Mount @deepseek-ai/dsh-jobs-local in the host composition and @deepseek-ai/dsh-tool-jobs for job_output/job_kill.')
  }
  const timeoutMs = Number.isSafeInteger(source.timeoutMs) && source.timeoutMs > 0 ? source.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxOutputBytes = Number.isSafeInteger(source.maxOutputBytes) && source.maxOutputBytes > 0 ? source.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES

  let bashPath
  try {
    bashPath = await resolveWindowsBash(ctx.subprocess, source)
  } catch (error) {
    // Skip registration on a miss: an absent `bash` in the assembled catalog
    // makes tool-bootstrap fail open to the full catalog, while a registered
    // tool that cannot spawn would fail on every call mid-session.
    warn(ctx, `custom-bash: ${error instanceof Error ? error.message : String(error)} — the Windows bootstrap bash tool is not registered; the bootstrap filter will expose the full catalog`)
    return
  }

  ctx.tools.register({
    name: 'bash',
    description: [
      'Run commands in a bash shell (Git Bash on Windows)',
      '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
      "* You don't have access to the internet via this tool.",
      '* You do have access to a mirror of common linux and python packages via apt and pip.',
      '* State does NOT persist across command calls: each call runs in a fresh shell.',
      "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
      '* Please avoid commands that may produce a very large amount of output.',
      '* NOTE: runs without OS sandbox confinement on Windows (no landlock); treat output as untrusted.',
      ...backgroundJobs
        ? ['* Set `run_in_background: true` on a long-running command to return a job id immediately; collect its output with `job_output` and stop it with `job_kill`.']
        : [],
    ].join('\n'),
    parameters: backgroundJobs ? backgroundCommandSchema : commandSchema,
    timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      // Background work is opt-in by config AND by argument: with the switch
      // off, the foreground body below is exactly the pre-background behavior.
      if (backgroundJobs && args?.run_in_background === true) {
        return runBackground(ctx, args, exec, { bashPath })
      }
      const workdir = typeof args.workdir === 'string' && args.workdir.length > 0
        ? args.workdir
        : exec?.agent?.session?.header?.cwd
      const signal = exec?.signal
      const handle = ctx.subprocess.spawn({
        argv: [bashPath, '-c', args.command],
        ...workdir !== undefined ? { cwd: workdir } : {},
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: maxOutputBytes },
          stderr: { maxBytes: maxOutputBytes },
        },
        ...signal !== undefined ? { signal } : {},
        graceMs: 3000,
      })
      let outcome
      try {
        outcome = await handle.done
      } catch (error) {
        // A spawn-level failure (bad executable, EPERM) surfaces as a throw,
        // which the runtime turns into an isError result.
        throw new Error(`bash spawn failed: ${String(error)}`)
      }
      let stdout = ''
      let stderr = ''
      try {
        stdout = handle.collected.stdout.readFrom(0).text
        stderr = handle.collected.stderr.readFrom(0).text
      } catch {
        // Collected readers may be unavailable on some backends; tolerate.
      }
      const text = [stdout, stderr].filter((part) => part.length > 0).join('\n')
      const tail = text.length > 0 ? text : `exit code: ${outcome.exitCode} (no output)`
      if (outcome.exitCode !== 0) {
        // Non-zero exit is a reported failure, not a throw: the model sees the
        // command output plus the exit code.
        throw new Error(tail)
      }
      return { text: tail }
    },
  })
}
