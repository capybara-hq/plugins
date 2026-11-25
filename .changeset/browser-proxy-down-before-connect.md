---
"@capybara-hq/plugin-browser": patch
---

"The device's network proxy is not reachable" is said only when the connection to the proxy could
not be made (refused, unreachable, unresolved); a proxy that took the connection and then reset it
is no longer reported as down.
