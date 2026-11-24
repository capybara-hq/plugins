---
"@capybara-hq/plugin-browser": patch
---

The browser daemon no longer launches a headless shell another process on the device is still
installing into the same directory (it waits for Playwright's install marker and lock instead of
starting half-written files), and a daemon stop kills a Chromium that has not closed within 3 s
rather than waiting for Playwright's 180 s.
