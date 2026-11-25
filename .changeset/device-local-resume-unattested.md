---
"@capybara-hq/plugin-device-local": patch
---

`resume` answers `gone` at once, without any machine round trip, when the machine's hello did not
attest the instance's binding: its program restarted unbound, typically after an upgrade to
another runtime. The kernel then recreates the instance right away instead of first sending the
machine a `create` and a `bindInstance` that can only end in `gone`.
