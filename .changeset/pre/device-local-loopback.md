---
"@capybara-hq/plugin-device-local": minor
---

Loopback port grants: a machine whose capybara-device announces the `loopbackPorts` hello feature
(macOS, OS mode) reports `network.loopbackPorts` in its permission support while a call may run
outside the sandbox there, and receives the granted ports in `service.ensure`. An OS-mode macOS
machine on an older capybara-device reports `limitedBy.loopbackPorts: "device-update"`; other
machines never get the key and behave as before.
