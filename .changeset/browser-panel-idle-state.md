---
"@capybara-hq/plugin-browser": patch
---

When there is no browser to show (not running, device offline, live view stopped), the browser
panel shows only the centred idle state (title, one line, 重新连接) on the neutral ground. There is
no empty tab strip, toolbar or status line reserving space above it. When the browser comes up, the
panel switches once to the live layout on its first frame.
