---
"@capybara-hq/plugin-device-docker": patch
"@capybara-hq/plugin-device-e2b": patch
"@capybara-hq/plugin-device-local": patch
---

Device services run as their own user (plugins#210): device-docker and device-e2b start the service manager, every service and
the socket relay as `capybara-svc` (uid 1100), with its state under `/var/lib/capybara/svc` and its sockets under
`/run/capybara-svc`, both private to that user, so agent commands (the sandbox user) can neither read a browser profile nor reach a
service's socket or process. Services are keyed by their id `<extension>.<name>` (core#817). The sandbox image ships the browser
plugin's pinned Chromium (full build) read only in `/opt/capybara-browsers` (plugins#209); device-docker moves service state to a
new `<name>-services` volume and removes the old `-svc` one; device-e2b prepares the user on VMs from older templates.
device-docker recreates (answers `gone` on resume for) instances made before isolated services; device-e2b kills the old services
on VMs from older templates; device-local answers a machine older than service ids with "update capybara-device".
