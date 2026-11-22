---
"@capybara-hq/plugin-device-e2b": minor
---

Implements the optional `list` and `scan` calls of `sandbox@2` (plugin SDK 0.1.0-rc.24), so cloud
devices on E2B offer projects: the same `python3 -I` script as the Docker plugin runs in the
sandbox as the sandbox user, with `/workspace` as the whole reachable area in either mode. A
template without python3 gets a clear error. Requires `@capybara-hq/plugin-sdk@^0.1.0-rc.24`.
