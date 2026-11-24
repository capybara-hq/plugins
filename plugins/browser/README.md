# @capybara-hq/plugin-browser

A real browser in the person's device for agents (browser use spec,
`docs/superpowers/specs/2026-11-23-browser-use-design.md` in capybara-hq/core).

- `daemon/`: the browser daemon, a device service (`CAPYBARA_SERVICE_SOCKET`,
  `CAPYBARA_SERVICE_STATE`) that drives a headless Chromium with a persistent profile over a
  CDP pipe, answers tool requests and serves live-view streams. `daemon/protocol.ts` is the
  message contract shared with the panel and the server.
- `pnpm --filter @capybara-hq/plugin-browser build:daemon` writes `dist/service/`: `daemon.mjs`
  (the daemon bundled into one file) and `vendor/playwright-core/` (playwright-core cannot be
  bundled: it forks its own browser download entry and reads files next to itself). Every file
  under `dist/service/` is a service file; the entry is `daemon.mjs`.
