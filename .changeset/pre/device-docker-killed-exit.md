---
"@capybara-hq/plugin-device-docker": patch
---

A command ended by a revocation, `killTagged` or a takeover now always reads as killed: the forced pass stops every matching exec before killing any, so the outer `setsid -w` can no longer report its child's SIGKILL as an ordinary exit code 9
