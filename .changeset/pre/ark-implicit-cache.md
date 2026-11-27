---
"@capybara-hq/plugin-ark": patch
---

Models with Ark's implicit context cache (every current doubao-seed, deepseek, kimi and glm chat
model, read from the list's `features.cache`) now report `caching` instead of only the DeepSeek
models, and each request carries a per-conversation `prompt_cache_key` (a hash, no prompt text) so
a conversation keeps reaching the same cache.
