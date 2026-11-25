---
"@capybara-hq/plugin-browser": patch
---

A stopping browser daemon waits until Chromium's process is gone, not only for Playwright to report the close, so a restart on the same profile no longer reads cookies Chromium had not finished writing.
