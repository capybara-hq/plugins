---
"@capybara-hq/plugin-browser": patch
---

Tab ownership follow-ups: a navigation that a late error page interrupted runs again when its
request was aborted; `browser_wait` never claims or opens a tab (also while the person holds
control); a conversation's first call claims only the browser's blank start tab; an evicted tab is
closing from the start; the device cap leaves out tabs already closing; after losing its active tab,
a conversation's newest gained tab becomes active.
