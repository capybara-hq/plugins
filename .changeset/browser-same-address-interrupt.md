---
"@capybara-hq/plugin-browser": patch
---

A navigation that Chromium restarts to the same address (after a change of the device's network) is
followed to its page instead of failing with "interrupted by another navigation".
