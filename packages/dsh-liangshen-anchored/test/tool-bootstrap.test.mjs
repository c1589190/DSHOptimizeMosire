import test from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyBootstrap } from '../presets/liangshen/tool-bootstrap.mjs'

/**
 * Minimal Cordis context plus one fake Agent-scoped tools registry. The plugin
 * only needs `ctx.on` / `ctx.get('agents')` and `agent.ctx.tools.restrict`.
 */
function mount() {
  const listeners = new Map()
  const events = []
  const restrictCalls = []
  let releases = 0
  const agent = {
    session: { id: 's-late-join', header: { delegationDepth: 0 }, snapshotEvents: () => events },
    ctx: {
      tools: {
        restrict(options) {
          restrictCalls.push(options)
          return () => {
            releases += 1
          }
        },
      },
    },
  }
  const agents = { get: (id) => (id === agent.session.id ? agent : undefined) }
  const ctx = {
    logger: { warn() {} },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    get(name) {
      return name === 'agents' ? agents : undefined
    },
  }
  applyBootstrap(ctx, {
    bootstrapTools: ['bash', 'str_replace_editor'],
    promoteOn: 'either',
    includeSubagents: true,
  })
  return { listeners, events, agent, restrictCalls, released: () => releases }
}

test('a preset selected after agent creation still restricts the first request', () => {
  const { listeners, events, agent, restrictCalls } = mount()
  const selected = { type: 'agent-preset/selected', seq: 1, data: { agentPreset: 'liangshen' } }
  events.push(selected)
  listeners.get('session/event')[0](agent.session, selected)
  assert.deepEqual(restrictCalls, [{ allow: ['bash', 'str_replace_editor'] }])
})

test('the late-joined restriction is released on the first promotion signal', () => {
  const { listeners, events, agent, released } = mount()
  const selected = { type: 'agent-preset/selected', seq: 1, data: { agentPreset: 'liangshen' } }
  events.push(selected)
  listeners.get('session/event')[0](agent.session, selected)
  const toolCall = { type: 'tool/call', seq: 2 }
  events.push(toolCall)
  listeners.get('session/event')[0](agent.session, toolCall)
  assert.equal(released(), 1, 'promotion must release the anchored restriction')
})
