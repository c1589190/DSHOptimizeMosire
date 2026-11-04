#!/usr/bin/env node
/**
 * Verify a `minimal-prompt-lab` session against the prompt-lab protocol.
 *
 * This is a sibling of `verify-session.mjs`: that tool checks the anchored
 * LiangShen protocol (Minimal tool pair then promotion), which does not apply
 * here. The prompt-lab invariant is different and stricter about the system
 * prompt:
 *
 *   - the preset is `minimal-prompt-lab`;
 *   - the tool surface stays `bash` + `read_image` (official Minimal);
 *   - the effective system prompt is the selected file/text exactly;
 *   - there is exactly ONE non-empty system node: after a mid-session `/sp`
 *     switch the head is replaced and the old prompt is tombstoned. A second
 *     non-empty node means the native in-history append happened (mode A),
 *     which this preset must avoid.
 *
 * Usage:
 *   node tools/verify-prompt-lab.mjs <session.v4.jsonl.zstd>
 *     [--system-file <path>] [--system-sha256 <hex>] [--initial-file <path>]
 *
 * `--system-file` compares the effective (head) system prompt with the file
 * after the same BOM-stripping the preset uses. `--initial-file` additionally
 * checks the first `system/message` in the log (the prompt the session started
 * with, before any switch).
 */
import { createHash } from 'node:crypto'
import { decodeSessionFile, effectivePreset, firstRequestHeader } from './verify-session.mjs'
import { readPromptFile } from '../packages/dsh-liangshen-anchored/lib/prompt-lab-state.js'

export const PRESET = 'minimal-prompt-lab'
export const MINIMAL_TOOLS = ['bash', 'read_image']
export const FORBIDDEN_TOOLS = ['read', 'write', 'edit', 'str_replace_editor']
export const PERSONA_LINE = 'You are a helpful software engineer assistant.'
export const HARNESS_IDENTITY_MARKERS = ['You are an AI agent powered by DeepSeek Harness']
export const FIRST_STEP_ALLOWED_SOURCES = new Set(['user', 'user-approval', 'runtime-context'])

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
}

const messageOf = (event) => event.data?.message ?? event.data ?? {}
const systemTextOf = (event) => textOf(messageOf(event).content)

/**
 * Fold the `system/message` surface ops into the current node list.
 *
 * A `replace` op removes the nodes whose seqs fall in `[startSeq, endSeq]` and
 * puts the replacing event at that position; `append` (the default) adds at the
 * end. Tombstoned nodes carry empty text.
 * @returns {{seq: number, text: string}[]}
 */
export function effectiveSystemNodes(events) {
  const nodes = []
  for (const event of events) {
    if (event.type !== 'system/message') continue
    const text = systemTextOf(event)
    const op = event.surfaceOp
    if (op === undefined || op === 'append') {
      nodes.push({ seq: event.seq, text })
      continue
    }
    if (op?.op === 'replace') {
      const start = op.startSeq
      const end = op.endSeq
      const kept = nodes.filter((node) => node.seq < start || node.seq > end)
      kept.push({ seq: event.seq, text })
      nodes.length = 0
      nodes.push(...kept)
    }
  }
  return nodes
}

/**
 * Analyze decoded session rows.
 * @param {object[]} events parsed session rows
 * @param {{systemFile?: string, systemSha256?: string, initialFile?: string}} [options]
 * @returns {{sessionId?: string, preset?: string, headSha256?: string, headPreview?: string,
 *   nonEmptySystemNodes: number, checks: {name: string, ok: boolean, detail: string}[],
 *   failures: string[]}}
 */
export function analyzePromptLabSession(events, options = {}) {
  const header = events.find((event) => event.type === 'session')
  const preset = effectivePreset(events)
  const checks = []
  const record = (name, ok, detail) => checks.push({ name, ok, detail })

  record('session header present', header !== undefined, header ? `created as preset=${header.agentPreset}, effective=${preset}` : 'no session header')
  record('agent preset', preset === PRESET, `expected ${PRESET}, got ${preset}`)

  const firstHeader = firstRequestHeader(events)
  if (firstHeader === undefined) {
    record('first request header present', false, 'session never produced a model request')
  } else {
    const tools = (firstHeader.data?.header?.tools ?? []).map((tool) => tool.name)
    const missing = MINIMAL_TOOLS.filter((name) => !tools.includes(name))
    const forbidden = tools.filter((name) => FORBIDDEN_TOOLS.includes(name))
    record(
      'the preset keeps the official Minimal tool surface',
      missing.length === 0 && forbidden.length === 0,
      `missing ${JSON.stringify(missing)}, forbidden ${JSON.stringify(forbidden)}; catalog ${tools.length} tools (host plugins add profile-level tools to every preset)`,
    )
    const injected = events
      .filter((event) => event.type === 'user/message' && event.seq < firstHeader.seq)
      .map((event) => event.data?.source?.kind ?? messageOf(event).source?.kind)
      .filter((kind) => !FIRST_STEP_ALLOWED_SOURCES.has(kind))
    record(
      'first step carries no preset-injected context',
      injected.length === 0,
      `injected sources outside the profile baseline: ${JSON.stringify(injected)}`,
    )
  }

  const nodes = effectiveSystemNodes(events)
  const headText = nodes[0]?.text ?? ''
  const nonEmpty = nodes.filter((node) => node.text !== '')
  record(
    'exactly one non-empty system node (switch replaces the head)',
    nonEmpty.length === 1,
    `non-empty system nodes: ${nonEmpty.length} (native append would leave 2)`,
  )
  record(
    'harness identity is absent from the system prompt',
    !HARNESS_IDENTITY_MARKERS.some((marker) => headText.includes(marker)),
    'harness identity marker found in the system prompt',
  )

  if (options.systemFile !== undefined) {
    const file = readPromptFile(options.systemFile)
    record(
      `effective system prompt equals ${options.systemFile}`,
      file.ok && headText === file.text,
      file.ok
        ? `head sha256 ${sha256(headText)} vs file ${file.sha256}`
        : `cannot read system file: ${file.error}`,
    )
  }
  if (options.systemSha256 !== undefined) {
    record(
      'effective system prompt sha256 matches',
      sha256(headText) === options.systemSha256,
      `got ${sha256(headText)}, expected ${options.systemSha256}`,
    )
  }
  if (options.initialFile !== undefined) {
    const first = events.find((event) => event.type === 'system/message')
    const firstText = first === undefined ? '' : systemTextOf(first)
    const file = readPromptFile(options.initialFile)
    record(
      `first system prompt equals ${options.initialFile}`,
      file.ok && firstText === file.text,
      file.ok ? `first sha256 ${sha256(firstText)} vs file ${file.sha256}` : `cannot read initial file: ${file.error}`,
    )
  }
  if (options.systemFile === undefined && options.systemSha256 === undefined) {
    record('default system prompt is the official Minimal persona line', headText === PERSONA_LINE, `head starts: ${JSON.stringify(headText.slice(0, 120))}`)
  }

  return {
    sessionId: header?.id,
    preset,
    headSha256: sha256(headText),
    headPreview: headText.slice(0, 160),
    nonEmptySystemNodes: nonEmpty.length,
    checks,
    failures: checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`),
  }
}

const USAGE =
  'usage: node tools/verify-prompt-lab.mjs <session.v4.jsonl.zstd> [--system-file <path>] [--system-sha256 <hex>] [--initial-file <path>]'

function parseArgv(argv) {
  const args = argv.slice(2)
  const parsed = { file: undefined, systemFile: undefined, systemSha256: undefined, initialFile: undefined }
  const keys = { '--system-file': 'systemFile', '--system-sha256': 'systemSha256', '--initial-file': 'initialFile' }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (keys[arg] !== undefined) {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) return { error: `missing value for ${arg}` }
      parsed[keys[arg]] = value
      i += 1
    } else if (arg.startsWith('--')) {
      return { error: `unknown option ${arg}` }
    } else if (parsed.file === undefined) {
      parsed.file = arg
    } else {
      return { error: `unexpected argument ${arg}` }
    }
  }
  if (parsed.file === undefined) return { error: 'missing session file' }
  return parsed
}

function main(argv) {
  const parsed = parseArgv(argv)
  if (parsed.error !== undefined) {
    console.error(`verify-prompt-lab: ${parsed.error}`)
    console.error(USAGE)
    process.exit(2)
  }
  const report = analyzePromptLabSession(decodeSessionFile(parsed.file), {
    systemFile: parsed.systemFile,
    systemSha256: parsed.systemSha256,
    initialFile: parsed.initialFile,
  })
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.failures.length === 0 ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv)
