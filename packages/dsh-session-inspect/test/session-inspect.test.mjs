import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FIND_TOOL_NAME,
  LIST_TOOL_NAME,
  READ_TOOL_NAME,
  apply,
  createFindToolDefinition,
  createListToolDefinition,
  createReadToolDefinition,
  eventText,
  normalizeConfig,
} from '../lib/index.js'

const HEADER_A = {
  version: 1,
  id: 'session-a',
  createdAt: 1_700_000_000_000,
  cwd: '/work/a',
  isSeeded: false,
  agentPreset: 'minimal-prompt-lab',
}
const HEADER_B = {
  version: 1,
  id: 'session-b',
  createdAt: 1_700_000_100_000,
  cwd: '/work/b',
  isSeeded: false,
  agentPreset: 'minimal',
}
const HEADER_C = {
  version: 1,
  id: 'session-c',
  createdAt: 1_700_000_200_000,
  cwd: '/work/a',
  isSeeded: false,
  parentSession: 'session-a',
  origin: 'subagent',
}

const RECORDS = [
  { header: HEADER_A, live: true, persisted: true },
  { header: HEADER_B, live: false, persisted: true },
  { header: HEADER_C, live: true, persisted: true },
]

const SYSTEM = {
  seq: 1,
  type: 'system/message',
  data: { message: { role: 'system', content: [{ type: 'text', text: 'You are PROMPT-A' }] } },
}
const USER = {
  seq: 2,
  type: 'user/message',
  data: { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
}
const ASSISTANT = {
  seq: 3,
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hi there' },
        { type: 'reasoning', text: 'secret planning' },
        { type: 'tool-call', name: 'bash', arguments: '{"command":"ls"}' },
      ],
      source: { kind: 'model', provider: 'deepseek', model: 'chat' },
    },
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0, totalTokens: 17 },
  },
}
const TOOL_RESULT = {
  seq: 4,
  type: 'tool/result',
  data: { message: { role: 'tool', content: [{ type: 'text', text: 'file.txt' }] } },
}
const REQUEST = {
  seq: 5,
  type: 'request/header',
  data: {
    header: {
      config: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high', maxTokens: 8000 },
      tools: [{ name: 'bash' }, { name: 'read_image' }],
    },
  },
}
const TURN_END = { seq: 6, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
const RAW_EVENTS = [SYSTEM, USER, ASSISTANT, TOOL_RESULT, REQUEST, TURN_END]

function headerOf(id) {
  if (id === 'session-a') return HEADER_A
  if (id === 'session-b') return HEADER_B
  if (id === 'session-c') return HEADER_C
  return { version: 1, id, createdAt: 0, isSeeded: false }
}

function makeQuery(overrides = {}) {
  const calls = []
  const titles = {
    'session-a': { title: 'Experiment A', messageSeqs: [2], source: 'model', eventSeq: 2, updatedAt: 3 },
  }
  return {
    calls,
    async listSessions() {
      calls.push(['listSessions'])
      return RECORDS
    },
    async readTitleSnapshots(ids) {
      calls.push(['readTitleSnapshots', ids])
      return ids.map((id) => ({
        sessionId: id,
        status: 'fulfilled',
        value: { session: headerOf(id), ...(titles[id] === undefined ? {} : { title: titles[id] }) },
      }))
    },
    async readSurface(id) {
      calls.push(['readSurface', id])
      if (id !== 'session-a') throw new Error(`unknown session ${id}`)
      return {
        session: HEADER_A,
        inheritedEventCount: 0,
        capturedThroughSeq: 4,
        events: [SYSTEM, USER, ASSISTANT, TOOL_RESULT],
      }
    },
    async readSession(id) {
      calls.push(['readSession', id])
      if (id !== 'session-a') throw new Error(`unknown session ${id}`)
      return { session: HEADER_A, inheritedEventCount: 0, events: RAW_EVENTS }
    },
    async readEvent(request) {
      calls.push(['readEvent', request])
      return {
        session: HEADER_A,
        inheritedEventCount: 0,
        target: ASSISTANT,
        events: [USER, ASSISTANT, TOOL_RESULT],
        startSeq: 2,
        endSeq: 4,
      }
    },
    async filterEvents(id, filters) {
      calls.push(['filterEvents', id, filters])
      return [
        { sessionId: id, seq: 2, type: 'user/message', time: 10, surface: 'surface', text: 'hello world' },
        {
          sessionId: id,
          seq: 3,
          type: 'assistant/message',
          time: 11,
          surface: 'surface',
          text: 'hi there [tool-call] bash({"command":"ls"})',
        },
      ]
    },
    ...overrides,
  }
}

const REGISTRY = {
  get: (id) =>
    id === 'ws-1'
      ? { id: 'ws-1', title: 'Experiment', path: '/work/a', sessionIds: ['session-a', 'session-c'] }
      : undefined,
  list: () => [
    { id: 'ws-1', title: 'Experiment', path: '/work/a', sessionIds: ['session-a', 'session-c'] },
    { id: 'ws-2', title: 'Second', path: '/work/b', sessionIds: ['session-b'] },
  ],
  resolveByPath: async (path) =>
    path === '/work/a'
      ? { id: 'ws-1', title: 'Experiment', path: '/work/a', sessionIds: ['session-a', 'session-c'] }
      : undefined,
}

function services(overrides = {}) {
  return { sessionQuery: makeQuery(), workspaceRegistry: REGISTRY, ...overrides }
}

const EXEC = () => ({ signal: new AbortController().signal })

async function withHome(fn) {
  const previous = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-inspect-'))
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

test('session_list lists top-level sessions newest first with titles', async () => {
  const tool = createListToolDefinition(services())
  const result = await tool.execute({}, EXEC())
  assert.equal(result.sessions.length, 2)
  assert.deepEqual(
    result.sessions.map((row) => row.sessionId),
    ['session-b', 'session-a'],
  )
  const a = result.sessions.find((row) => row.sessionId === 'session-a')
  assert.equal(a.title, 'Experiment A')
  assert.equal(a.preset, 'minimal-prompt-lab')
  assert.equal(a.live, true)
  const b = result.sessions.find((row) => row.sessionId === 'session-b')
  assert.equal(b.title, undefined)
  assert.equal(b.live, false)
})

test('session_list filters: subagents, workspace, preset, live', async () => {
  const tool = createListToolDefinition(services())
  const all = await tool.execute({ include_subagents: true }, EXEC())
  assert.equal(all.sessions.length, 3)
  const inWorkspace = await tool.execute({ include_subagents: true, workspace: 'Experiment' }, EXEC())
  assert.deepEqual(
    inWorkspace.sessions.map((row) => row.sessionId).sort(),
    ['session-a', 'session-c'],
  )
  const byPath = await tool.execute({ include_subagents: true, workspace: '/work/a' }, EXEC())
  assert.equal(byPath.sessions.length, 2)
  const onlyPreset = await tool.execute({ preset: 'minimal' }, EXEC())
  assert.deepEqual(
    onlyPreset.sessions.map((row) => row.sessionId),
    ['session-b'],
  )
  const onlyPersisted = await tool.execute({ live: false }, EXEC())
  assert.deepEqual(
    onlyPersisted.sessions.map((row) => row.sessionId),
    ['session-b'],
  )
})

test('session_list rejects an unknown workspace and lists available ones', async () => {
  const tool = createListToolDefinition(services())
  await assert.rejects(tool.execute({ workspace: 'nope' }, EXEC()), /workspace "nope" not found/)
  await assert.rejects(tool.execute({ workspace: 'nope' }, EXEC()), /Experiment \(\/work\/a\)/)
})

test('session_read surface renders the current context and hides reasoning', async () => {
  const tool = createReadToolDefinition(services())
  const result = await tool.execute({ session: 'session-a' }, EXEC())
  const text = result.text
  assert.match(text, /session session-a/)
  assert.match(text, /preset minimal-prompt-lab/)
  assert.match(text, /"Experiment A"/)
  assert.match(text, /model deepseek\/chat/)
  assert.match(text, /tokens in 10 \/ out 5 /)
  assert.match(text, /You are PROMPT-A/)
  assert.match(text, /hello world/)
  assert.match(text, /hi there/)
  assert.match(text, /\[tool-call\] bash\(\{"command":"ls"\}\)/)
  assert.match(text, /file\.txt/)
  assert.doesNotMatch(text, /secret planning/)
})

test('session_read surface can include reasoning', async () => {
  const tool = createReadToolDefinition(services())
  const result = await tool.execute({ session: 'session-a', include_reasoning: true }, EXEC())
  assert.match(result.text, /\[reasoning\] secret planning/)
})

test('session_read surface truncates by max_chars', async () => {
  const long = {
    seq: 1,
    type: 'user/message',
    data: { message: { role: 'user', content: [{ type: 'text', text: 'y'.repeat(4000) }] } },
  }
  const query = makeQuery({
    async readSurface() {
      return { session: HEADER_A, inheritedEventCount: 0, capturedThroughSeq: 1, events: [long] }
    },
  })
  const tool = createReadToolDefinition({ sessionQuery: query, workspaceRegistry: REGISTRY })
  const result = await tool.execute({ session: 'session-a', max_chars: 1000 }, EXEC())
  assert.match(result.text, /truncated at 1000 chars/)
})

test('session_read raw filters by event type', async () => {
  const tool = createReadToolDefinition(services())
  const result = await tool.execute(
    { session: 'session-a', mode: 'raw', types: ['request/header', 'turn/end'] },
    EXEC(),
  )
  assert.match(result.text, /request model=deepseek\/chat tools=2/)
  assert.match(result.text, /turn 1 end \(completed\)/)
  assert.doesNotMatch(result.text, /hello world/)
})

test('session_read event mode forwards before/after and marks the target', async () => {
  const query = makeQuery()
  const tool = createReadToolDefinition({ sessionQuery: query, workspaceRegistry: REGISTRY })
  const result = await tool.execute(
    { session: 'session-a', mode: 'event', seq: 3, before: 1, after: 1 },
    EXEC(),
  )
  const call = query.calls.find((entry) => entry[0] === 'readEvent')
  assert.deepEqual(call[1], { sessionId: 'session-a', seq: 3, before: 1, after: 1 })
  assert.match(result.text, /\[3 target\] assistant\/message/)
})

test('session_read rejects invalid arguments', async () => {
  const tool = createReadToolDefinition(services())
  await assert.rejects(tool.execute({}, EXEC()), /"session" is required/)
  await assert.rejects(tool.execute({ session: 'session-a', mode: 'bogus' }, EXEC()), /"mode" must be one of/)
  await assert.rejects(tool.execute({ session: 'session-a', mode: 'event' }, EXEC()), /requires an integer "seq"/)
})

test('session_find scans the rendered event text and returns snippets', async () => {
  const query = makeQuery()
  const tool = createFindToolDefinition({ sessionQuery: query })
  const result = await tool.execute({ session: 'session-a', query: 'hello' }, EXEC())
  assert.equal(result.total, 1)
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0].seq, 2)
  assert.match(result.matches[0].snippet, /hello world/)
  const system = await tool.execute({ session: 'session-a', query: 'PROMPT-A' }, EXEC())
  assert.equal(system.total, 1)
  assert.equal(system.matches[0].seq, 1)
  await assert.rejects(tool.execute({ session: 'session-a' }, EXEC()), /"query" is required/)
})

test('eventText renders a tool result error compactly', () => {
  const text = eventText({
    type: 'tool/result',
    data: { message: { content: [{ type: 'text', text: 'boom' }] }, error: { name: 'Error', code: 'E_BOOM' } },
  })
  assert.match(text, /boom/)
  assert.match(text, /\[error\] Error \(E_BOOM\)/)
})

test('normalizeConfig clamps defaults', () => {
  const cfg = normalizeConfig({ defaultLimit: 999, defaultMaxChars: 1 })
  assert.equal(cfg.defaultLimit, 100)
  assert.equal(cfg.defaultMaxChars, 1000)
  assert.equal(normalizeConfig({ enabled: false }).enabled, false)
})

test('apply installs the three tools on top-level agents only', async () => {
  await withHome(async (home) => {
    const tools = []
    const subTools = []
    const register = (bucket) => (definition) => {
      bucket.push(definition)
      return () => {}
    }
    const top = {
      id: 'session-a',
      session: { header: HEADER_A },
      ctx: { tools: { register: register(tools) } },
    }
    const sub = {
      id: 'session-c',
      session: { header: HEADER_C },
      ctx: { tools: { register: register(subTools) } },
    }
    const handlers = new Map()
    const effects = []
    const ctx = {
      get: (key) =>
        ({
          agents: { list: () => [top, sub] },
          sessionQuery: makeQuery(),
          workspaceRegistry: REGISTRY,
        })[key],
      on: (event, handler) => {
        handlers.set(event, handler)
        return () => {}
      },
      effect: (fn) => {
        effects.push(fn)
        return () => {}
      },
      logger: { warn: () => {} },
    }
    apply(ctx, {})
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [LIST_TOOL_NAME, READ_TOOL_NAME, FIND_TOOL_NAME],
    )
    assert.equal(subTools.length, 0)
    assert.equal(handlers.has('agent/created'), true)
    assert.equal(handlers.has('agent/disposed'), true)
    assert.equal(effects.length, 1)
    const status = JSON.parse(await readFile(join(home, 'session-inspect-status.json'), 'utf8'))
    assert.deepEqual(status.tools, [LIST_TOOL_NAME, READ_TOOL_NAME, FIND_TOOL_NAME])
    assert.deepEqual(status.installed, ['session-a'])
  })
})

test('apply disabled writes a diagnostic and installs nothing', async () => {
  await withHome(async (home) => {
    const ctx = {
      get: () => undefined,
      on: () => () => {},
      effect: () => () => {},
      logger: { warn: () => {} },
    }
    apply(ctx, { enabled: false })
    const status = JSON.parse(await readFile(join(home, 'session-inspect-status.json'), 'utf8'))
    assert.equal(status.reason, 'disabled')
    assert.deepEqual(status.installed, [])
  })
})
