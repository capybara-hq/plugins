---
"@capybara-hq/plugin-device-docker": minor
---

Renamed from `@capybara-hq/plugin-sandbox-docker` (no alias; the version continues, so the image tags
never collide, and the image names stay). BREAKING: provides `device-provider@1` (needs
`@capybara-hq/plugin-sdk` `^0.1.0-rc.51` and a kernel that knows the point) instead of `sandbox@2`.
Adds the device report (a description of the container, the cpu / memory / disk it was created with,
files reset), the static `networkAllowlist` declaration, operation scopes with `projectRoot` and
`writeRoots` (no read roots), and a short `device-connection` setup guide in English and Chinese.
