---
"@capybara-hq/plugin-device-docker": patch
"@capybara-hq/plugin-device-e2b": patch
---

Device services and streams (browser use): `ensureService`, `stopService`, `serviceStatus`, `serviceRequest` and `openStream`. A service is one long-lived Node process per device and name, started detached as the sandbox user with its state directory under `/workspace/.capybara/svc/<name>` (files written without following links) and the instance's network (Docker: the egress proxy variables). Requests and streams go through the socket relay (`capybara-socket-relay`, new in the sandbox image; inline on E2B).
