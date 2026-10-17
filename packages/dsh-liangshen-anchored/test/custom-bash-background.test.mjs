/**
 * Windows-only `custom-bash` background-job support, exercised on Linux.
 *
 * The plugin's platform gate lives in `agent.cordis.yml` (`disabled` on
 * non-win32), not in `apply`, so a fake subprocess that resolves an executable
 * is enough to mount the tool here. The process itself is faked too: these
 * tests prove the config gate, the tool schema, the call-time ownership guard,
 * and the JobSpec/JobHandle/JobOutcome mapping. They do NOT prove that Git
 * Bash starts on Windows — that path has NOT been real-machine verified.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import {
  apply,
  backgroundJobLabel,
  backgroundJobOutcome,
  backgroundJobOwner,
  buildJobSpecShape,
  resolveBackgroundJobsConfig,
} from '../presets/liangshen/custom-bash.mjs'

const BASH_CONFIG = { bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe' }
const SESSION_EXEC = { agent: { session: { id: 'session-1', header: { cwd: 'C:\\work' } } } }

/**
 * Fake plugin context: captures registrations and exposes a controllable
 * `ctx.get('jobs')`. `jobs` may be a value or a thunk, so a test can make the
 * registry disappear after activation.
 */
function makeContext({ jobs, subprocess } = {}) {
  const registered = []
  const warnings = []
  const ctx = {
    subprocess,
    logger: { warn: (message) => warnings.push(message) },
    tools: {
      register(tool) {
        registered.push(tool)
        return () => {}
      },
    },
    get(name) {
      if (name !== 'jobs') return undefined
      return typeof jobs === 'function' ? jobs() : jobs
    },
  }
  return { ctx, registered, warnings }
}

/** Fake subprocess seam: executable resolution always succeeds; spawn is injected. */
function fakeSubprocess(spawn = () => { throw new Error('spawn was not expected') }) {
  return {
    async resolveExecutable() {
      return '/fake/git-bash'
    },
    spawn,
  }
}

/** A registry stub that mimics `start()`: invoke `run()` once and return the id. */
function jobRegistryStub(id = 'bash-1') {
  const state = { specs: [], appended: [], hooks: undefined }
  return {
    state,
    start(spec) {
      state.specs.push(spec)
      const handle = {
        id,
        append(text, options) {
          state.appended.push({ text, channel: options?.channel })
        },
        updateProgress() {},
      }
      state.hooks = spec.run(handle)
      return id
    },
  }
}

/** A fake process handle with pipe-mode streams and a controllable outcome. */
function fakeProcess() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const state = { terminateCalls: 0 }
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  return {
    state,
    stdout,
    stderr,
    handle: {
      stdout,
      stderr,
      done,
      terminate() {
        state.terminateCalls += 1
        resolveDone({ exitCode: null, signal: 'SIGTERM' })
      },
    },
    finish(outcome) {
      resolveDone(outcome)
    },
  }
}

/** Mount the tool with backgroundJobs enabled and capture the registration. */
async function mountBackgroundTool({ jobs, spawn } = {}) {
  const { ctx, registered } = makeContext({ jobs, subprocess: fakeSubprocess(spawn) })
  await apply(ctx, { ...BASH_CONFIG, backgroundJobs: true })
  assert.equal(registered.length, 1, 'expected exactly one bash registration')
  return registered[0]
}

// ── config validation ──────────────────────────────────────────────────────

test('resolveBackgroundJobsConfig defaults off and rejects non-booleans', () => {
  assert.deepEqual(resolveBackgroundJobsConfig(undefined), { backgroundJobs: false })
  assert.deepEqual(resolveBackgroundJobsConfig({}), { backgroundJobs: false })
  assert.deepEqual(resolveBackgroundJobsConfig({ backgroundJobs: true }), { backgroundJobs: true })
  assert.deepEqual(resolveBackgroundJobsConfig({ backgroundJobs: false }), { backgroundJobs: false })
  for (const invalid of ['yes', 1, 0, null, {}, []]) {
    assert.throws(
      () => resolveBackgroundJobsConfig({ backgroundJobs: invalid }),
      /config\.backgroundJobs must be a boolean/,
      `expected ${JSON.stringify(invalid)} to be rejected`,
    )
  }
})

test('apply rejects a non-boolean backgroundJobs before resolving any executable', async () => {
  let resolved = 0
  const subprocess = {
    async resolveExecutable() {
      resolved += 1
      return '/fake/git-bash'
    },
    spawn() { throw new Error('spawn was not expected') },
  }
  const { ctx, registered } = makeContext({ subprocess })
  await assert.rejects(
    apply(ctx, { ...BASH_CONFIG, backgroundJobs: 'yes' }),
    /backgroundJobs must be a boolean/,
  )
  assert.equal(resolved, 0, 'config validation must run before executable discovery')
  assert.equal(registered.length, 0)
})

// ── schema gating ──────────────────────────────────────────────────────────

test('backgroundJobs: false (and the default) keeps the exact foreground schema and description', async () => {
  for (const config of [{ ...BASH_CONFIG, backgroundJobs: false }, { ...BASH_CONFIG }]) {
    const jobs = jobRegistryStub()
    const { ctx, registered } = makeContext({ jobs, subprocess: fakeSubprocess() })
    await apply(ctx, config)

    assert.equal(registered.length, 1)
    const tool = registered[0]
    assert.equal(tool.name, 'bash')
    assert.deepEqual(Object.keys(tool.parameters.properties), ['command', 'workdir'])
    assert.deepEqual(tool.parameters.required, ['command'])
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(Object.hasOwn(tool.parameters.properties, 'run_in_background'), false)
    assert.doesNotMatch(tool.description, /run_in_background/)
  }
})

test('backgroundJobs: true advertises run_in_background with the job-control hint', async () => {
  const jobs = jobRegistryStub()
  const tool = await mountBackgroundTool({ jobs })

  const property = tool.parameters.properties.run_in_background
  assert.ok(property, 'run_in_background must be advertised')
  assert.equal(property.type, 'boolean')
  assert.match(property.description, /job_output/)
  assert.match(property.description, /job_kill/)
  assert.match(property.description, /immediately/)
  assert.deepEqual(tool.parameters.required, ['command'])
  assert.equal(tool.parameters.additionalProperties, false)
  assert.match(tool.parameters.properties.command.description, /bash command/i)
  assert.match(tool.description, /run_in_background/)
  assert.match(tool.description, /job_output/)
  assert.match(tool.description, /job_kill/)
})

// ── fail-fast activation ───────────────────────────────────────────────────

test('backgroundJobs: true without a job registry fails at apply', async () => {
  for (const jobs of [undefined, {}, { start: 'not a function' }]) {
    const { ctx, registered } = makeContext({ jobs, subprocess: fakeSubprocess() })
    await assert.rejects(
      apply(ctx, { ...BASH_CONFIG, backgroundJobs: true }),
      /backgroundJobs is enabled but the host job registry is unavailable/,
    )
    assert.equal(registered.length, 0, 'a failed activation must not register a tool')
  }
})

// ── call-time guards ───────────────────────────────────────────────────────

test('run_in_background without a calling agent session is refused, not started', async () => {
  const jobs = jobRegistryStub()
  let spawned = 0
  const tool = await mountBackgroundTool({
    jobs,
    spawn() {
      spawned += 1
      throw new Error('spawn was not expected')
    },
  })

  for (const exec of [undefined, {}, { agent: {} }]) {
    await assert.rejects(
      tool.execute({ command: 'sleep 30', run_in_background: true }, exec),
      /calling agent session[\s\S]*foreground/,
    )
  }
  assert.equal(jobs.state.specs.length, 0, 'no job may be registered without an owner')
  assert.equal(spawned, 0)
})

test('a job registry that disappears before the call is refused with foreground guidance', async () => {
  let service = jobRegistryStub()
  let spawned = 0
  const { ctx, registered } = makeContext({
    jobs: () => service,
    subprocess: fakeSubprocess(() => {
      spawned += 1
      throw new Error('spawn was not expected')
    }),
  })
  await apply(ctx, { ...BASH_CONFIG, backgroundJobs: true })
  service = undefined

  await assert.rejects(
    registered[0].execute({ command: 'sleep 30', run_in_background: true }, SESSION_EXEC),
    /background jobs are unavailable[\s\S]*foreground/,
  )
  assert.equal(spawned, 0)
})

// ── JobSpec / JobHandle / JobOutcome mapping ───────────────────────────────

test('a background call returns the job id immediately and maps the spec fields', async () => {
  const jobs = jobRegistryStub('bash-4')
  const proc = fakeProcess()
  const spawnCalls = []
  const tool = await mountBackgroundTool({
    jobs,
    spawn(spec) {
      spawnCalls.push(spec)
      return proc.handle
    },
  })

  const result = await tool.execute(
    { command: 'sleep 5 && echo done', run_in_background: true },
    SESSION_EXEC,
  )

  assert.deepEqual(result, { text: 'started background job bash-4' })
  assert.equal(jobs.state.specs.length, 1)
  const spec = jobs.state.specs[0]
  assert.equal(spec.kind, 'bash')
  assert.equal(spec.owner, 'session-1')
  assert.equal(spec.label, 'sleep 5 && echo done')
  assert.equal(typeof spec.run, 'function')
  assert.ok(jobs.state.hooks, 'run() must return job hooks synchronously')
  assert.equal(typeof jobs.state.hooks.cancel, 'function')
  assert.ok(jobs.state.hooks.done instanceof Promise)

  assert.equal(spawnCalls.length, 1)
  assert.deepEqual(spawnCalls[0].argv, ['/fake/git-bash', '-c', 'sleep 5 && echo done'])
  assert.equal(spawnCalls[0].cwd, 'C:\\work')
  assert.deepEqual(spawnCalls[0].stdio, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  assert.equal(spawnCalls[0].signal, undefined, 'a background job must not inherit the tool-call signal')
  assert.equal(spawnCalls[0].graceMs, 3000)
})

test('streamed chunks reach the job ring with their channels and a zero exit completes', async () => {
  const jobs = jobRegistryStub()
  const proc = fakeProcess()
  const tool = await mountBackgroundTool({ jobs, spawn: () => proc.handle })
  await tool.execute({ command: 'echo hi', run_in_background: true }, SESSION_EXEC)

  proc.stdout.write('hello\n')
  proc.stderr.write('warning\n')
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(jobs.state.appended, [
    { text: 'hello\n', channel: 'stdout' },
    { text: 'warning\n', channel: 'stderr' },
  ])
  assert.equal(proc.state.terminateCalls, 0)

  proc.finish({ exitCode: 0, signal: null })
  assert.deepEqual(await jobs.state.hooks.done, { status: 'completed', detail: 'exit code: 0' })
})

test('a non-zero exit settles failed with the exit code in the detail', async () => {
  const jobs = jobRegistryStub()
  const proc = fakeProcess()
  const tool = await mountBackgroundTool({ jobs, spawn: () => proc.handle })
  await tool.execute({ command: 'exit 3', run_in_background: true }, SESSION_EXEC)

  proc.finish({ exitCode: 3, signal: null })
  assert.deepEqual(await jobs.state.hooks.done, { status: 'failed', detail: 'exit code: 3' })
})

test('a signal death without cancellation settles failed with the signal', async () => {
  const jobs = jobRegistryStub()
  const proc = fakeProcess()
  const tool = await mountBackgroundTool({ jobs, spawn: () => proc.handle })
  await tool.execute({ command: 'some-server', run_in_background: true }, SESSION_EXEC)

  proc.finish({ exitCode: null, signal: 'SIGKILL' })
  assert.deepEqual(await jobs.state.hooks.done, { status: 'failed', detail: 'signal: SIGKILL' })
})

test('cancel terminates the managed process and settles killed with the reason', async () => {
  const jobs = jobRegistryStub()
  const proc = fakeProcess()
  const tool = await mountBackgroundTool({ jobs, spawn: () => proc.handle })
  await tool.execute({ command: 'sleep 300', run_in_background: true }, SESSION_EXEC)

  jobs.state.hooks.cancel('user requested')
  jobs.state.hooks.cancel('duplicate cancel is a no-op')
  assert.equal(proc.state.terminateCalls, 1)
  assert.deepEqual(await jobs.state.hooks.done, { status: 'killed', detail: 'user requested' })
})

test('a spawn failure still returns an id and settles the job failed', async () => {
  const jobs = jobRegistryStub('bash-9')
  const tool = await mountBackgroundTool({
    jobs,
    spawn() {
      throw new Error('EPERM: cannot start process')
    },
  })

  const result = await tool.execute({ command: 'echo hi', run_in_background: true }, SESSION_EXEC)
  assert.deepEqual(result, { text: 'started background job bash-9' })
  assert.deepEqual(await jobs.state.hooks.done, {
    status: 'failed',
    detail: 'bash spawn failed: Error: EPERM: cannot start process',
  })
})

// ── foreground path stays untouched when the switch is off ─────────────────

test('with backgroundJobs off, run_in_background is ignored and the foreground path runs', async () => {
  const jobs = jobRegistryStub()
  const spawnCalls = []
  const handle = {
    collected: {
      stdout: { readFrom: () => ({ text: 'ok\n', nextOffset: 3, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
  }
  const { ctx, registered } = makeContext({
    jobs,
    subprocess: fakeSubprocess((spec) => {
      spawnCalls.push(spec)
      return handle
    }),
  })
  await apply(ctx, { ...BASH_CONFIG, backgroundJobs: false })

  const result = await registered[0].execute({ command: 'echo ok', run_in_background: true }, undefined)
  assert.deepEqual(result, { text: 'ok\n' })
  assert.equal(jobs.state.specs.length, 0, 'the job registry must not be touched')
  assert.equal(spawnCalls.length, 1)
  assert.deepEqual(spawnCalls[0].stdio, {
    stdin: 'ignore',
    stdout: { maxBytes: 64000 },
    stderr: { maxBytes: 64000 },
  })
})

// ── pure helpers ───────────────────────────────────────────────────────────

test('backgroundJobLabel keeps one short line of the command', () => {
  assert.equal(backgroundJobLabel('  echo   hi  \nignored second line'), 'echo hi')
  assert.equal(backgroundJobLabel('\n\n'), 'bash command')
  assert.equal(backgroundJobLabel(undefined), 'bash command')
  const truncated = backgroundJobLabel('x'.repeat(200))
  assert.equal(truncated.length, 80)
  assert.ok(truncated.endsWith('...'))
})

test('buildJobSpecShape carries kind, label and owner', () => {
  assert.deepEqual(
    buildJobSpecShape({ command: 'make build\nmake test', owner: 'session-9' }),
    { kind: 'bash', label: 'make build', owner: 'session-9' },
  )
})

test('backgroundJobOwner prefers the session id and falls back to the agent id', () => {
  assert.equal(backgroundJobOwner(undefined), undefined)
  assert.equal(backgroundJobOwner({}), undefined)
  assert.equal(backgroundJobOwner({ agent: {} }), undefined)
  assert.equal(backgroundJobOwner({ agent: { id: 'agent-1' } }), 'agent-1')
  assert.equal(
    backgroundJobOwner({ agent: { id: 'agent-1', session: { id: 'session-1' } } }),
    'session-1',
  )
})

test('backgroundJobOutcome maps exit facts onto the terminal vocabulary', () => {
  assert.deepEqual(backgroundJobOutcome({ exitCode: 0, signal: null }), {
    status: 'completed',
    detail: 'exit code: 0',
  })
  assert.deepEqual(backgroundJobOutcome({ exitCode: 2, signal: null }), {
    status: 'failed',
    detail: 'exit code: 2',
  })
  assert.deepEqual(backgroundJobOutcome({ exitCode: null, signal: 'SIGTERM' }), {
    status: 'failed',
    detail: 'signal: SIGTERM',
  })
  assert.deepEqual(backgroundJobOutcome({ exitCode: null, signal: null }, { cancelled: true }), {
    status: 'killed',
    detail: 'cancelled',
  })
  assert.deepEqual(
    backgroundJobOutcome({ exitCode: 0, signal: null }, { cancelled: true, reason: 'job_kill' }),
    { status: 'killed', detail: 'job_kill' },
  )
})
