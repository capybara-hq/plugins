---
"@capybara-hq/plugin-openai-compatible": patch
"@capybara-hq/plugin-ark": patch
"@capybara-hq/plugin-deepseek": patch
"@capybara-hq/plugin-bailian": patch
---

Stream tool call input: emit `tool_call_start` and `tool_call_delta` events as the arguments arrive (an id the upstream omits is synthesized once and reused in `message_complete`).
