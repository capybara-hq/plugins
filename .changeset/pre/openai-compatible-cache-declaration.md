---
"@capybara-hq/plugin-openai-compatible": patch
---

Each model declares its prompt cache. `qwen` declares the explicit 5-minute DashScope cache
(guaranteed, refreshed on a hit, 1024-token minimum) and reports a write under its 300 s tier
(`cacheWriteByTtl`); `deepseek` and `ark` declare an implicit, non-guaranteed cache; `generic`
declares none. The model's `caching` setting still switches it: `false` declares none, `true` on
`generic` declares an implicit cache.
