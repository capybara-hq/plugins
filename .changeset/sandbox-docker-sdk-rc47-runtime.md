---
"@capybara-hq/plugin-sandbox-docker": patch
---

The sandbox image stages the plugin-sdk 0.1.0-rc.47 runtime: `native-files.py` (single-file read
roots) and a regenerated `SHA256SUMS`, so a device on a kernel with SDK rc.47 no longer refuses with
"The staged native-files.py does not match its digest". The extension now requires
`^0.1.0-rc.47`.
