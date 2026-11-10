# @mosire/dsh-session-inspect

Read-only session inspection for a top-level Agent. Three tools:

- `session_list` — list sessions with workspace/preset/subagent/live filters and (when available) titles.
- `session_read` — read one session in `surface` (current model context), `raw` (complete event log), or
  `event` (`seq` ± window) mode.
- `session_find` — literal, case-insensitive scan inside one session's rendered event text; returns
  matching `seq`/`type` plus a snippet.

Nothing is written, added, or deleted: the package only calls `ctx.sessionQuery` and (for workspace
filtering) `ctx.workspaceRegistry`.

## Why

A session can be long, compacted, and shared across agents. Explaining "what did that other conversation
actually see?" needs the **current surface**, not the raw event stream; searching it needs a literal
scan because the Web profile ships full-text search disabled
(`@deepseek-ai/dsh-web-app` `session-query-sqlite` row: `openAt: never`).

## Install

Part of `@mosire/dshom` (`features.sessionInspect`, enabled by default). Host restart required. The
tools are installed into **top-level** Agent scopes only; subagent scopes (`header.parentSession` or
`origin: "subagent"`) are skipped. `{ "features": { "sessionInspect": false } }` disables the feature.

## `session_list`

```json
{ "workspace": "workspace id, exact title, or path", "preset": "minimal-prompt-lab",
  "include_subagents": false, "live": true, "limit": 20 }
```

Returns `{ "sessions": [{ "sessionId", "title?", "preset?", "cwd?", "parentSession?", "createdAt",
"live", "persisted" }] }`, newest first. Top-level sessions only by default. `workspace` resolves by id,
then exact title or path, then `resolveByPath`; unknown workspaces fail and list the configured ones.

## `session_read`

```json
{ "session": "session-…", "mode": "surface|raw|event",
  "limit": 200, "max_chars": 30000, "tail": false,
  "types": ["user/message", "assistant/message"], "from_seq": 1, "to_seq": 100,
  "seq": 42, "before": 2, "after": 2, "include_reasoning": false }
```

- `surface` — the **current model context** (`sessionQuery.readSurface`): system/developer/user/
  assistant/tool-result events as the model sees them; reasoning blocks are hidden unless
  `include_reasoning: true`. Shows `capturedThroughSeq`.
- `raw` — the complete raw log (`sessionQuery.readSession`), optionally filtered by `types`,
  `from_seq`, `to_seq`.
- `event` — `sessionQuery.readEvent({sessionId, seq, before, after})`; `before`/`after` are clamped to
  `0..50` (`SESSION_QUERY_READ_WINDOW_MAX`). The surrounding window and the target marker are rendered.

The header includes session/preset/title/cwd/parent/created, mode, event count, captured seq, model,
tool count, turns, and token totals. Output text is bounded by `max_chars` (default 30000, max 200000);
`limit` and `tail` bound the number of events. A truncation note reports the next `seq`.

## `session_find`

```json
{ "session": "session-…", "query": "prompt-lab", "limit": 20 }
```

Returns `{ "sessionId", "query", "total", "matches": [{ "seq", "type", "time", "surface", "snippet" }] }`.
The scan uses this package's `eventText()` over `sessionQuery.readSession()` and is literal,
case-insensitive, and whitespace-flexible. Use `session_read` with `mode: "event"` and the returned
`seq` for context.

> Implementation note: the tool does **not** call `sessionQuery.filterEvents` because the official
> `extractSessionEventText()` skips `system/message` (and completed `turn/end`). Scanning the rendered
> text keeps `session_find` consistent with what `session_read` shows, including system prompts.

## Limits

- Maximum 100 sessions in `session_list` (default 20).
- Maximum 1000 events in `session_read` (default 200) and 200000 rendered characters (default 30000).
- `session_find` returns at most 100 matches (default 20) but reports the total number of matching events.
- Very large sessions are loaded in full by `surface`/`raw`/`find`; this is a debugging tool, not a
  streaming reader.

## Verification

- Unit: `node --test packages/dsh-session-inspect/test/*.test.mjs` → 14/14.
- Live (in-process `runProfile`, web profile, 127.0.0.1:3099, live `~/.dsh`): 18/18 checks against the
  real `sessionQuery` service — list, title, live flag, surface (system + user + runtime-context +
  assistant, reasoning hidden, model/token header), raw request/turn-end, find on the system prompt,
  and event-window drilling. Evidence:
  `.superpowers/sdd/2026-11-04-session-inspect/evidence/live-session-inspect.json`.
- Cross-session full-text search is intentionally not provided (the Web profile keeps FTS off).
