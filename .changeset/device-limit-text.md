---
"@capybara-hq/plugin-device-local": patch
"@capybara-hq/plugin-device-docker": patch
"@capybara-hq/plugin-device-e2b": patch
---

Device report limit values are English and Chinese text (`DeviceReportLimit.value` is
`DeviceText` in `@capybara-hq/plugin-sdk`): device-local's limit lines read in the UI language
and its shared directories line counts the rest as "+N more" / "；另有 N 个"; device-docker's sizes
carry English only. device-e2b reports no limit lines and is released against the same SDK.

These plugins need a kernel whose `@capybara-hq/plugin-sdk` carries `DeviceText` limit values
(the release of core#707): an older kernel refuses their reports (string values expected), and an
older plugin's report is refused by the newer kernel.
