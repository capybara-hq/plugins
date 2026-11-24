---
"@capybara-hq/plugin-device-docker": patch
"@capybara-hq/plugin-device-e2b": patch
---

Device services and streams (browser use): `ensureService`, `stopService`, `serviceStatus`, `serviceRequest` and `openStream`. A service is one long-lived Node process per device and name, started detached as the sandbox user with its state directory under `/var/lib/capybara/svc/<name>`, outside the workspace (Docker: the device's new `<name>-svc` volume, kept and removed with its files; E2B: the VM's disk), files written without following links, and the instance's network (Docker: the egress proxy variables). Requests and streams go through an inline socket relay, so every existing instance can use them; unread stream messages are bounded.

Service files go digest first: a restart of an unchanged service moves no file bytes. Services get `CAPYBARA_SERVICE_WORKSPACE` (the device's workspace root).

Docker: with `volumeDriver` the `<name>-svc` volume is sized `min(diskMb, 2048)` MB, a stale one left from a lost file system is removed when the file system is made anew, and the service state and run directories are refused as operation roots. A stream's reader that stops reading closes it.
