# @mosire/dsh-prompt-lab-session

Agent-callable orchestration for batch prompt experiments. Two tools:

- `prompt_lab_workspaces` — list the **configured DSH workspaces** (`workspaceId`, `title`, `path`,
  `sessionCount`).
- `prompt_lab_session` — create a **new top-level (sibling) session inside one existing workspace**
  under the `minimal-prompt-lab` preset, apply a chosen system prompt and optional model, and
  optionally run one task and return its final answer.

One call = one independent session, so the same task can be replayed across many prompts without
touching the caller's context. Subagents are the wrong shape for this (they inherit the caller's
context and tool surface), and the official headless runner refuses sessions that carry a preset;
this package goes through the official `sessionController` instead.

## Install

Part of the `@mosire/dshom` bundle (`features.promptLabSession`, enabled by default). After the Host
restarts, both tools are installed into every **top-level** Agent scope; subagent scopes are skipped.
`{ "features": { "promptLabSession": false } }` disables the feature.

## `prompt_lab_workspaces`

No arguments. Returns:

```json
{ "workspaces": [{ "workspaceId": "…", "title": "test", "path": "/home/cna/test", "sessionCount": 5 }] }
```

Call it first and pass one of the returned `workspaceId`/`title`/`path` values as `workspace`.

## `prompt_lab_session`

```json
{
  "workspace": "workspace id, exact title, or path",
  "prompt": { "kind": "file|text|blank|default", "path": "...", "text": "..." },
  "model": { "provider": "deepseek", "model": "deepseek-chat", "reasoning_effort": "high" },
  "task": "optional task sent after the prompt is selected",
  "timeout_seconds": 600
}
```

`workspace` is required; `prompt`, `model`, and `task` are optional. `cwd` and `preset` are rejected:
creation is always inside an existing workspace, and the preset is always `minimal-prompt-lab`.

Returns:

```json
{
  "sessionId": "session-…", "preset": "minimal-prompt-lab",
  "workspaceId": "…", "workspaceTitle": "…", "workspacePath": "/home/cna/test", "cwd": "…",
  "prompt": { "kind": "file", "path": "…", "bytes": 123, "sha256": "…" },
  "model": { "provider": "deepseek", "model": "deepseek-chat", "reasoningEffort": "high" },
  "status": "created|idle|timeout", "taskSent": false, "answer": "…", "elapsedMs": 12
}
```

- **Workspace resolution** — by id, then exact title or path, then `resolveByPath`. Unknown
  workspaces fail before any session is created and the error lists the configured workspaces.
  Creation goes through `sessionController.create({ workspaceId, agentPreset })`, which attaches
  the new session to the workspace (`workspace.attachSession`), so it appears under that workspace
  in the Web UI rather than in「未分组」.
- **Prompt** — `file` is validated now (`UTF-8`, BOM stripped, non-empty, ≤256 KiB) and read again
  at the session's next request; relative paths resolve against the workspace path. `text` is a
  single line; `blank` is a single ASCII space; `default` is the official Minimal persona (clears a
  selection). The selection runs the preset-scoped `/sp` command in the new session; the prompt text
  is never stored by this package — the session's `prompt-lab` projection is the authority.
- **Model** — validated against `controller.modelCatalog()` before creation (provider, model, and an
  advertised reasoning effort). The tool records a `model/selection` session event for that session
  instead of calling `sessionController.selectModel`, because `selectModel` also saves the
  deployment default model; batch runs must not change the default.
- **Task** — `controller.prompt(...)` then waits until the session is idle (up to `timeout_seconds`,
  capped at 3600); the answer is the last non-empty assistant message. A timeout returns the
  session id without killing the turn.
- **Scope** — installed per Agent (`agent.ctx.tools.register`), following `agent/created` /
  `agent/disposed`; status file `$DSH_HOME/prompt-lab-session-status.json` names both tools.

## Example

```json
{
  "workspace": "test",
  "prompt": { "kind": "file", "path": "/home/cna/test/6.md" },
  "model": { "provider": "deepseek", "model": "deepseek-chat" },
  "task": "你好"
}
```

## Verification

- `node --test packages/dsh-prompt-lab-session/test/*.test.mjs` → 12/12.
- Live spawn-only on a temporary 3099 Host: workspace listing, workspace attach, preset,
  `/sp file` selection in the `prompt-lab` projection, and dshom installing the tool — 12/12 checks.
  Evidence: `.superpowers/sdd/2026-11-04-prompt-lab-session/evidence/live-spawn.json`.
- The `task` wait/timeout and the four `/sp` kinds are covered by unit tests only; live model turns
  are left to the experiment runner.
