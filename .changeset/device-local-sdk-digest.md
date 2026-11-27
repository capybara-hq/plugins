---
"@capybara-hq/plugin-device-local": patch
---

Device service file digests are computed with the SDK's `deviceServiceFilesDigest` instead of the
package's own copy of the algorithm (the same bytes, so no running service restarts or rolls).
