---
"@capybara-hq/plugin-openai": patch
---

Stream tool call input: the Responses stream emits `tool_call_start` (keyed by `call_id`) and
`tool_call_delta` events as function call arguments arrive; `message_complete` is unchanged.
