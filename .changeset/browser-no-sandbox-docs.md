---
"@capybara-hq/plugin-browser": patch
"@capybara-hq/plugin-device-docker": patch
---

Document that Chromium runs with `--no-sandbox` in device-docker devices: the device container is
the isolation boundary (plugins#286).
