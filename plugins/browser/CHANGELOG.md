# @capybara-hq/plugin-browser

## 0.1.0-rc.2

### Patch Changes

- 0933206: The browser daemon no longer launches a headless shell another process on the device is still
  installing into the same directory (it waits for Playwright's install marker and lock instead of
  starting half-written files), and reinstalls one whose executable went missing. A daemon stop never
  hangs on the browser: a Chromium that has not closed within 3 s is killed (the stop returns within
  about 6 s) rather than waited for until Playwright's 180 s timeout, and a launch or install still running at the stop is abandoned
  (it only closes when it finishes; an unfinished install has no marker, so the next start installs
  again).

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
