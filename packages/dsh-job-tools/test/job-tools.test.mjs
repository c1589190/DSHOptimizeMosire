import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, chunksToText, normalizeConfig } from '../lib/index.js'

/** One fake Agent scope that records the tools registered into it. */
function makeAgent(id) {
  const tools = new Map()
  return {
    id,
    tools,
    ctx: {
      tools: {
        register(definition) {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
    },
  }
}

/** A job view with the fields the tools read. */
function view(overrides = {}) {
  return {
    id: 'bash-1',
    kind: 'bash',
    label: 'build',
    status: 'completed',
    detail: 'exit code: 0',
    startedAt: 1000,
    finishedAt: 2500,
    output: { total: 20, earliest: 0, spillPaths: ['/tmp/job.log'] },
    ...overrides,
  }
}

/** A fake ctx.jobs with adjustable behavior. */
function makeJobs(options = {}) {
  const state = {
    wait: undefined,
    readAt: undefined,
    read: undefined,
    get: undefined,
  }
  const jobs = {
    async wait(id, timeoutMs, caller, signal) {
      state.wait = { id, timeoutMs, caller, signal }
      return options.wait?.(id, timeoutMs, caller, signal) ?? view()
    },
    get(id, caller) {
      state.get = { id, caller }
      return options.get?.(id, caller) ?? view()
    },
    readAt(id, from, caller) {
      state.readAt = { id, from, caller }
      return options.readAt?.(id, from, caller) ?? {
        chunks: [
          { at: 0, text: 'start\n', channel: 'stdout' },
          { at: 6, text: '\u001b[31merror: x\u001b[0m\n', channel: 'stderr' },
          { at: 40, text: 'log line\n', channel: 'log' },
        ],
        next: 100,
        lossy: false,
      }
    },
    read(id, caller) {
      state.read = { id, caller }
      return options.read?.(id, caller) ?? { chunks: [], next: 0, lossy: false }
    },
  }
  return { jobs, state }
}

/** Build a fake host ctx around agents and jobs. */
function makeCtx(agents, jobs) {
  const handlers = new Map()
  let cleanup
  return {
    get(key) {
      if (key === 'agents') return { list: () => agents }
      if (key === 'jobs') return jobs
      return undefined
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect(fn) {
      cleanup = fn()
    },
    logger: { warn() {} },
    emit(event, payload) {
      handlers.get(event)?.(payload)
    },
    cleanup() {
      cleanup?.()
    },
  }
}

/** Run apply with DSH_HOME isolated and return the tools of the first agent. */
function installed(jobsOptions, config) {
  const home = mkdtempSync(join(tmpdir(), 'dshom-job-tools-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const agents = [makeAgent('session-root'), makeAgent('session-child')]
  const { jobs, state } = makeJobs(jobsOptions)
  const ctx = makeCtx(agents, jobs)
  apply(ctx, config)
  return { home, previous, agents, tools: agents[0].tools, state, ctx }
}

function restore(env) {
  if (env.previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = env.previous
  rmSync(env.home, { recursive: true, force: true })
}

const exec = (signal) => ({ agent: { id: 'session-root' }, signal })

test('installs job_wait and job_read into every live Agent scope', () => {
  const env = installed()
  try {
    for (const agent of env.agents) {
      assert.deepEqual([...agent.tools.keys()].sort(), ['job_read', 'job_wait'])
    }
    assert.equal(readFileSync(join(env.home, 'job-tools-status.json'), 'utf8').includes('session-root'), true)
  } finally {
    restore(env)
  }
})

test('job_wait uses the default timeout and returns status without output', async () => {
  const env = installed()
  try {
    const result = await env.tools.get('job_wait').execute({ job_id: 'bash-1' }, exec())
    assert.equal(env.state.wait.timeoutMs, 600_000)
    assert.equal(env.state.wait.caller, 'session-root')
    assert.equal(result.status, 'completed')
    assert.equal(result.timedOut, false)
    assert.equal(result.detail, 'exit code: 0')
    assert.equal('text' in result, false)
    assert.equal(result.elapsedMs, 1500)
  } finally {
    restore(env)
  }
})

test('job_wait reports a timeout without killing the job and caps the wait', async () => {
  const env = installed({
    wait: () => view({ status: 'running', finishedAt: undefined, detail: undefined }),
  })
  try {
    const result = await env.tools.get('job_wait').execute({ job_id: 'bash-1', timeout_seconds: 99999 }, exec())
    assert.equal(env.state.wait.timeoutMs, 3_600_000)
    assert.equal(result.status, 'running')
    assert.equal(result.timedOut, true)
  } finally {
    restore(env)
  }
})

test('job_wait validates bad timeouts', async () => {
  const env = installed()
  try {
    await assert.rejects(
      env.tools.get('job_wait').execute({ job_id: 'bash-1', timeout_seconds: 0 }, exec()),
      /positive/u,
    )
  } finally {
    restore(env)
  }
})

test('job_read separates stderr, drops log narration, and applies ANSI/duplicate cleanup', async () => {
  const env = installed({
    get: () => view(),
    readAt: () => ({
      chunks: [
        { at: 0, text: '\u001b[32mstart\u001b[0m\n', channel: 'stdout' },
        { at: 14, text: 'same\nsame\nsame\n', channel: 'stdout' },
        { at: 30, text: '\u001b[31merror: x\u001b[0m\n', channel: 'stderr' },
        { at: 50, text: 'log line\n', channel: 'log' },
      ],
      next: 100,
      lossy: false,
    }),
  })
  try {
    const result = await env.tools.get('job_read').execute({ job_id: 'bash-1', from_offset: 0 }, exec())
    assert.equal(env.state.readAt.from, 0)
    assert.match(result.text, /^start/u)
    assert.match(result.text, /same \(×3\)/u)
    assert.match(result.text, /\[stderr\]\nerror: x/u)
    assert.doesNotMatch(result.text, /log line/u)
    assert.equal(result.nextOffset, 100)
    assert.equal(result.mode, 'full')
    assert.equal(result.lossy, false)
    assert.equal(result.dedupedLines, 2)
    assert.deepEqual(result.spillPaths, ['/tmp/job.log'])
  } finally {
    restore(env)
  }
})

test('job_read reports loss and reads from the requested offset', async () => {
  const env = installed({
    get: () => view({ output: { total: 100, earliest: 40, spillPaths: ['/tmp/full.log'] } }),
    readAt: () => ({
      chunks: [{ at: 40, text: 'tail\n', channel: 'stdout', gapBefore: true }],
      next: 100,
      lossy: true,
    }),
  })
  try {
    const result = await env.tools.get('job_read').execute({ job_id: 'bash-1', from_offset: 40 }, exec())
    assert.equal(env.state.readAt.from, 40)
    assert.equal(result.lossy, true)
    assert.match(result.text, /dropped from memory/u)
    assert.match(result.text, /\/tmp\/full\.log/u)
    assert.equal(result.nextOffset, 100)
  } finally {
    restore(env)
  }
})

test('job_read falls back to a final-output result for non-stream jobs', async () => {
  const env = installed({
    get: () => view({ kind: 'workflow', status: 'completed', output: { total: 0, earliest: 0 } }),
    readAt: () => ({ chunks: [], next: 0, lossy: false }),
    read: () => ({ chunks: [], next: 0, lossy: false, result: 'FINAL RESULT' }),
  })
  try {
    const result = await env.tools.get('job_read').execute({ job_id: 'bash-1' }, exec())
    assert.equal(result.text, 'FINAL RESULT')
    assert.equal(result.source, 'result')
    assert.equal(env.state.read.caller, 'session-root')
  } finally {
    restore(env)
  }
})

test('chunksToText keeps stderr in its own section and drops log chunks', () => {
  assert.equal(
    chunksToText([
      { channel: 'stdout', text: 'out\n' },
      { channel: 'stderr', text: 'err\n' },
      { channel: 'log', text: 'narration\n' },
    ]),
    'out\n[stderr]\nerr\n',
  )
})

test('normalizeConfig rejects an inverted timeout window', () => {
  assert.throws(
    () => normalizeConfig({ defaultTimeoutSeconds: 20, maxTimeoutSeconds: 10 }),
    /defaultTimeoutSeconds/u,
  )
})
