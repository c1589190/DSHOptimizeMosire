/**
 * `/sp` — the prompt-lab preset's only command.
 *
 * Preset-scoped: it exists only in sessions of `minimal-prompt-lab`. The handler
 * writes nothing to the session; the command service itself appends
 * `command/run`/`command/done`, and the `prompt-lab` projection folds those
 * events (successful runs only) into the session's selection. The next model
 * request is what actually reads the selected file.
 *
 * `/sp show` is metadata only: source, bytes, SHA-256, pending/frozen state —
 * the prompt text itself is already in the session's first `system/message`.
 */

import {
  COMMAND_NAME,
  PROMPT_LAB_KEY,
  isSwitchPending,
  parsePromptLabInput,
  readPromptFile,
  resolveSelection,
  resolveSelectionPath,
  sha256,
} from '../../lib/prompt-lab-state.js'

export const name = 'prompt-lab-command'

export const inject = ['commands']

export function apply(ctx) {
  const definition = {
    name: COMMAND_NAME,
    description: '配置本会话的系统提示词（实验用）',
    input: { hint: 'file <path> | text <一行> | blank | clear | show' },
    handler: (invocation) => run(ctx, invocation),
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => ctx.commands.register(definition))
  else ctx.commands.register(definition)
}

function run(ctx, invocation) {
  const parsed = parsePromptLabInput(invocation?.rawInput ?? '')
  if (parsed.kind === 'error') return { kind: 'error', text: parsed.message }

  const agent = invocation?.agent
  const state = readState(ctx, agent)
  const cwd = state?.cwd || agent?.session?.header?.cwd || ''

  if (parsed.kind === 'show') return { kind: 'success', text: formatShow(state, cwd) }
  if (state === undefined) {
    return { kind: 'error', text: 'prompt-lab 状态不可用：sessionProjections 未注册，选择不会生效。' }
  }

  switch (parsed.kind) {
    case 'file': {
      const path = resolveSelectionPath(parsed.path, cwd)
      if (path === null) return { kind: 'error', text: '相对路径需要一个会话工作目录；请用绝对路径。' }
      const file = readPromptFile(path)
      if (!file.ok) return { kind: 'error', text: file.error }
      return {
        kind: 'success',
        text: `已选择 ${path}\n${file.bytes} bytes · sha256 ${file.sha256}\n下一条消息生效（整段缓存失效）。`,
      }
    }
    case 'text':
      return {
        kind: 'success',
        text: `已选择内联文本（${Buffer.byteLength(parsed.text, 'utf8')} bytes · sha256 ${sha256(parsed.text)}）\n下一条消息生效（整段缓存失效）。`,
      }
    case 'blank':
      return { kind: 'success', text: '已选择空提示词（单个空格）\n下一条消息生效（整段缓存失效）。' }
    case 'clear':
      return { kind: 'success', text: '已选择官方 persona 行\n下一条消息生效（整段缓存失效）。' }
    default:
      return { kind: 'error', text: '未知的 /sp 子命令。' }
  }
}

function readState(ctx, agent) {
  try {
    const registry = ctx.get?.('sessionProjections')
    if (registry && typeof registry.stateOf === 'function' && agent?.session) {
      return registry.stateOf(agent.session, PROMPT_LAB_KEY)
    }
  } catch {
    // fall through: the caller reports the unavailable service
  }
  return undefined
}

function describeSelection(selection, cwd) {
  switch (selection.kind) {
    case 'file': {
      const path = resolveSelectionPath(selection.path, cwd)
      const resolved = resolveSelection(selection, cwd)
      return resolved.ok
        ? `文件 ${path}（${resolved.bytes} bytes · sha256 ${resolved.sha256}）`
        : `文件 ${path ?? selection.path}（当前不可读：${resolved.error}）`
    }
    case 'text':
      return `内联文本（${Buffer.byteLength(selection.text, 'utf8')} bytes · sha256 ${sha256(selection.text)}）`
    case 'blank':
      return '空提示词（单个空格）'
    case 'default':
      return '官方 persona 行'
    default:
      return String(selection.kind)
  }
}

function formatShow(state, cwd) {
  if (state === undefined) return 'prompt-lab 状态不可用：sessionProjections 未注册。'
  const lines = []
  if (state.selection === null) {
    lines.push('选择：未设置（官方 persona 行）')
  } else {
    lines.push(`选择：${describeSelection(state.selection, cwd)}`)
    lines.push(isSwitchPending(state) ? '状态：待下一条消息生效' : '状态：已生效（本会话已冻结）')
  }
  if (state.lastSystemText !== '') {
    lines.push(`快照：seq ${state.lastSystemSeq} · ${Buffer.byteLength(state.lastSystemText, 'utf8')} bytes · sha256 ${sha256(state.lastSystemText)}`)
  } else {
    lines.push('快照：无（本会话还没发过请求）')
  }
  return lines.join('\n')
}
