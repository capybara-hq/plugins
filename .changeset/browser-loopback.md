---
"@capybara-hq/plugin-browser": minor
---

Loopback port grants: a page on `localhost`, `127.0.0.1` or `[::1]` that the device keeps closed
is reported with its port and the `loopback` class, so the kernel asks for the port and reruns the
call once it is granted (the manifest declares `permissions.deviceAccess.loopbackPorts`, which
needs the super admin's approval on upgrade). Every daemon request carries the conversation tree's
live ports, and the daemon lets a tab reach a loopback port only while its own tree holds it, even
when the device opened the port for another conversation. The panel shows "本机端口 3999 未开放"
with 允许本会话访问 (the person's own grant, then the page opens again) and lists the conversation's
open local ports with 移除. Loopback now goes through the device's proxy in the proxy flag form as
well (Playwright's rule for its proxy option).
