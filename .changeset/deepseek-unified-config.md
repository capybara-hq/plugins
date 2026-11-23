---
"@capybara-hq/plugin-deepseek": patch
---

The deployment config drops `orgAccess`: every field is org-overridable by default (unified plugin
config, core#720). An org's own base URL goes through `configUrlFetch`.
