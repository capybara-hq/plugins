---
"@capybara-hq/plugin-device-e2b": minor
---

Renamed from `@capybara-hq/plugin-sandbox-e2b` (no alias; the version continues with device-docker's,
one fixed group). BREAKING: provides `device-provider@1` (needs `@capybara-hq/plugin-sdk`
`^0.1.0-rc.51` and a kernel that knows the point) instead of `sandbox@2`. Adds the device report (a
description of the microVM naming the metadata-service residual, files reset), the static
`networkAllowlist` declaration (also under `domainAllowlist: false`, which degrades to no network),
operation scopes with `projectRoot` and `writeRoots` (no read roots), and a short
`device-connection` setup guide in English and Chinese.
