---
"@capybara-hq/plugin-browser": patch
---

One Chromium download per machine and revision (#311): the daemon's service files carry
`capybara-install-key` (the Chromium revisions), which a capybara-device with the machine-wide
install cache keys the browser install by, so a plugin upgrade that keeps the revisions and the
other devices of the same deployment reuse the sealed browser. While the first start still
installs, a browser call answers within seconds with the download's progress ("The browser is
being installed in the device (120 of 180 MB downloaded) …") instead of a 90 s service timeout.
