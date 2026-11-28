---
"@capybara-hq/plugin-browser": patch
---

The browser panel keeps the conversation's empty state ("The agent has not opened a page in this
conversation yet") while it reconnects (a stream that ended, a hidden tab coming back) instead of
flashing the connecting skeleton: there is no page to wait for.
