---
"@capybara-hq/plugin-bailian": patch
"@capybara-hq/plugin-deepseek": patch
"@capybara-hq/plugin-openai-compatible": patch
---

`toolChoice: "none"` keeps the prompt cache on DashScope and DeepSeek. Both services render a
request with `tool_choice: "none"` without the tool definitions, so the in-context summary and the
step-limit wrap-up missed the cache of the turn before them (bailian read 0 tokens). bailian,
deepseek and the openai-compatible `deepseek` / `qwen` dialects no longer send the field: the tools
stay declared and any tool call the model makes anyway is dropped from the reply (only the text,
stop reason `end_turn`). Live: qwen3.7-max, qwen-plus (native and compatible mode), deepseek-flash.
