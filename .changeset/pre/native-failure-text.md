---
"@capybara-hq/plugin-device-docker": patch
"@capybara-hq/plugin-device-e2b": patch
---

A failed native file operation names its cause (capybara-hq/core#907): the native helper's error
code is mapped with the SDK's `nativeFailureText` (`ENOENT`, `ENOTDIR`, `ENOSPC`, …) instead of
"Native operation failed (CODE)". Needs `@capybara-hq/plugin-sdk` 0.1.0-rc.78.
