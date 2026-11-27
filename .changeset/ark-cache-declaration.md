---
"@capybara-hq/plugin-ark": patch
---

Chat models with Ark's implicit context cache now declare it in `ModelInfo.cache` (implicit, no
lifetime options, hits not guaranteed, the per-model minimum cacheable prefix).
