/**
 * Host half of the timing-annotations bundle. The Client half owns every
 * rendering: it registers two additions into Chat's official slots
 * (`conversation.chat.assistant-actions` and `conversation.chat.turnTail`) and
 * derives start/duration from the Session-backed Chat snapshot. No host
 * service, tool, or prompt contribution is involved.
 */
export function apply() {}
