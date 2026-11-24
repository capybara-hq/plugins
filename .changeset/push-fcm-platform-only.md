---
"@capybara-hq/plugin-push-fcm": patch
---

The deployment config is marked platform-only (unified plugin config, core#720): this plugin has no
org-bound entry, so an org never overrides its fields.
