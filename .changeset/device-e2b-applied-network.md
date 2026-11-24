---
"@capybara-hq/plugin-device-e2b": patch
---

Implements the optional `DeviceProvider.appliedNetwork` (device-provider@1, plugin-sdk rc.67): a
pure read of the network the VM records (`GET /sandboxes/{id}`), never connecting, resuming or
re-applying anything. No network reads as an empty allowlist; an unrecognized policy (an earlier
version's open-public deny list) reads as null, so the kernel applies the desired limits again
through `update`. This narrows a stale holder's late network update, which the plugin cannot
fence, at the next lifecycle step (core#766). Needs `@capybara-hq/plugin-sdk` 0.1.0-rc.67.
