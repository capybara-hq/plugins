---
"@capybara-hq/plugin-browser": patch
---

The browser panel derives its full mode from the host's `panel-mode` message (sent after `init`
and on every change) instead of from its own ask, so it leaves the full layout and resumes `resize`
when the host leaves full mode on its own (its close control or Esc, a phone). `browser_handoff`
opens the browser panel on the person's conversation page (`InputRequired.open`). The panel follows
the approved browser panel design: one box, host theme tokens, a single skeleton until the first
frame, a contained picture with an accent ring while in control, take over at every width (a
narrow form with a tabs button and a "more" menu), and a verify strip driven by
the active tab's `blocker` (kind `verification`). The panel no longer posts `resize` (the host fills the panel). Needs the
plugin-sdk and kernel release that adds `panel-mode` to the embed bridge and `InputRequired.open`.
