---
"@capybara-hq/plugin-anthropic": patch
---

Every model declares its prompt cache (`ModelInfo.cache`): explicit breakpoints, 5 minutes or 1
hour, with the per-model minimum cacheable length. `ModelRequest.cacheTtl: 3600` puts `ttl: "1h"` on
every `cache_control` the request sends, and the usage's per-TTL write split is reported as
`cacheWriteByTtl`. The model cache key in `ctx.kv` moves to `models:v5:`.
