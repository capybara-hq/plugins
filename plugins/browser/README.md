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
  then raises an `InputRequired` question `{ done: boolean }` in the conversation, with `open`
  naming the `browser` panel so the person's conversation page opens it. The question's title is
  请在浏览器中完成：<the reason's first sentence> / Finish in the browser: …, the body is the full
  reason, and `choices` draw 完成 (true, primary) and 取消 (false) as buttons. It stays a boolean
  because the kernel's `answerHandoff`, which the banner uses, answers `{ done }`. On
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

- Chromium starts on the daemon's first start. On Linux devices (device-docker, device-e2b) it is
  the full Chromium build in its new headless mode, so the browser presents as an ordinary Chrome:
  Chrome's own reduced user agent for the platform (`--user-agent`, never "HeadlessChrome"), the
  browser's own client hints, a window the size of the viewport, the device's locale and time zone.
  On macOS (device-local) too where the machine's capybara-device says its sandbox allows it
  (`CAPYBARA_SERVICE_MACH=chromium`, capybara-hq/core#843); the browser gets `MAC_CHROMIUM_TMPDIR`
  and crash reporting off. An older capybara-device keeps the headless shell in one process (and
  nothing larger is downloaded). First start there: one download into the install directory (about 377 MB, 16 s on a fast
  link), one restart, then about 2 s to launch. Nothing spoofs a fingerprint, solves a CAPTCHA or
  hides automation beyond Playwright's own flags (`navigator.webdriver` stays true).
- Where the browser comes from (plugins#209: never from a place the service or an agent command
  could write once it runs): the provider's install directory `CAPYBARA_SERVICE_INSTALL`
  (device-local) is filled on the first start, sealed with `.sealed`, and the daemon answers
  `restart` and exits, so every later start runs it read only (the plugin starts the service again
  within the same tool call, waiting while `ensureService` still reports the exiting process's
  start time, for at most 30 s; an unsealed directory is always installed afresh, never trusted as
  found); else a `PLAYWRIGHT_BROWSERS_PATH` the daemon cannot write, outside the workspace
  (device-docker / device-e2b ship it in `/opt/capybara-browsers`, pinned to this package's
  playwright-core): this build's revision, else the newest revision of the build there. Nothing
  else: without such a place the browser does not start and says how to get one (update
  capybara-device; recreate a cloud device on the current image). It never installs where it
  could rewrite the browser itself.
- Uploads are read by the daemon (opened without following a final link, accepted only when the
  resolved path lies in the workspace and names the very file opened) and handed to Chromium from
  memory, at most 50 MiB; downloads are copied from Playwright's private file into an exclusively
  created file in `<workspace>/downloads`, checked to be that directory's own before any byte is
  written. So a link the agent plants in the workspace never makes the service read or write its
  own profile.
- The network: Chromium sends everything, loopback included, through the device's proxy
  (`HTTPS_PROXY` / `HTTP_PROXY` of the service, the same proxy and rules as the device's commands:
  the proxy resolves the name, with the fake-IP DNS fallback, and judges the address). A proxy URL
  with credentials goes to Playwright's `proxy` option, which answers the challenge by
  intercepting requests; under that interception Chromium loses a request it restarts for an
  ACCEPT_CH frame (www.google.com sends one), so the daemon disables `AcceptCHFrame` (its
  `--disable-features` repeats Playwright's own list: Chromium takes only the last flag), and
  `--disable-auto-reload` keeps a network error page from reloading itself (that reload aborted
  the agent's next navigation in the tab).
- A navigation that fails says why (`unreachable`): Chromium's net error with its meaning, and
  for a failed tunnel what the device's proxy answers for the host (refused by the network
  settings: `blocked`; could not connect: the name did not resolve, or the host refused or did not
  answer). A navigation with no page within 30 s is stopped (CDP `Page.stopLoading`: one left in
  flight keeps the page's queries waiting), so the tab shows its previous page and the next
  request works on it. A 204 / 205 answer says so. The tab list runs beside the actions, and a
  reply's title and verification check are bounded (2 s), so neither waits on a hanging page.
- A launch that fails (no download, a refused network) does not stop the daemon: every request
  answers the cause and launches again. When the device's proxy refuses Playwright's download
  hosts (`cdn.playwright.dev`, `playwright.download.prss.microsoft.com`, `storage.googleapis.com`
  where the CDN redirects the download, or `PLAYWRIGHT_DOWNLOAD_HOST`), the reply lists them as
  blocked hosts, so the person is asked to allow them.
- Verification pages (bot checks, CAPTCHAs: recognised by URL, title, a visible CAPTCHA widget,
  or a 418 / 429 document): every tool result while one shows starts with a note telling the agent
  to call `browser_handoff` instead of solving it or switching sites, and the viewer's tab state
  carries `blocker: { kind: "verification", url }` on that tab (cleared when its page changes) for
  the panel's "需要你完成验证" strip.
- The daemon stops after 15 minutes without requests and viewers. A pending handoff keeps it
  running for up to 24 hours after its notice (the person may take a while to sign in); the
  device's own idle suspension can still stop it sooner, and then the question stays open in the
  conversation without its banner until the browser runs again.
- `<state>/session.json` keeps the open tabs' URLs and the pending handoff. A daemon started within
  10 minutes of the last write (a provider that restarts the service for a network change, see
  device-local) reopens them; an idle stop removes the file. The profile keeps cookies and storage
  on its own.
- `<state>/cookies.json` holds the persistent cookies from the moment a stop begins until the next
  start has merged the ones the profile lacks (then it is removed, so a logout while the browser
  ran is never undone by an old file). It exists because the service's kill (2 s after SIGTERM)
  can land while a loaded Chromium is still writing its Cookies file. It lives in the service
  state directory, outside every workspace and project (core `packages/device`), mode 0600, and
  holds what Chromium's own `profile/Default/Cookies` holds there. That file is not protected
  either: the daemon runs Chromium with `--use-mock-keychain`, so its values are only obfuscated
  with a key every Chromium shares (observed: `encrypted_value` of 51 bytes, readable by anyone
  who can read the directory). The JSON therefore adds no exposure.
- A `handoff_clear` with `handback` (the person answered Done) also ends a takeover. Dropping a
  handoff on the next agent request is device-wide: every conversation of the device is the
  owner's.
- Viewer input (mouse, keys, text, address bar, tabs) is applied only while the person holds
  control: a viewer in the watch state is read-only and its input is dropped on arrival, and input
  still queued when control returns to the agent is dropped too (input already running, a navigation
  or a long paste, finishes). Keys and buttons the person still holds are released when control
  returns to the agent or the viewer ends, each on the tab where it was pressed (a held button after
  moving the pointer outside the viewport, so the release completes no click), so the agent never
  inherits a held Shift or a drag. Mouse moves are coalesced (the newest position wins while one
  waits). After a move, click or scroll the daemon answers the page's cursor under the pointer
  (`cursor`, only when it changed), off the input queue (the newest position wins, one lookup at a
  time, an answer later than 200 ms is dropped) and without page code: CDP hit-tests the point
  (`DOM.getNodeForLocation`, through shadow roots and in-process frames) and a function in an
  isolated world reads the computed `cursor`, resolving `auto` as Chromium does (an I-beam over
  editable fields and text); `pointer-events: none` elements are skipped as Chromium does;
  out-of-process frames are entered through their own session (at most 20 frames looked at, 3
  levels, matched in the page's coordinates), detached with their frame or when the viewer leaves
  the page.
- Frames are binary messages (`encodeFrame`: tag, seq, width, height, JPEG); every other message is
  JSON. Pacing (`daemon/viewer-pacing.ts`): the daemon pings each viewer every second (the path's
  own round trip) and compares each frame's ack round trip with it. While frames take longer than
  120 ms over it (a click would wait that long behind them on the slowest hop), it lowers the JPEG
  quality (60, 45, 35, 25) and then the scale (down to half), allows only one frame in flight, and
  steps back up after six quick frames. At most 15 frames per second; only the newest frame waits
  (a stale one is replaced), and Chromium encodes the next frame at most every 500 ms while one
  waits. JSON messages (state, cursor, pings, dialogs) never wait behind a held frame.

## The panel (`ui-src/panel/`)

- Every viewer is the owner's: any non-compact panel is interactive (keys, pointer, Esc) while the
  person holds control, whichever panel took it, and may ask for frames up to the full viewport
  then. In the watch state the panel is read-only (no pointer, keys, address bar, tabs or
  navigation; the cursor is the arrow). Nothing is kept in storage (the sandboxed iframe has none);
  a remount rebuilds from the daemon's first state. Take over is offered only in the live view;
  handing back with a pending handoff answers it Done.
- Takeover input (`ui-src/panel/input.ts`): button and wheel events at once, moves coalesced to the
  newest position at most every 33 ms (hover effects, menus and tooltips render in the stream), a
  drag reported until the button is released wherever that happens; the page's cursor from the
  daemon on the picture (known keywords only); a press indicator at the pointer from mousedown until
  the first frame after the release (1 s at most). A visually hidden textarea holds the focus while
  driving: keys go as `down` / `up` (Esc hands back), IME composition (Chinese input) as one `char`
  at `compositionend`, paste as `char` with the clipboard text (Cmd/Ctrl+V itself is not sent;
  text is cut at 10 000 code points). Losing the window or the focus sends `up` for held keys and
  the held button; the sink gives up the focus when control returns to the agent.
- Frame size: the picture's CSS box times the device pixel ratio capped at 1.25, within 640 px wide
  in the side view and the full viewport while the person drives; the daemon may send smaller
  frames on a slow link (see the pacing above).
- 允许 allows the blocked host; while the person drives it then opens the blocked page (the blocked
  navigation, or the page whose resource was refused), again on the next connection if the browser
  restarted, taking over again first (a restarted daemon starts with the agent in control); a hand
  back cancels that reopen. A 4404 after a live view (a restart) is retried twice (1 s, 3 s)
  before "not running"; one before any
  live view is "not running" at once. "Not running" looks for the browser quietly (it stays up
  until the browser answers) every 10 s while visible, for 30 minutes at most (a ticket never
  starts the service). A refused allow or answer shows the kernel's reason.
- Look (browser panel design 2026-11-25): the host's panel is the one box. The tab strip, toolbar,
  status line and picture are separated by space and ground, not borders. Colours come from the
  host's `--cb-*` tokens (light and dark). Until the browser's state and its first frame are there,
  the whole panel is one skeleton and nothing else; then it switches once to the live panel. "Not
  running", offline and error show at once as the centred idle state alone (no tabs, toolbar or
  status line: nothing to navigate); a browser that comes up switches once to the live panel on
  its first frame. The picture is contained and centred on a neutral ground
  (soft shadow; a 2 px accent ring while the person is in control). The status line has a fixed
  height. Take over is there at every width: below 440 px the tabs and the address merge into one
  button with a tab count, and forward and reload move into a "more" menu. On a phone (a screen
  under 600 px, the host's compact class) the panel only watches. A page that asks for a human check
  (the active tab's `blocker` of kind `verification`, reported by the daemon) shows a warn strip with 去验证 as the one primary
  action.
- Size: the host fills its panel with the embed in both panel modes. The page posts no `resize`,
  and the viewer's frame size follows the shown size. The page asks for full mode with `panel-mode`
  on take over, and for the side panel on hand back (here, or when control returns to the agent
  elsewhere). Its layout follows only the host's `panel-mode` (sent after `init` and on every
  change). The host keeps the frame mounted across the switch, so the viewer connection survives it.
- A dialog strip hides after 10 s or when the page changes; agent clicks flash once each; a lock
  shows a secure page. The panel listens only to messages from its host page.
