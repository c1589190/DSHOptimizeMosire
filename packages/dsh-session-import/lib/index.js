/**
 * `/import <path>` — Host-side entry for the session importer.
 *
 * The command reads a ZIP (or a bare JSONL / zstd log) from a host path and
 * hands it to `importArchive`, which writes through the official persistence
 * service. Nothing here touches the wire tool surface or the client bundle.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { importArchive } from './import.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'session-import'

/** Slash command name, without the leading slash. */
export const COMMAND_NAME = 'import'

const USAGE = '用法：/import <zip|jsonl|jsonl.zstd 路径>'

/** Read an optional service without assuming the call succeeds. */
function service(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]
  } catch {
    return undefined
  }
}

/**
 * @param {object} ctx - Cordis context.
 * @param {{maxBytes?: number}} [config]
 */
export function apply(ctx, config = {}) {
  const options = config !== null && typeof config === 'object' ? config : {}
  if (service(ctx, 'commands') !== undefined && service(ctx, 'sessionPersistence') !== undefined) {
    register(ctx, options)
    return
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands', 'sessionPersistence'], (ready) => register(ready ?? ctx, options))
  }
}

function register(ctx, options) {
  const commands = service(ctx, 'commands')
  const persistence = service(ctx, 'sessionPersistence')
  if (commands === undefined || persistence === undefined) return
  commands.register({
    name: COMMAND_NAME,
    description: '从 Session 日志导入会话：/import <zip|jsonl|jsonl.zstd 路径>',
    input: { hint: '<路径>' },
    handler: (invocation) =>
      runImport(invocation, {
        persistence,
        attachments: service(ctx, 'attachments'),
        maxBytes: options.maxBytes,
      }),
  })
}

/**
 * @param {{rawInput?: string, agent?: {cwd?: string}, signal?: AbortSignal}} invocation
 * @param {{persistence: object, attachments?: object, maxBytes?: number}} deps
 * @returns {Promise<{kind: 'success'|'error', text: string}>}
 */
export async function runImport(invocation, deps) {
  const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
  if (raw === '') return { kind: 'error', text: USAGE }
  const cwd = typeof invocation.agent?.cwd === 'string' && invocation.agent.cwd.length > 0
    ? invocation.agent.cwd
    : process.cwd()
  const path = resolveInputPath(raw, cwd)
  let buffer
  try {
    buffer = await readFile(path)
  } catch (error) {
    return { kind: 'error', text: `无法读取 ${path}：${errorMessage(error)}` }
  }
  let report
  try {
    report = await importArchive({
      buffer,
      persistence: deps.persistence,
      attachments: deps.attachments,
      fallbackCwd: cwd,
      maxBytes: deps.maxBytes,
      signal: invocation.signal,
    })
  } catch (error) {
    return { kind: 'error', text: `导入失败：${errorMessage(error)}` }
  }
  return formatImportReport(report)
}

/**
 * @param {{sessions: Array<{id: string, cwd?: string}>, failures: Array<{id: string, error: string}>, attachmentErrors: Array<{name: string, error: string}>, skipped: string[], renames: Array<[string, string]>, attachments: number}} report
 * @returns {{kind: 'success'|'error', text: string}}
 */
export function formatImportReport(report) {
  const lines = []
  if (report.sessions.length === 0) {
    lines.push(`没有会话被导入（${report.failures.length} 个失败）`)
  } else {
    const root = report.sessions[0]
    const parts = [`已导入 ${report.sessions.length} 个会话，根会话 ${root.id}（cwd: ${root.cwd ?? '未知'}）`]
    if (report.attachments > 0) parts.push(`附件 ${report.attachments} 个`)
    if (report.skipped.length > 0) parts.push(`跳过 ${report.skipped.length} 项`)
    lines.push(parts.join('；'))
  }
  for (const [from, to] of report.renames) lines.push(`原 ${from} -> ${to}`)
  for (const failure of report.failures) lines.push(`导入失败 ${failure.id}：${failure.error}`)
  for (const error of report.attachmentErrors) lines.push(`附件失败 ${error.name}：${error.error}`)
  return { kind: report.sessions.length === 0 ? 'error' : 'success', text: lines.join('\n') }
}

function resolveInputPath(raw, cwd) {
  let value = raw
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1)
  }
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return isAbsolute(value) ? value : resolve(cwd, value)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
