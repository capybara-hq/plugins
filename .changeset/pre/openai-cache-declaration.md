---
"@capybara-hq/plugin-openai": patch
---

Declare the prompt cache per chat model. GPT-5.6 and later offer 30m and 12h lifetimes: `cacheTtl`
1800 / 43200 maps to `prompt_cache_options.ttl` (never sent to earlier models), and the usage
write split by tier maps to `cacheWriteByTtl`. Earlier models declare an implicit cache with no
guaranteed lifetime.
