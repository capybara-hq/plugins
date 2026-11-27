---
"@capybara-hq/plugin-deepseek": patch
---

Every chat model now declares its prompt cache (implicit, no ttl choice, minimum 256 tokens), so
the kernel knows DeepSeek caches automatically.
