---
"@capybara-hq/plugin-anthropic": patch
---

The provider streams a tool call's input as it arrives: `tool_call_start` at the `tool_use` block
and a `tool_call_delta` per `input_json_delta` fragment (streaming tool input contract, SDK
0.1.0-rc.81); `message_complete` is unchanged.
