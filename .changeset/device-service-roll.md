---
"@capybara-hq/plugin-device-docker": patch
"@capybara-hq/plugin-device-e2b": patch
"@capybara-hq/plugin-browser": patch
---

Device services roll onto an upgraded plugin's files on device-docker and device-e2b as on local
devices: the service manager records the digest of the files a service started from, reports it as
`filesDigest` (`sha256:…`, the SDK's digest), keeps a running service on the same files and, on
other files, stops it once the new files are there or were sent and checked, then starts it on
them. The browser daemon answers the kernel's roll check (capybara-hq/core#879) busy while the
person holds control or a handoff waits, so a roll waits for a later call.
