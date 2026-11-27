---
"@capybara-hq/plugin-browser": patch
---

Screenshots and the live view's first frame no longer drop a tab's viewport after a viewport
profile switch (full Chromium on macOS showed the phone size, or the window's size, after hand
back): captures go through the session holding the tab's device metrics, one at a time, never
overlapping a profile change.
