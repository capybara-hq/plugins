---
"@capybara-hq/plugin-browser": minor
---

Loopback port grants: a page on `localhost`, `127.0.0.1` or `[::1]` that the device keeps closed
is reported with its port and the `loopback` class (and to the panel as a loopback blocked event),
so the kernel can ask for the port. Every request carries the conversation tree's live ports, and
the daemon lets a tab reach a loopback port only while its own tree holds it, even when the device
opened the port for another conversation. Loopback now goes through the device's proxy in the
proxy flag form as well (Playwright's rule for its proxy option).
