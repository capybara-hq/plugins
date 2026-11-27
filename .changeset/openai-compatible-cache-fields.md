---
"@capybara-hq/plugin-openai-compatible": patch
---

The `qwen` dialect sends DashScope's explicit cache markers (the last cached system block and the
last block of the history), so long conversations cache their history; the `ark` dialect defaults
`caching` to true and sends a per-conversation `prompt_cache_key`.
