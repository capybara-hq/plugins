---
"@capybara-hq/plugin-device-e2b": patch
"@capybara-hq/plugin-device-docker": patch
---

Kill a command's leftover processes at the in-sandbox deadline also where `timeout` is uutils
(Ubuntu 26.04's default coreutils), which kills only its direct child.
