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
- `pnpm --filter @capybara-hq/plugin-browser build:ui` (run by the repository's `pnpm build:ui`
  before pack, marketplace and release) writes `ui/`, the plugin-root directory the packer ships
  as is (`dist/` is replaced by the extension bundle): `ui/service/` (the daemon's service files,
  as `build:daemon`) and `ui/panel.js` (the panel, `ui-src/panel/entry.ts` bundled as an iife).

## The extension (`src/`)

- Tools (`plugin__browser__<name>`): `browser_navigate`, `browser_tabs`, `browser_snapshot`,
  `browser_screenshot`, `browser_wait` and `browser_handoff` declare `defaultPolicy: "allow"`;
  `browser_click`, `browser_type`, `browser_select`, `browser_press`, `browser_scroll`,
  `browser_hover`, `browser_upload`, `browser_click_at` and `browser_type_at` declare `ask`.
  Each call runs only for the conversation's owner, starts the `browser` service through
  `ctx.deviceAccess.ensureService` (files: every file under `ui/service/`, read once per
  extension instance), sends one `ToolRequest` and reports the hosts the device refused with
  `reportBlockedHosts` (the kernel raises the network ask and reruns the call once allowed).
- `browser_handoff` sends the daemon a handoff notice (the panels show a banner with 完成 / 取消),
  then raises an `InputRequired` question `{ done: boolean }` in the conversation; on resume it
  clears the notice and returns the page snapshot, or fails with "The user cancelled the
  handoff.".
- Panel routes: `GET /ui/browser` (the page) and `GET /ui/panel.js` are public; `POST
  /ui/stream-ticket`, `/ui/network-hosts` and `/ui/handoff-answer` are `embed` routes that take
  the org, account and conversation from the caller only (a platform-scope token or one without a
  conversation gets 403). The panel never starts the service: a ticket is minted either way, and a
  stopped service closes the viewer with 4404 (the panel's "not running" state).
