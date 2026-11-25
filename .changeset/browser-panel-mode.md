---
"@capybara-hq/plugin-browser": patch
---

The browser panel derives its full mode from the host's `panel-mode` message (sent after `init`
and on every change) instead of from its own ask, so it leaves the full layout and resumes `resize`
when the host leaves full mode on its own (its close control or Esc, a phone). `browser_handoff`
opens the browser panel on the person's conversation page (`InputRequired.open`). Needs the
plugin-sdk and kernel release that adds `panel-mode` to the embed bridge and `InputRequired.open`.
