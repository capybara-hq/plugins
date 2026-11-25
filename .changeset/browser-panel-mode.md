---
"@capybara-hq/plugin-browser": patch
---

The browser panel follows the approved browser panel design:
- One box, using the host's theme tokens.
- A single skeleton until the first frame.
- A contained, centred picture with an accent ring while the person is in control.
- A fixed-height status line.
- Take over at every width, with a narrow form that has a tabs button and a "more" menu.
- A verify strip, driven by the active tab's `blocker` (kind `verification`).

The panel's full-mode layout now follows only the host's `panel-mode` message, and it no longer
posts `resize` (the host fills the panel). `browser_handoff` opens the browser panel on the person's
conversation page (`InputRequired.open`). Needs core v0.1.0-rc.115 (plugin-sdk rc.72, kernel rc.90).
