#!/usr/bin/env node
/**
 * verify-session — protocol-level acceptance checker for the anchored LiangShen
 * preset, reading a DSH session log directly from disk.
 *
 * Session logs are a CONCATENATION of independent Zstandard frames (one header
 * frame, then one frame per durable append batch), so Node's single-frame
 * `zstdDecompressSync` is not enough: this tool walks the Zstandard frame
 * format to split frames, then decodes each frame on its own.
 *
 * Usage:
 *   node tools/verify-session.mjs <session.v4.jsonl.zstd> [--preset liangshen]
 *
 * Exit code 0 = all checks passed; 1 = at least one failure (`failures` in the
 * JSON report). Checks with no applicable evidence (e.g. no compaction in the
 * session) are reported as skipped, never as passed.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const BOOTSTRAP_TOOLS = ['bash', 'str_replace_editor']
const PERSONA_LINE = 'You are a helpful software engineer assistant.'
const HARNESS_IDENTITY_MARKERS = ['You are an AI agent powered by DeepSeek Harness']
const FIRST_STEP_ALLOWED_SOURCES = new Set(['user', 'user-approval'])

/** Split a concatenated-Zstandard buffer into independent frame slices. */
export function splitZstdFrames(buf) {
  const frames = []
  let off = 0
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error(`bad zstd magic at byte ${off}`)
    const start = off
    off += 4
    const descriptor = buf[off++]
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictFlag = descriptor & 3
    if (!singleSegment) off += 1
    off += [0, 1, 2, 4][dictFlag]
    off += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
    for (;;) {
      const blockHeader = buf.readUIntLE(off, 3)
      off += 3
      const last = blockHeader & 1
      const type = (blockHeader >> 1) & 3
      const size = blockHeader >> 3
      if (type === 3) throw new Error('reserved zstd block type')
      off += type === 1 ? 1 : size
      if (last) break
    }
    if (checksum) off += 4
    if (off > buf.length) throw new Error('truncated zstd frame')
    frames.push(buf.subarray(start, off))
  }
  return frames
}

/** Decode a concatenated-Zstandard session log buffer into parsed JSONL rows. */
export function decodeSessionBuffer(buf) {
  const rows = []
  for (const frame of splitZstdFrames(buf)) {
    const text = zstdDecompressSync(frame).toString('utf8')
    for (const line of text.split('\n')) {
      if (line.trim().length > 0) rows.push(JSON.parse(line))
    }
  }
  return rows
}

/** Decode one session log file into parsed JSONL rows. */
export function decodeSessionFile(path) {
  return decodeSessionBuffer(readFileSync(path))
}

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
}

const messageOf = (event) => event.data?.message ?? event.data ?? {}

/** Effective preset: the creation-time header default, overridden by any selection event. */
export function effectivePreset(events) {
  const header = events.find((event) => event.type === 'session')
  let preset = header?.agentPreset
  for (const event of events) {
    if (event.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
      preset = event.data.agentPreset
    }
  }
  return preset
}
const sourceKindOf = (event) => messageOf(event).source?.kind ?? event.data?.source?.kind
const toolsOf = (header) => (header.data?.header?.tools ?? []).map((tool) => tool.name)

/** The first request header, or undefined when the session never requested. */
export function firstRequestHeader(events) {
  return events.find((event) => event.type === 'request/header')
}

/** First message-bearing system event. */
export function firstSystemMessage(events) {
  return events.find((event) => event.type === 'system/message')
}

/**
 * Analyze decoded session rows against the anchored-preset protocol.
 * @returns {{ sessionId, preset, delegationDepth, events, checks, failures, warnings }}
 */
export function analyzeSession(events, options = {}) {
  const expectedPreset = options.preset ?? 'liangshen'
  const bootstrap = [...(options.bootstrapTools ?? BOOTSTRAP_TOOLS)].sort()
  const header = events.find((event) => event.type === 'session')
  const firstHeader = firstRequestHeader(events)
  const checks = []
  const warnings = []
  const record = (name, ok, detail) => checks.push({ name, ok, detail })

  const preset = effectivePreset(events)
  record('session header present', header !== undefined, header ? `created as preset=${header.agentPreset}, effective=${preset}` : 'no session header')

  if (header !== undefined) {
    record('agent preset', preset === expectedPreset, `expected ${expectedPreset}, got ${preset}`)
  }

  if (firstHeader === undefined) {
    record('first request header present', false, 'session never produced a model request')
    const failed = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)
    return {
      sessionId: header?.id,
      preset,
      delegationDepth: header?.delegationDepth ?? 0,
      events: events.length,
      checks,
      failures: failed,
      warnings,
    }
  }

  const firstTools = toolsOf(firstHeader).sort()
  record(
    'first request is the Minimal tool pair',
    firstTools.length === bootstrap.length && firstTools.every((name, i) => name === bootstrap[i]),
    `expected ${JSON.stringify(bootstrap)}, got ${JSON.stringify(firstTools)}`,
  )

  const firstStepSources = events
    .filter((event) => event.type === 'user/message' && event.seq < firstHeader.seq)
    .map((event) => sourceKindOf(event))
  const injectedFirstStep = firstStepSources.filter((kind) => !FIRST_STEP_ALLOWED_SOURCES.has(kind))
  record(
    'first step carries no auto-injected context',
    injectedFirstStep.length === 0,
    `injected sources: ${JSON.stringify(injectedFirstStep)}`,
  )

  const system = firstSystemMessage(events)
  const systemText = textOf(messageOf(system).content)
  record('minimal persona is the first system prompt', systemText.includes(PERSONA_LINE), `system text starts: ${JSON.stringify(systemText.slice(0, 120))}`)
  record(
    'harness identity is absent from the first system prompt',
    !HARNESS_IDENTITY_MARKERS.some((marker) => systemText.includes(marker)),
    'harness identity marker found in the system prompt',
  )

  // Promotion: the request after the first durable signal must widen.
  const firstSignal = events.find(
    (event) => event.seq > firstHeader.seq && (event.type === 'tool/call' || event.type === 'assistant/message'),
  )
  if (firstSignal === undefined) {
    checks.push({ name: 'promotion observed', ok: true, detail: 'skipped: no durable signal yet', skipped: true })
    warnings.push('no promotion signal in this session (first turn may have been aborted)')
  } else {
    const nextHeader = events.find((event) => event.type === 'request/header' && event.seq > firstSignal.seq)
    const promotedTools = nextHeader === undefined ? [] : toolsOf(nextHeader)
    record(
      'promotion widens to the full assembled catalog',
      nextHeader !== undefined && promotedTools.length > bootstrap.length,
      nextHeader === undefined
        ? `no request after signal ${firstSignal.type}@${firstSignal.seq}`
        : `signal ${firstSignal.type}@${firstSignal.seq}, next header tools=${promotedTools.length} ${JSON.stringify(promotedTools.slice(0, 8))}`,
    )
  }

  // Re-anchoring: every compaction/end must be followed by a request that is the
  // bootstrap pair again (the session may end before such a request exists).
  const boundaries = events.filter((event) => event.type === 'compaction/end')
  if (boundaries.length === 0) {
    checks.push({ name: 'compaction re-anchor', ok: true, detail: 'skipped: no compaction in this session', skipped: true })
    warnings.push('no compaction/end in this session; run /compact before trusting re-anchor evidence')
  }
  for (const boundary of boundaries) {
    const nextHeader = events.find((event) => event.type === 'request/header' && event.seq > boundary.seq)
    if (nextHeader === undefined) {
      checks.push({ name: 'compaction re-anchor', ok: true, detail: `skipped: no request after compaction@${boundary.seq}`, skipped: true })
      warnings.push(`compaction@${boundary.seq} has no following request in the log`)
      continue
    }
    const tools = toolsOf(nextHeader).sort()
    record(
      'compaction re-anchor',
      tools.length === bootstrap.length && tools.every((name, i) => name === bootstrap[i]),
      `compaction@${boundary.seq} → header@${nextHeader.seq} tools=${JSON.stringify(tools)}`,
    )
  }

  // Subagents must follow the same anchor when includeSubagents is enabled.
  if ((header?.delegationDepth ?? 0) > 0) {
    record(
      'subagent first request is the Minimal tool pair',
      firstTools.length === bootstrap.length,
      `subagent depth=${header.delegationDepth} first tools=${JSON.stringify(firstTools)}`,
    )
  }

  const failures = checks.filter((check) => check.ok === false).map((check) => `${check.name}: ${check.detail}`)
  return {
    sessionId: header?.id,
    preset,
    delegationDepth: header?.delegationDepth ?? 0,
    events: events.length,
    checks,
    failures,
    warnings,
  }
}

/** Find the newest session log under a sessions root (optionally filtered). */
export function newestSessionLog(root, filter = () => true) {
  let newest
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('session.v4.jsonl.zstd') && filter(path)) {
        if (newest === undefined) newest = path
      }
    }
  }
  walk(root)
  return newest
}

function main(argv) {
  const args = argv.slice(2)
  const file = args.find((arg) => !arg.startsWith('--'))
  if (file === undefined) {
    console.error('usage: node tools/verify-session.mjs <session.v4.jsonl.zstd> [--preset liangshen]')
    process.exit(2)
  }
  const presetIndex = args.indexOf('--preset')
  const preset = presetIndex >= 0 ? args[presetIndex + 1] : 'liangshen'
  const report = analyzeSession(decodeSessionFile(file), { preset })
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.failures.length === 0 ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv)
