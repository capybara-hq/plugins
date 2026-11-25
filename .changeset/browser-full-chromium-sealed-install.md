---
"@capybara-hq/plugin-browser": patch
---

The browser runs the full Chromium in its new headless mode on Linux devices and presents as an ordinary Chrome (Chrome's reduced
user agent, no "HeadlessChrome"; its own client hints; a window the size of the viewport); macOS keeps the headless shell, which
the local sandbox allows. It never runs a browser from a place it or an agent command could write (plugins#209): the image's
read-only pinned browser (any revision shipped there), or on device-local the provider's install directory, installed afresh and
sealed on the first start (the daemon then restarts within the same tool call); without either it refuses to start and says
how to get one. Uploads are read by the daemon and handed over from memory, and downloads written only into exclusively created,
checked files, so links planted in the workspace never reach the browser's profile. Verification pages (CAPTCHAs, bot checks) are recognised: tool results tell the
agent to hand off, and the viewer's tab state carries `blocker: { kind: "verification", url }` for the panel.
