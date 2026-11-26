---
"@capybara-hq/plugin-browser": patch
---

A navigation that fails at the connection level (`ERR_TIMED_OUT`, `ERR_CONNECTION_*`,
`ERR_NAME_NOT_RESOLVED`, a failed tunnel, ...) now asks the device's proxy about the host, as a
failed tunnel did: blocked by the network settings, could not connect, or no page in time. When
the proxy itself cannot be reached (`ERR_PROXY_CONNECTION_FAILED`, the device's network down or
being set up), the result says so as `network_unavailable`, not an address problem, with its own
next step.
