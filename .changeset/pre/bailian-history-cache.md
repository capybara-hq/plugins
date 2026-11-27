---
"@capybara-hq/plugin-bailian": patch
---

Long conversations now cache their history, not only the system prompt: the last content block of
the history carries DashScope's explicit `cache_control` marker, so each turn reads the whole earlier
conversation from the cache (explicit and implicit caching exclude each other per request, so with
only the system marker the history got neither). Verified live on qwen4-max, qwen3.7-max,
qwen3.8-flash, qwen-plus and glm-5.1.
