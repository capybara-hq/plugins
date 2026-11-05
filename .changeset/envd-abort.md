---
"@capybara-hq/plugin-sandbox-e2b": patch
---

A stopped or timed-out command's process stream now ends at once. An abort of the request alone sometimes left a body that was already being read untouched under load, so a command that had to be recovered by a reboot waited until its last process closed the output.
