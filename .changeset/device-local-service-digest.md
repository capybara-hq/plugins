---
"@capybara-hq/plugin-device-local": patch
---

A service's status passes on the machine's `filesDigest` (the files a running service was started
from), so a kernel with capybara-hq/core#875 restarts a service whose extension was upgraded.
Harmless with an older kernel or capybara-device (the field is ignored or absent).
