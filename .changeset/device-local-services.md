---
"@capybara-hq/plugin-device-local": patch
---

Serve device services and streams: `ensureService`, `stopService`, `serviceStatus`, `serviceRequest` and `openStream` forward to the connected machine over the dial-in channel. A status keeps the machine's `codeDir`; an `ifRunning` ensure sends only the service name and is never retried with files; files are encoded only when the machine asks for them and refused with an actionable error when they exceed the connection's frame capacity.
