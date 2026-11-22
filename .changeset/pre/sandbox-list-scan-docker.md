---
"@capybara-hq/plugin-device-docker": minor
---

Implements the optional `list` and `scan` calls of `sandbox@2` (plugin SDK 0.1.0-rc.24), so cloud
devices on Docker offer projects: a `python3 -I` script run in the container as the sandbox user
lists one directory or finds project-like directories (`.git` or `AGENTS.md`), with the
container's `/workspace` as the whole reachable area in either mode. Requires
`@capybara-hq/plugin-sdk@^0.1.0-rc.24`.
