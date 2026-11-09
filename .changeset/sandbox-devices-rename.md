---
"@capybara-hq/plugin-sandbox-docker": patch
"@capybara-hq/plugin-sandbox-e2b": patch
---

Follow core's rename of environments to devices: sandbox resource names are now `cap-device-<id>` (Docker egress proxy and volumes derive from it), and the docs, error text and tests use device vocabulary.
