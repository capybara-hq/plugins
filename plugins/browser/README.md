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
  then raises an `InputRequired` question `{ done: boolean }` in the conversation (a boolean, not
  a 完成 / 取消 enum: the kernel's `answerHandoff`, which the banner uses, answers `{ done }`); on
  resume it clears the notice (with Done also handing the browser back, so a takeover the person
  still holds ends) and returns the page snapshot, or fails with "The user cancelled the handoff;
  ask the user how to continue, or try another approach.".
- `browser_screenshot` asks for at most 2 MiB and retries once at half that when the reply did
  not fit in one service message. A refused host's error ends with one next step (the user is
  asked to allow it); a service start that fails has its own text.
- Panel routes: `GET /ui/browser` (the page) and `GET /ui/panel.js` are public; `POST
  /ui/stream-ticket`, `/ui/network-hosts` and `/ui/handoff-answer` are `embed` routes that take
  the org, account and conversation from the caller only (a platform-scope token or one without a
  conversation gets 403). The panel never starts the service: a ticket is minted either way, and a
  stopped service closes the viewer with 4404 (the panel's "not running" state).

## The daemon (`daemon/`)

- Chromium starts on the daemon's first start. A launch that fails (no download, a refused
  network) does not stop the daemon: every request answers the cause and launches again. When the
  device's proxy refuses Playwright's download hosts (`cdn.playwright.dev`,
  `playwright.download.prss.microsoft.com`, or `PLAYWRIGHT_DOWNLOAD_HOST`), the reply lists them
  as blocked hosts, so the person is asked to allow them. A `PLAYWRIGHT_BROWSERS_PATH` in the
  device's environment that already holds this build's headless shell revision is used as is
  (a read-only image cache); otherwise the browser is installed into `<state>/browsers`.
- The daemon stops after 15 minutes without requests and viewers. A pending handoff keeps it
  running for up to 24 hours after its notice (the person may take a while to sign in); the
  device's own idle suspension can still stop it sooner, and then the question stays open in the
  conversation without its banner until the browser runs again.
- `<state>/session.json` keeps the open tabs' URLs and the pending handoff. A daemon started within
  10 minutes of the last write (a provider that restarts the service for a network change, see
  device-local) reopens them; an idle stop removes the file. The profile keeps cookies and storage
  on its own.
- A `handoff_clear` with `handback` (the person answered Done) also ends a takeover. Dropping a
  handoff on the next agent request is device-wide: every conversation of the device is the
  owner's.

## The panel (`ui-src/panel/`)

- Every viewer is the owner's: any non-compact panel is interactive (keys, pointer, Esc) while the
  person holds control, whichever panel took it, and asks for full-viewport frames then. Nothing
  is kept in storage (the sandboxed iframe has none); a remount rebuilds from the daemon's first
  state. Take over is offered only in the live view; handing back with a pending handoff answers
  it Done.
- 允许 allows the blocked host, then opens the blocked page (the blocked navigation, or the page
  whose resource was refused), again on the next connection if the browser restarted. A 4404 is
  retried twice (1 s, 3 s) before "not running", which looks for the browser every 10 s while
  visible, for 30 minutes at most (a ticket never starts the service). A refused allow or answer
  shows the kernel's reason.
- A dialog strip hides after 10 s or when the page changes; agent clicks flash once each; a lock
  shows a secure page. The panel listens only to messages from its host page.
