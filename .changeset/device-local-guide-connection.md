---
"@capybara-hq/plugin-device-local": patch
---

The connect guide's step 3 names the device: `capybara-device service install -c <device id>`
(the command `login` prints; it also starts the service) instead of a bare `service install` and
`service start`, which fail once the computer has a second connection. The `ceiling` commands in
the guide carry `-c <device id>` too.

The guide is the terminal steps only: the desktop app no longer connects local devices, so the
`connect-this-machine` shell action and the sentences about the app are gone.
