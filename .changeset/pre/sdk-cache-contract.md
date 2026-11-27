---
"@capybara-hq/plugin-theme-cyberpunk": patch
"@capybara-hq/plugin-anthropic": patch
"@capybara-hq/plugin-openai": patch
"@capybara-hq/plugin-openai-compatible": patch
"@capybara-hq/plugin-deepseek": patch
"@capybara-hq/plugin-bailian": patch
"@capybara-hq/plugin-ark": patch
---

Move to plugin-sdk 0.1.0-rc.84, whose `ModelInfo.cache` replaces `capabilities.caching`. The models
no longer report `caching`; the per-model cache declaration follows in the next changes.

The cyberpunk theme drops its rule for the removed `status-bar` part, which the new host no
longer knows.
