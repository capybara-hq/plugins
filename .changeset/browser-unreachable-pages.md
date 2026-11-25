---
"@capybara-hq/plugin-browser": patch
---

Pages such as www.google.com load through a device proxy with credentials: the daemon disables
Chromium's `AcceptCHFrame` (Playwright's proxy-credential interception lost the request Chromium
restarts for an ACCEPT_CH frame, so the navigation hung at about:blank), keeping Playwright's own
disabled features. A navigation that fails now says why (`unreachable`): Chromium's net error, and
for a failed tunnel what the device's proxy answers for the host. A navigation with no page within
30 s is stopped, so the next snapshot and tab list answer at once; the tab list runs beside the
actions, and a reply's title and verification check are bounded. A 204 answer says so. After a
fresh browser install the plugin waits for the old daemon to exit before starting the new one,
within the same tool call.
