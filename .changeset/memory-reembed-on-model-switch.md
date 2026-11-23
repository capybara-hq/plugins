---
"@capybara-hq/plugin-memory": patch
---

Re-embed memories when the org's `memory.embed` model switches back to a model used before. The
`memory-embed` job id now carries the target model and a per-memory embedding version (new column
`embedding_version`, migration 0002), so it never collides with a job the queue still retains.
