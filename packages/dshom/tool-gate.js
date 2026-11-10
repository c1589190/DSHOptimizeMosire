/**
 * Tool-group gate for the anchored presets.
 *
 * Host features install their tools into the Agent's own scope. On DSH 0.2.2
 * `tools.restrict()` deliberately exempts the viewing scope's own
 * registrations, so a preset restriction cannot hide them, and the step-time
 * `when` option is not reliable across hosts. Instead this gate defers mounting
 * a feature's tool group until the session is promoted, and releases it again
 * when a compaction starts a new anchoring epoch.
 *
 * Non-anchored sessions and subagents mount immediately. Sessions that already
 * carry a durable promotion signal (resume) mount immediately as well, so the
 * gate never weakens a session that was already past its first request.
 */

const ANCHORED_PRESETS = new Set(['liangshen', 'liangshen-empty-system'])
const PROMOTE_EVENTS = new Set(['tool/call', 'assistant/message'])

/**
 * Build one gate shared by every dshom feature.
 *
 * @param ctx - the Host context (listens on `session/event`).
 * @param options.presets - preset ids that anchor their first request.
 * @returns `{ mount(agent, mount) }`; `mount` returns the group's disposer and
 *   the returned function releases the group (idempotent).
 */
export function createToolGate(ctx, options = {}) {
  const presets = options.presets ?? ANCHORED_PRESETS
  /** session id -> { boundary, promoted, slots } */
  const sessions = new Map()

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`dshom: ${message}`)
    } catch {
      // Logging is best effort.
    }
  }

  const eventsOf = (session) => {
    try {
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
      return Array.isArray(events) ? events : []
    } catch {
      return []
    }
  }

  const stateFor = (session) => {
    const cached = sessions.get(session.id)
    if (cached !== undefined) return cached
    let boundary = -1
    let promoted = false
    for (const event of eventsOf(session)) {
      const seq = event.seq ?? 0
      if (event.type === 'compaction/end') {
        boundary = seq
        promoted = false
        continue
      }
      if (PROMOTE_EVENTS.has(event.type) && seq > boundary) promoted = true
    }
    const entry = { boundary, promoted, slots: new Set() }
    sessions.set(session.id, entry)
    return entry
  }

  const disposeSlot = (slot) => {
    const dispose = slot.dispose
    slot.dispose = undefined
    if (dispose === undefined) return
    try {
      dispose()
    } catch (error) {
      warn(`tool group release failed: ${String((error && error.message) || error)}`)
    }
  }

  const mountSlot = (slot) => {
    if (slot.released || slot.dispose !== undefined) return
    try {
      const dispose = slot.mount()
      slot.dispose = typeof dispose === 'function' ? dispose : () => {}
    } catch (error) {
      warn(`tool group mount failed: ${String((error && error.message) || error)}`)
    }
  }

  const gate = {
    /**
     * Register one tool group for an Agent. Mount is called now when the
     * session is past its anchor, otherwise on the promotion event.
     */
    mount(agent, mount) {
      const session = agent?.session
      if (session === undefined || session.id === undefined) {
        const dispose = mount()
        return typeof dispose === 'function' ? dispose : () => {}
      }
      const entry = stateFor(session)
      const deferrable = presets.has(session.header?.agentPreset) && (session.header?.delegationDepth ?? 0) === 0
      const slot = { mount, dispose: undefined, released: false, deferrable }
      if (!deferrable || entry.promoted) {
        // Immediate mount errors propagate to the caller's own try/catch.
        const dispose = mount()
        slot.dispose = typeof dispose === 'function' ? dispose : () => {}
      }
      entry.slots.add(slot)
      return () => {
        slot.released = true
        entry.slots.delete(slot)
        disposeSlot(slot)
      }
    },
  }

  const off = ctx.on?.('session/event', (session, event) => {
    if (session === undefined || event === undefined) return
    const entry = sessions.get(session.id)
    if (entry === undefined) return
    const seq = event.seq ?? 0
    if (event.type === 'compaction/end') {
      entry.boundary = seq
      entry.promoted = false
      for (const slot of entry.slots) {
        if (slot.deferrable) disposeSlot(slot)
      }
      return
    }
    if (!entry.promoted && PROMOTE_EVENTS.has(event.type) && seq > entry.boundary) {
      entry.promoted = true
      for (const slot of entry.slots) {
        if (slot.deferrable) mountSlot(slot)
      }
    }
  })

  ctx.effect?.(
    () => () => {
      off?.()
      for (const entry of sessions.values()) {
        for (const slot of entry.slots) disposeSlot(slot)
      }
      sessions.clear()
    },
    'dshom.toolGate()',
  )

  return gate
}
