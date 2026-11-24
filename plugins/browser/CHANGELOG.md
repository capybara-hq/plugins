# @capybara-hq/plugin-browser

## 0.1.0-rc.1

### Minor Changes

- 5dd3cb9: New plugin: a real browser in the conversation owner's device for agents (browser use spec, needs
  `@capybara-hq/plugin-sdk` `^0.1.0-rc.69` for `ctx.deviceAccess`). Fifteen `browser_*` tools drive
  the daemon service (`permissions.deviceAccess` `browser`); acting tools ask, reading and navigating
  tools are allowed. `browser_handoff` hands the browser to the person through a question card and the
  panel's banner; Done also hands back a takeover. The `conversation.panel` embed shows the live view
  with takeover. The daemon keeps running when Chromium cannot start (retried on use, refused download
  hosts reported), stays up for a pending handoff, and reopens its tabs after a quick restart.

### Patch Changes

- 3828fe8: A download cancelled at the size cap no longer counts toward the cap of the downloads that follow while
  its leftover file waits for removal, so a small download right after a cancelled big one is kept.
