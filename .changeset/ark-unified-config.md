---
"@capybara-hq/plugin-ark": patch
---

The deployment config drops `orgAccess`: every field is org-overridable by default (unified plugin
config, core#720).

The `openai` SDK client reads no `OPENAI_*` host environment variable: the key, admin key,
organization, project, webhook secret and base URL are always explicit, and `OPENAI_CUSTOM_HEADERS`
(which the SDK merges into every request, even over the key) is dropped, so no host value reaches
Ark.
