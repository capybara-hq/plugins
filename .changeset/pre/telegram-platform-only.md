---
"@capybara-hq/plugin-telegram": patch
---

The deployment config is marked platform-only (unified plugin config, core#720): this plugin has no
org-bound entry, so an org never overrides its fields.
