---
"@capybara-hq/plugin-device-e2b": patch
"@capybara-hq/plugin-device-docker": patch
---

A new E2B device starts device services (the browser): the shared service manager answered the kernel's first `ifRunning`
ensure with "this device's image predates isolated device services" because an E2B VM's /run is a fresh tmpfs, so the run root
the provider makes before a start did not exist yet. An `ifRunning` ensure now only reads and answers stopped there.
