---
"@capybara-hq/plugin-browser": patch
---

device-local runs the full Chromium build too where its capybara-device sets `CAPYBARA_SERVICE_MACH=chromium` (an older one keeps
the headless shell) (new headless mode, an ordinary Chrome), installed into the sealed install
directory as before: the local sandbox now lets the browser service register Chromium's own Mach services (capybara-hq/core#843).
On macOS the browser gets `MAC_CHROMIUM_TMPDIR` (its temporary directory) and runs with crash reporting off.
