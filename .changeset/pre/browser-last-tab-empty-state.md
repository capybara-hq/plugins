---
"@capybara-hq/plugin-browser": patch
---

Closing the browser's last page no longer drops the live view: a deliberate close (the person's
in a takeover, the agent's, an idle or deleted conversation's) that would leave Chromium without a
page first opens an unowned blank tab, so Chromium never exits with its last window (which the
daemon took for a crash, cutting the panel's stream: the panel showed the connecting skeleton
before its empty state).
