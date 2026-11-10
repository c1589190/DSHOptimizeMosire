import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_PRESET,
  TOOL_NAME,
  WORKSPACES_TOOL_NAME,
  apply,
  createToolDefinitions,
  lastAssistantText,
  normalizeConfig,
  preparePrompt,
} from '../lib/index.js'

const CATALOG = {
  default: { provider: 'deepseek', model: 'chat' },
  routableProviders: ['deepseek'],
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'chat', name: 'Chat', reasoning: { efforts: ['low', 'high'] } },
        { id: 'reasoner', name: 'Reasoner' },
      ],
    },
  ],
  failures: [],
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dshom-prompt-lab-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return (async () => {
    try {
      return await fn(home)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })()
}

function makeWorkspace(path, title = 'Experiment', id = 'ws-1') {
  return {
    id,
    path,
    title,
    record: { path, title, sessionIds: ['session-existing'] },
    sessionIds: ['session-existing'],
  }
}

function makeCaller(root, { parentSession, origin } = {}) {
  const tools = new Map()
  const agent = {
    id: 'session-caller',
    session: {
      header: {
        cwd: root,
        ...(parentSession === undefined ? {} : { parentSession }),
        ...(origin === undefined ? {} : { origin }),
      },
    },
  }
  agent.ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  return { caller: agent, tools }
}

function makeHarness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dshom-prompt-lab-'))
  const workspacePath = options.workspacePath ?? root
  const entities = options.workspaces ?? [makeWorkspace(workspacePath)]
  const created = []
  const prompts = []
  const executed = []
  const selections = []
  const registry = {
    get: (id) => entities.find((entity) => entity.id === id),
    list: () => entities,
    resolveByPath: async (path) => entities.find((entity) => entity.path === path),
  }
  const { caller, tools } = makeCaller(root, options.caller ?? {})
  const snapshots = options.events ?? []
  const createdAgent = {
    id: 'session-new',
    session: {
      header: { cwd: workspacePath },
      append(type, data) {
        selections.push({ type, data })
      },
      snapshotEvents: () => snapshots,
    },
    whenIdle: async () => {},
  }
  const services = {
    agents: {
      get: (id) => (id === 'session-new' ? createdAgent : undefined),
      list: () => [caller],
    },
    sessionController: {
      async create(request) {
        created.push(request)
        return options.createResult ?? { sessionId: 'session-new', agentPreset: DEFAULT_PRESET }
      },
      async prompt(request) {
        prompts.push(request)
      },
      async modelCatalog() {
        return options.catalog ?? CATALOG
      },
    },
    commands: {
      async execute(agent, line) {
        executed.push({ agent, line })
        return { commandId: 'cmd-1', result: { kind: 'success', text: 'ok' } }
      },
    },
    workspaces: options.registry ?? registry,
    workspaceRegistry: options.registry ?? registry,
  }
  const ctx = {
    get: (key) => services[key],
    on: () => () => {},
    effect: () => {},
    logger: { warn() {} },
  }
  apply(ctx, options.config ?? {})
  return {
    root,
    workspacePath,
    entities,
    created,
    prompts,
    executed,
    selections,
    tools,
    createdAgent,
    caller,
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('prompt_lab_workspaces lists configured workspaces', async () => {
  await withHome(async () => {
    const harness = makeHarness()
    try {
      const tool = harness.tools.get(WORKSPACES_TOOL_NAME)
      assert.ok(tool, 'workspaces tool installed')
      const output = await tool.execute({}, {})
      assert.deepEqual(output.workspaces, [
        {
          workspaceId: 'ws-1',
          title: 'Experiment',
          path: harness.workspacePath,
          sessionCount: 1,
        },
      ])
    } finally {
      harness.cleanup()
    }
  })
})

test('a workspace id creates an attached sibling session and applies /sp file', async () => {
  await withHome(async () => {
    const harness = makeHarness()
    try {
      const file = join(harness.workspacePath, 'prompt.md')
      writeFileSync(file, 'You are PROMPT-A.\n')
      const tool = harness.tools.get(TOOL_NAME)
      const output = await tool.execute(
        { workspace: 'ws-1', prompt: { kind: 'file', path: 'prompt.md' } },
        { agent: harness.caller },
      )
      assert.deepEqual(harness.created, [{ workspaceId: 'ws-1', agentPreset: DEFAULT_PRESET }])
      assert.equal(harness.executed[0].line, `/sp file ${file}`)
      assert.equal(output.workspaceId, 'ws-1')
      assert.equal(output.workspaceTitle, 'Experiment')
      assert.equal(output.workspacePath, harness.workspacePath)
      assert.equal(output.prompt.kind, 'file')
      assert.equal(output.prompt.path, file)
      assert.equal(output.prompt.bytes, Buffer.byteLength('You are PROMPT-A.\n', 'utf8'))
      assert.match(output.prompt.sha256, /^[0-9a-f]{64}$/u)
      assert.equal(output.status, 'created')
      assert.equal(output.taskSent, false)
    } finally {
      harness.cleanup()
    }
  })
})

test('workspace title and path resolve to the same workspace', async () => {
  await withHome(async () => {
    const harness = makeHarness()
    try {
      const tool = harness.tools.get(TOOL_NAME)
      await tool.execute({ workspace: 'Experiment', prompt: { kind: 'blank' } }, { agent: harness.caller })
      await tool.execute({ workspace: harness.workspacePath, prompt: { kind: 'default' } }, { agent: harness.caller })
      assert.deepEqual(
        harness.created.map((request) => request.workspaceId),
        ['ws-1', 'ws-1'],
      )
      assert.deepEqual(
        harness.executed.map((call) => call.line),
        ['/sp blank', '/sp clear'],
      )
    } finally {
      harness.cleanup()
    }
  })
})

test('cwd and preset are rejected before creation', async () => {
  await withHome(async () => {
    const harness = makeHarness()
    try {
      const tool = harness.tools.get(TOOL_NAME)
      await assert.rejects(tool.execute({ cwd: harness.workspacePath }, { agent: harness.caller }), /no longer supported/u)
      await assert.rejects(
        tool.execute({ workspace: 'ws-1', preset: 'minimal' }, { agent: harness.caller }),
        /fixed to "minimal-prompt-lab"/u,
      )
      assert.equal(harness.created.length, 0)
    } finally {
      harness.cleanup()
    }
  })
})

test('model is validated against the catalog and recorded as model/selection', async () => {
  await withHome(async () => {
    const harness = makeHarness()
    try {
      const tool = harness.tools.get(TOOL_NAME)
      const output = await tool.execute(
        {
          workspace: 'ws-1',
          model: { provider: 'deepseek', model: 'chat', reasoning_effort: 'high' },
        },
        { agent: harness.caller },
      )
      assert.deepEqual(harness.selections, [
        { type: 'model/selection', data: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' } },
      ])
      assert.deepEqual(output.model, { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' })
      await assert.rejects(
        tool.execute({ workspace: 'ws-1', model: { provider: 'deepseek', model: 'nope' } }, { agent: harness.caller }),
        /not available/u,
      )
      await assert.rejects(
        tool.execute(
          { workspace: 'ws-1', model: { provider: 'deepseek', model: 'chat', reasoning_effort: 'ultra' } },
          { agent: harness.caller },
        ),
        /not advertised/u,
      )
      assert.equal(harness.created.length, 1)
    } finally {
      harness.cleanup()
    }
  })
})

test('a task is dispatched after the prompt and the final assistant text returned', async () => {
  await withHome(async () => {
    const events = [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ANSWER' }] } } },
    ]
    const harness = makeHarness({ events })
    try {
      const tool = harness.tools.get(TOOL_NAME)
      const output = await tool.execute(
        { workspace: 'ws-1', prompt: { kind: 'blank' }, task: 'Do the thing' },
        { agent: harness.caller },
      )
      assert.equal(harness.executed.length, 1)
      assert.equal(harness.prompts.length, 1)
      assert.deepEqual(harness.prompts[0].content, [{ type: 'text', text: 'Do the thing' }])
      assert.equal(output.taskSent, true)
      assert.equal(output.status, 'idle')
      assert.equal(output.answer, 'ANSWER')
    } finally {
      harness.cleanup()
    }
  })
})

test('invalid prompts and unknown workspaces fail before creation', async () => {
  await withHome(async () => {
    const harness = makeHarness()
    try {
      const tool = harness.tools.get(TOOL_NAME)
      await assert.rejects(
        tool.execute({ workspace: 'ws-1', prompt: { kind: 'file', path: 'missing.md' } }, { agent: harness.caller }),
        /prompt file rejected/u,
      )
      await assert.rejects(
        tool.execute({ workspace: 'ws-1', prompt: { kind: 'text', text: 'two\nlines' } }, { agent: harness.caller }),
        /single line/u,
      )
      await assert.rejects(tool.execute({ workspace: 'nope' }, { agent: harness.caller }), /not configured/u)
      assert.equal(harness.created.length, 0)
    } finally {
      harness.cleanup()
    }
  })
})

test('subagent scopes receive neither tool', async () => {
  await withHome(async () => {
    const harness = makeHarness({ caller: { parentSession: 'session-parent' } })
    try {
      assert.equal(harness.tools.size, 0)
    } finally {
      harness.cleanup()
    }
  })
})

test('disabled config installs nothing', async () => {
  await withHome(async () => {
    const harness = makeHarness({ config: { enabled: false } })
    try {
      assert.equal(harness.tools.size, 0)
    } finally {
      harness.cleanup()
    }
  })
})

test('preparePrompt validates kinds and normalizeConfig rejects bad timeouts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshom-prompt-lab-prep-'))
  try {
    assert.deepEqual(preparePrompt({ kind: 'blank' }, dir).info, { kind: 'blank' })
    assert.deepEqual(preparePrompt({ kind: 'default' }, dir).info, { kind: 'default' })
    assert.equal(preparePrompt({ kind: 'text', text: 'hello' }, dir).line, '/sp text hello')
    assert.throws(() => preparePrompt({ kind: 'nope' }, dir), /prompt.kind/u)
    assert.throws(() => preparePrompt(null, dir), /must be an object/u)
    assert.throws(() => normalizeConfig({ defaultTimeoutSeconds: 0 }), /between 1 and 86400/u)
    assert.throws(() => normalizeConfig({ defaultTimeoutSeconds: 10, maxTimeoutSeconds: 5 }), /must not exceed/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lastAssistantText prefers the newest non-empty assistant message', () => {
  const events = [
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'old' }] } } },
    { type: 'assistant/message', data: { message: { content: [] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'new' }] } } },
  ]
  assert.equal(lastAssistantText(events), 'new')
  assert.equal(lastAssistantText([]), '')
})

test('both definitions expose standard schemas', () => {
  const definitions = createToolDefinitions({}, normalizeConfig({}))
  const session = definitions.find((definition) => definition.name === TOOL_NAME)
  assert.ok(session, 'session tool defined')
  assert.deepEqual(session.parameters.required, ['workspace'])
  assert.equal(session.parameters.properties.cwd, undefined)
  assert.equal(session.parameters.properties.preset, undefined)
  assert.deepEqual(session.parameters.properties.prompt.properties.kind.enum, [
    'file',
    'text',
    'blank',
    'default',
  ])
  assert.equal(session.output.schema.type, 'object')
  const workspaces = definitions.find((definition) => definition.name === WORKSPACES_TOOL_NAME)
  assert.ok(workspaces, 'workspaces tool defined')
  assert.deepEqual(workspaces.output.render({}, { workspaces: [] }), [
    { type: 'text', text: '{"workspaces":[]}' },
  ])
})
