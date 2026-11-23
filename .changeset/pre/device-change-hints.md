---
"@capybara-hq/plugin-device-local": patch
"@capybara-hq/plugin-device-docker": patch
"@capybara-hq/plugin-device-e2b": patch
---

Device reports say how to change the device's limits (`changeHint`): device-local names the
computer's owner and the `capybara-device ceiling set -c <device id> …` command on that computer;
device-docker and device-e2b name the super admin's settings and the device's network setting.
device-local's permission support names the owner (`limitedBy`) for a crossing the owner's
ceiling keeps closed, so refusals name the owner's limit instead of the provider's, and its
description says the owner keeps every call in the sandbox instead of "never runs outside".
