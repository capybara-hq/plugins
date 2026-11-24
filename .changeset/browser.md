---
"@capybara-hq/plugin-browser": minor
---

New plugin: a real browser in the conversation owner's device for agents (browser use spec, needs
`@capybara-hq/plugin-sdk` `^0.1.0-rc.69` for `ctx.deviceAccess`). Fifteen `browser_*` tools drive
the daemon service (`permissions.deviceAccess` `browser`); acting tools ask, reading and navigating
tools are allowed. `browser_handoff` hands the browser to the person through a question card and the
panel's banner. The `conversation.panel` embed shows the live view with takeover.
