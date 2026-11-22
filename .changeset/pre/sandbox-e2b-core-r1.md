---
"@capybara-hq/plugin-device-e2b": patch
---

Moves to core R1 (`@capybara-hq/plugin-sdk` 0.1.0-rc.31, `@capybara-hq/testing` 0.1.0-rc.24); the
VM stages the new SDK runtime files on first use. The provider still ships Full access only, a known
limitation accepted by the maintainers: the tested template's kernel has Landlock ABI 2, below the
launcher's ABI 6, so restricted profiles are reported unavailable and refused before any effect;
the README says so.
