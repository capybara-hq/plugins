---
"@capybara-hq/plugin-bailian": patch
---

Chat models with Bailian's `cache` feature declare their prompt cache: explicit, 5 minutes renewed
on every hit, from 1024 tokens. Qwen4 models also declare a 1-hour option: `cacheTtl: 3600` is sent
as `parameters.prompt_cache_options.ttl`, and the written tokens come back by tier in
`cacheWriteByTtl`.
