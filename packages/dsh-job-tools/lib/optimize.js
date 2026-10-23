/**
 * Character-level output optimization for background jobs.
 *
 * The job ring already bounds retention, but a build log still spends context
 * on ANSI color codes, carriage-return progress bars, repeated lines, and
 * thousands of lines the model does not need. Every transform here is
 * deterministic and inspectable: no LLM summary, no rewritten error text, and
 * the omitted ranges always leave a marker (the full stream stays in the
 * job's spill file when one exists).
 *
 * Modes:
 *   raw      — return the ring text unchanged (no normalization, no cap)
 *   full     — normalize terminal noise, keep every line, cap bytes only
 *   head     — first `lines` lines
 *   tail     — last `lines` lines
 *   errors   — error-like lines plus one line of context
 *   summary  — head + error lines + tail, with omitted-range markers
 *   auto     — full when it fits the line/byte budget, otherwise summary
 */

/** Operating-system-command (OSC) sequences, including hyperlinks. */
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** CSI sequences (colors, cursor movement, erase). */
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/** Other two-byte escape sequences. */
const ANSI_ESC = /\x1b[@-_]/g

/** C0 control bytes that carry no terminal-safe text (newline and tab stay). */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** Lines worth surfacing in `errors` and `summary` modes. */
const ERROR_LINE = /(?:\berror\b|\bfailed\b|\bfailure\b|\bfatal\b|\bexception\b|\btraceback\b|\bpanic\b|\bassertion\b)/i

/** Defaults kept in sync with the tool configuration. */
export const OPTIMIZE_DEFAULTS = Object.freeze({
  lines: 200,
  maxBytes: 16384,
  summaryHead: 20,
})

const encoder = new TextEncoder()

/**
 * UTF-8 byte length without allocating a Buffer.
 * @param {string} text
 * @returns {number}
 */
export function byteLength(text) {
  return encoder.encode(text).byteLength
}

/**
 * Remove terminal escape sequences and control bytes from a chunk of text.
 * Carriage returns are handled separately so progress bars collapse to their
 * last visible segment instead of becoming blank lines.
 * @param {string} text
 * @returns {string}
 */
export function stripTerminalNoise(text) {
  return String(text ?? '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_ESC, '')
}

/**
 * Collapse terminal carriage-return redraws: within one line, keep the last
 * non-empty segment. A trailing `\r` after progress output therefore leaves
 * the final rendered state, not an empty line.
 * @param {string} text
 * @returns {string}
 */
export function collapseCarriageReturns(text) {
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line
      const segments = line.split('\r').filter((segment) => segment.length > 0)
      return segments.length === 0 ? '' : segments[segments.length - 1]
    })
    .join('\n')
}

/**
 * Normalize one terminal stream: escape sequences, CR redraws, control bytes,
 * trailing spaces, and runs of blank lines.
 * @param {string} text
 * @returns {string}
 */
export function normalizeOutput(text) {
  let value = stripTerminalNoise(text)
  value = value.replace(/\r\n/g, '\n')
  value = collapseCarriageReturns(value)
  value = value.replace(CONTROL, '')
  value = value.replace(/[ \t]+$/gm, '')
  value = value.replace(/\n{3,}/g, '\n\n')
  return value.replace(/^\n+|\n+$/g, '')
}

/**
 * Merge consecutive identical lines into `line (×N)`.
 * @param {string[]} lines
 * @returns {{lines: string[], deduped: number}}
 */
export function dedupeAdjacent(lines) {
  const merged = []
  let deduped = 0
  for (const line of lines) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.text === line) {
      last.count += 1
      deduped += 1
    } else {
      merged.push({ text: line, count: 1 })
    }
  }
  return {
    lines: merged.map((entry) => (entry.count > 1 ? `${entry.text} (×${entry.count})` : entry.text)),
    deduped,
  }
}

/** Indices of error-like lines plus one line of context on each side. */
function errorIndices(lines) {
  const indices = new Set()
  for (let index = 0; index < lines.length; index += 1) {
    if (!ERROR_LINE.test(lines[index])) continue
    indices.add(index)
    if (index > 0) indices.add(index - 1)
    if (index + 1 < lines.length) indices.add(index + 1)
  }
  return [...indices].sort((left, right) => left - right)
}

/** Join selected indices, marking every gap with the number of omitted lines. */
function joinWithGaps(lines, indices) {
  const parts = []
  let previous = -1
  for (const index of indices) {
    const gap = index - previous - 1
    if (gap > 0) parts.push(`... (${gap} line${gap === 1 ? '' : 's'} omitted)`)
    parts.push(lines[index])
    previous = index
  }
  const trailing = lines.length - previous - 1
  if (trailing > 0) parts.push(`... (${trailing} line${trailing === 1 ? '' : 's'} omitted)`)
  return parts
}

/**
 * Build a summary view: head, error lines, tail, with gaps marked.
 * @param {string[]} lines
 * @param {number} lineBudget
 * @returns {{lines: string[], omitted: number}}
 */
function summaryLines(lines, lineBudget) {
  const headCount = Math.min(OPTIMIZE_DEFAULTS.summaryHead, Math.max(0, lineBudget - 1))
  const tailCount = Math.max(0, lineBudget - headCount)
  const selected = new Set()
  for (let index = 0; index < Math.min(headCount, lines.length); index += 1) selected.add(index)
  for (let index = Math.max(0, lines.length - tailCount); index < lines.length; index += 1) selected.add(index)
  for (const index of errorIndices(lines)) selected.add(index)
  const chosen = [...selected].sort((left, right) => left - right)
  return { lines: joinWithGaps(lines, chosen), omitted: Math.max(0, lines.length - chosen.length) }
}

/**
 * Keep a head and a tail of `text` under a UTF-8 byte budget.
 * @param {string} text
 * @param {number} maxBytes
 * @param {string} reason
 * @returns {{text: string, omittedBytes: number, omittedLines: number}}
 */
function capBytes(text, maxBytes, reason) {
  const inputBytes = byteLength(text)
  if (inputBytes <= maxBytes) return { text, omittedBytes: 0, omittedLines: 0 }

  const lines = text.split('\n')
  const markerReserve = 120
  const headBudget = Math.max(64, Math.floor((maxBytes - markerReserve) * 0.35))
  const tailBudget = Math.max(64, maxBytes - markerReserve - headBudget)
  const head = []
  let headBytes = 0
  for (const line of lines) {
    const cost = byteLength(line) + 1
    if (headBytes + cost > headBudget) break
    head.push(line)
    headBytes += cost
  }
  const tail = []
  let tailBytes = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cost = byteLength(lines[index]) + 1
    if (tailBytes + cost > tailBudget) break
    tail.unshift(lines[index])
    tailBytes += cost
  }
  const omittedLines = Math.max(0, lines.length - head.length - tail.length)
  const omittedBytes = Math.max(0, inputBytes - headBytes - tailBytes)
  const marker = `\n[optimized: omitted ${omittedLines} line${omittedLines === 1 ? '' : 's'} / ${omittedBytes} bytes (${reason})]\n`
  let output = `${head.join('\n')}${marker}${tail.join('\n')}`
  while (byteLength(output) > maxBytes && tail.length > 0) {
    tail.shift()
    output = `${head.join('\n')}${marker}${tail.join('\n')}`
  }
  return { text: output, omittedBytes, omittedLines }
}

/**
 * Optimize one job-output stream.
 * @param {string} text
 * @param {{mode?: string, lines?: number, maxBytes?: number}} [options]
 * @returns {{text: string, mode: string, inputLines: number, outputLines: number, inputBytes: number, outputBytes: number, dedupedLines: number, omittedLines: number, omittedBytes: number, matchedErrors: number}}
 */
export function optimizeJobOutput(text, options = {}) {
  const raw = String(text ?? '')
  const inputBytes = byteLength(raw)
  const inputLines = raw.length === 0 ? 0 : raw.split('\n').length
  const requestedMode = options.mode ?? 'auto'
  if (requestedMode === 'raw') {
    return {
      text: raw,
      mode: 'raw',
      inputLines,
      outputLines: inputLines,
      inputBytes,
      outputBytes: inputBytes,
      dedupedLines: 0,
      omittedLines: 0,
      omittedBytes: 0,
      matchedErrors: 0,
    }
  }

  const normalized = normalizeOutput(raw)
  const allLines = normalized.length === 0 ? [] : normalized.split('\n')
  const deduped = dedupeAdjacent(allLines)
  const lines = deduped.lines
  const lineBudget = Math.max(1, Math.min(2000, Math.trunc(options.lines ?? OPTIMIZE_DEFAULTS.lines)))
  const maxBytes = Math.max(512, Math.min(262144, Math.trunc(options.maxBytes ?? OPTIMIZE_DEFAULTS.maxBytes)))

  let mode = requestedMode
  if (!['auto', 'full', 'head', 'tail', 'errors', 'summary'].includes(mode)) mode = 'auto'

  let selected
  let omittedLines = 0
  let matchedErrors = 0
  if (mode === 'full') {
    selected = lines
  } else if (mode === 'head') {
    selected = lines.slice(0, lineBudget)
    omittedLines = Math.max(0, lines.length - selected.length)
  } else if (mode === 'tail') {
    selected = lines.slice(Math.max(0, lines.length - lineBudget))
    omittedLines = Math.max(0, lines.length - selected.length)
  } else if (mode === 'errors') {
    const indices = errorIndices(lines)
    matchedErrors = indices.filter((index) => ERROR_LINE.test(lines[index])).length
    selected = indices.map((index) => lines[index])
    if (selected.length === 0) {
      selected = ['(no error-like lines; showing tail)', ...lines.slice(Math.max(0, lines.length - lineBudget))]
    }
    omittedLines = Math.max(0, lines.length - selected.length)
  } else {
    const fits = byteLength(normalized) <= maxBytes && lines.length <= lineBudget
    if (mode === 'auto' && fits) {
      mode = 'full'
      selected = lines
    } else {
      mode = 'summary'
      const summary = summaryLines(lines, lineBudget)
      selected = summary.lines
      omittedLines = summary.omitted
      matchedErrors = errorIndices(lines).filter((index) => ERROR_LINE.test(lines[index])).length
    }
  }

  const body = selected.join('\n').replace(/^\n+|\n+$/g, '')
  const capped = capBytes(body, maxBytes, `mode=${mode}`)
  const finalText = capped.text
  return {
    text: finalText,
    mode,
    inputLines,
    outputLines: finalText.length === 0 ? 0 : finalText.split('\n').length,
    inputBytes,
    outputBytes: byteLength(finalText),
    dedupedLines: deduped.deduped,
    omittedLines: Math.min(lines.length, omittedLines + capped.omittedLines),
    omittedBytes: capped.omittedBytes,
    matchedErrors,
  }
}
