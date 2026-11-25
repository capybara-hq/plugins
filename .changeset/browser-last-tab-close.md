---
"@capybara-hq/plugin-browser": patch
---

Closing the last tabs quickly (two closes in a takeover, or a close beside a tab list) leaves one
blank tab, not one per close: callers that find no tab share the one blank tab being opened. The
panel labels a blank tab "New tab" (新标签页) instead of about:blank.
