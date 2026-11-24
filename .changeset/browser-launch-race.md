---
"@capybara-hq/plugin-browser": patch
---

The browser daemon no longer launches a headless shell another process on the device is still
installing into the same directory (it waits for Playwright's install marker and lock instead of
starting half-written files), and reinstalls one whose executable went missing. A daemon stop never
hangs on the browser: a Chromium that has not closed within 3 s is killed rather than waited for
until Playwright's 180 s timeout, and a launch or install still running at the stop is abandoned
(it only closes when it finishes; an unfinished install has no marker, so the next start installs
again).
