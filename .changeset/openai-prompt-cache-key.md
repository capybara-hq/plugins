---
"@capybara-hq/plugin-openai": patch
---

Requests carry a `prompt_cache_key` hashed from the org and the system prompt: the conversations of
one agent keep sharing their cached prefix, and orgs sharing an API key never share cache entries.
