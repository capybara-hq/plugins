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
  `browser_hover`, `browser_upload`, `browser_click_at`, `browser_type_at` and `browser_dialog`
  declare `ask`.
  Each call runs only for the conversation's owner, starts the `browser` service through
  `ctx.deviceAccess.ensureService` (files: every file under `ui/service/`, read once per
  extension instance), sends one `ToolRequest` and reports the hosts the device refused with
  `reportBlockedHosts` (the kernel raises the network ask and reruns the call once allowed).
  Every request carries the call's `conversationId` and `rootConversationId` from the kernel's
  tool call context (written after the operation, never from tool input), and `loopbackPorts`:
  the root's live loopback port grants (`ctx.deviceAccess.loopbackPorts`, read for every request;
  empty while the tree is unattended or when the read fails). A refused `localhost`, `127.0.0.1`
  or `[::1]` is reported with its port and `class: "loopback"` (`service: "browser"`), so the
  kernel asks for the port and reruns the call once it is granted
  (`permissions.deviceAccess.loopbackPorts`). A result names the
  conversation's active tab, or says "This conversation has no browser tab yet.", and every result
  the daemon answered, ok or error, ends with "Tabs open in this conversation: N of 6.".
- `browser_handoff` sends the daemon a handoff notice (the panels show a banner with 完成 / 取消),
  then raises an `InputRequired` question `{ done: boolean }` in the conversation, with `open`
  naming the `browser` panel so the person's conversation page opens it. The question's title is
  请在浏览器中完成：<the reason's first sentence> / Finish in the browser: …, the body is the full
  reason, and `choices` draw 完成 (true, primary) and 取消 (false) as buttons. It stays a boolean
  because the kernel's `answerHandoff`, which the banner uses, answers `{ done }`. On
  resume it clears the notice (with Done also handing the browser back, so a takeover the person
  still holds ends) and returns the page snapshot, or fails with "The user cancelled the handoff;
  ask the user how to continue, or try another approach.".
- `browser_wait` (browser long waits spec, `2026-11-25-browser-long-waits-design.md` in core): at
  most one condition (`text`, `ref`, `urlContains`, `navigation`, `download`) and `timeoutMs` up
  to 24 h. A wait of 60 s or less is one `op: "wait"` in the call. A longer one needs a condition:
  the first invocation sends `watch_start` (watch id: the first 32 hex characters of the call's
  idempotency key; `remainingMs`, never an absolute time) and returns a watched `InputRequired`
  (one 结束等待 / End wait button, `watch.deadlineMs`). The tool's watcher (`src/wait.ts`) sends
  `watch_poll` with `ifRunning` (a stopped device or service settles the wait, nothing is started
  or resumed); the resumed invocation sends `watch_end` with `ifRunning` and maps the latched state
  and `resume.outcome` to the result or an actionable error.
- `browser_screenshot` asks for at most 2 MiB and retries once at half that when the reply did
  not fit in one service message. A refused host's error ends with one next step (the user is
  asked to allow it); a service start that fails has its own text.
- Panel routes: `GET /ui/browser` (the page) and `GET /ui/panel.js` are public; `POST
  /ui/stream-ticket`, `/ui/network-hosts`, `/ui/handoff-answer` and `/ui/loopback-ports` (`GET`
  the conversation's open local ports, `POST { port }` grant one with `grantLoopbackPort`,
  `DELETE { port }` revoke it; the panel's 允许本会话访问 / Allow for this conversation strip and its
  list with 移除 / Remove) are `embed` routes that take
  the org, account and conversation from the caller only (a platform-scope token or one without a
  conversation gets 403). `/ui/handoff-answer` takes `{ callId, handoffConversationId, done }`:
  the panel echoes the handoff's conversation from the daemon's `state.handoffs` (a sub-agent's,
  in the root's panel), and the kernel answers only for the scope conversation or a descendant.
  The panel never starts the service: a ticket is minted either way, and a stopped service closes
  the viewer with 4404 (the panel's "not running" state).

## The daemon (`daemon/`)

- Loopback ports: behind the device's proxy, loopback goes through it like every other host
  (Playwright's `<-loopback>`, added to the flag form too). The daemon keeps each root's ports from
  the last request that carried them, and a context route aborts a loopback request whose page's
  owner's root does not hold the port (another tree's tab, an unowned page, a service worker),
  recording it as refused (`layer: "address"`, `class: "loopback"`) and sending the tree's viewers
  `{ t: "blocked", port, kind: "loopback" }`. The device opens a granted port to the whole device;
  this check keeps it to the granted tree.

- Long waits (`daemon/watches.ts`): `watch_start` binds a watch to the conversation's active tab
  (refused without one) and latches the first outcome, checked every 500 ms: met, or ended by a
  confirm / prompt dialog on the tab (`dialog`), the tab closing (`tab_closed`) or its remaining
  time on the device's clock (`deadline`); a download watch is met when the owner's next download
  is saved (`detail`: its path). `watch_poll` answers the state and is the heartbeat: a watch not
  polled for 10 minutes is dropped. At most 16 watches (a 17th drops the oldest latched one, else
  the oldest). A pending watch is the conversation's park. Watch ops bypass the takeover refusal
  and never drop a pending handoff; `watch_start` and `watch_poll` take neither the hand back note
  nor the unreported notes, `watch_end` does. Viewers of the tree get `state.waiting`.

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
- Chromium runs with `--no-sandbox` (Playwright's default, `chromiumSandbox: false`) on Linux devices.
  This is a decision (plugins#286): the device container is the isolation boundary (`CapDrop: ALL`,
  `no-new-privileges`, Docker's default seccomp profile, egress through the proxy), and the agent can
  already run arbitrary commands in that container, so a renderer escape gains nothing beyond what
  the agent has. Chromium's sandbox would need user namespaces or a custom seccomp profile for every
  command in the device (rejected), or a separate browser container (not planned now).
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
- One browser download per machine and browser revision (plugins#311): the service files carry
  `capybara-install-key` (both Chromium builds' revisions, e.g.
  `chromium-1255+chromium-headless-shell-1255`). A capybara-device with the machine-wide install
  cache keys the install directory by it, so a plugin upgrade that keeps the revisions, and every
  other device of the same deployment and OS user, reuse the sealed browser (verified before each
  reuse) instead of downloading it again; an older capybara-device ignores the file. While the
  first start still installs, a request answers `installing` within 2 s with how far the download
  got; the plugin asks again with growing pauses for at most 30 s within the tool call, then
  passes that answer to the model ("The browser is being installed in the device (120 of 180 MB
  downloaded) … Call the tool again in a moment.") instead of waiting into the service timeout.
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
- `<state>/session.json` keeps the open tabs' URLs with their owners and, per conversation, the
  active tab, the pending handoff and park (an older file is not restored). A daemon started within
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
- A `handoff_clear` with `handback` (the person answered Done) also ends a takeover. A handoff is
  kept per conversation (at most one each) and dropped only by that conversation's next request.
- Viewer input (mouse, keys, text, address bar, tab open / switch / close) is applied only while
  the person holds control: in the watch state a viewer may only choose its shown tab (`show`, a
  tab of its tree) and move another conversation's tab here (`tab` `adopt`); any other input is
  dropped on arrival, and input
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

## Page dialogs, HTTP sign-in, permissions

Dialogs spec, `docs/superpowers/specs/2026-11-25-browser-dialogs-and-touch-design.md` in
capybara-hq/core.

- **Held decision dialogs.** An alert is closed at once and noted (`The page showed an alert:
  "…" (closed).`). A confirm, prompt or leave-page (beforeunload) dialog is held until answered,
  one per tab, with no timer and no default: the request that opened it replies at once with
  `reply.dialog` (and leaves its conversation's queue: its own late failure comes as a note), and
  every later reply of that conversation names it (its active tab's first). While it is held the
  tab's snapshot returns the dialog line instead of the tree, other actions on the tab, a
  screenshot too (a modal dialog stops the page's renderer, even a capture never answers), fail at
  once with `dialog_open`, and the tab is pinned (a park: no idle close, no eviction, no adopt).
  Actions on other tabs go on, except in a one-process browser (the macOS headless shell), where a
  held dialog stops every page: there every acting request is refused at once meanwhile (the
  owner's naming its dialog, others a generic text) instead of hanging.
- **`browser_dialog`** `{ dialogId, message, action: accept | dismiss, text? }` (`ask`) answers
  one dialog of the conversation's own tabs (another conversation's is refused with the adopt
  text). `message` must match the dialog's quote: CRLF as LF, whitespace runs as one space,
  trimmed, cut to 300 code points; the tool results quote exactly that (JSON string), so an
  approval covers exactly the dialog it shows. A prompt accepted without text takes its default.
  It runs beside the action queue and is refused while the person holds control.
- **HTTP Basic sign-in.** A main-frame `401` with `WWW-Authenticate: Basic` becomes an auth dialog
  (origin and the page-supplied realm; not blocking: the headless shell shows the 401 body, the
  full build fails the navigation, which the reply then reports as the dialog instead of an
  error). The agent can only dismiss it and is told to call `browser_handoff`; another scheme is
  noted as unsupported. The person signs in from the panel while holding control: the username and
  password go over the viewer stream straight to the daemon (the kernel relays bytes), are kept
  as the header value in the daemon's memory only (never a reply, note, log line, viewer message or
  file, and gone when the daemon stops) and are added by a `context.route` only to requests to that
  exact origin from pages whose top-level document has that origin, and to top-level navigations
  to it that the page itself or the daemon (address bar, tool, history, reload) starts: never to a
  cross-site page's request, a redirect into the origin or a service worker. A `401` to a signed
  request drops the credentials and asks again. They are device-wide by origin, like the profile.
- **Permission requests.** An init script wraps `Notification.requestPermission`, the clipboard
  reads, the geolocation error callbacks and `getUserMedia`, and reports a refusal through a
  binding with a per-daemon random name (the page gets the very same result). Any page can call
  the binding, so only a known permission name is read: the origin is the calling frame's, at most
  5 reports per page load and 50 origin–permission pairs. The owner's next reply notes it once per
  pair; the tree's viewers get a `permission` strip, and the person in control may allow
  notifications or clipboard reading for that origin (`grantPermissions`, for the daemon's life,
  only for a pair recorded on a tab of the viewer's tree). Geolocation, camera and microphone are
  reported as unavailable.
- **Phone viewport and touch.** Only the person in control switches (`viewport` `phone`: 390×844,
  scale 2, mobile, touch, a mobile user agent from the browser's own version); every tab and tabs
  opened meanwhile get it (a tab's first document may keep the desktop user agent until a reload).
  Hand back restores the desktop profile ahead of every conversation's next request, so the agent
  always acts on 1280×800. Touch input is dispatched as touch events in phone and becomes a click
  (tap) or a scroll (one-finger pan) in desktop. Viewer input clamps and the screencast follow the
  profile; the profile switch is ordered with the person's input.

## Tabs

Tab ownership spec, `docs/superpowers/specs/2026-11-25-browser-tab-ownership-design.md` in
capybara-hq/core. One daemon, one Chromium and one profile per device stay: logins and cookies are
shared by every conversation, the tabs are not.

- **Owned per conversation.** Every tab belongs to one conversation, which alone acts on it, and
  each conversation has its own active tab and its own action queue. A conversation's first acting
  call takes the browser's blank start tab if it is free, else opens a new tab (never another
  unowned page); `tabs list`, `adopt`, `wait` and the handoff bookkeeping never open one. When a
  conversation loses its active tab, the tab it gained last becomes active. A popup belongs to the
  owner of the page that opened it. `switch` and `close` take only the conversation's own tabs.
- **Seen per task tree.** A conversation and its sub-agent conversations form a tree whose root is
  the conversation the person looks at. `tabs list` shows the conversation's own tabs, then the
  tree's other tabs, then other trees' tabs (titles cut to 120 characters, URLs without query or
  fragment). A panel shows its tree's tabs, grouped per sub-task, and the newest pending handoff of
  the tree; a sub-agent's handoff is answered with Done from the root's panel.
- **Adopt / Move here.** `browser_tabs` action `adopt` (with `tabId`) moves another conversation's
  tab (or an unowned one) to the calling conversation and makes it its active tab; the previous
  owner's next result says so. The panel's 其他对话 / Other conversations menu does the same with
  移到此对话 / Move here, also while only watching. Refused while the owner is in use (a request in
  flight or a pending handoff, long wait or held dialog).
- **Caps and eviction.** At most 10 tabs in the browser and 6 per conversation. At the device cap
  the daemon first closes the least recently used tab of a conversation that is not in use and has
  made no request for 5 minutes (its non-active tabs before its active one) and tells that
  conversation; it refuses only when no tab qualifies.
- **Idle close.** A conversation's tabs close after 15 minutes without a request, without an open
  panel showing it and without a pending park; its per-conversation state goes with them. The
  profile is never touched.
- **Deleted conversations.** The kernel's conversation-deleted notice (a kernel request body, SDK
  `parseConversationDeleted`) closes the tabs of the conversation and of its sub-agent
  conversations at once, parked ones included, forgets their state and drops them from the
  session file; it answers `{ ok: true, closed }` and a repeat closes nothing. The kernel keeps the
  notice owed while the device is offline or the service is stopped within the restore window
  (`DEVICE_SERVICE_RESTORE_MAX_AGE_MS`, also the session file's limit); the idle close is the
  backstop. The profile is never touched.
- **Takeover per device.** While the person controls the browser from any conversation's panel,
  every conversation's agent requests are refused. Afterwards only the conversations whose tabs the
  takeover concerned are told that the user had control.

## The panel (`ui-src/panel/`)

- Every viewer is the owner's: any panel is interactive (keys, pointer, touch, Esc) while the
  person holds control, whichever panel took it, and may ask for frames up to the full viewport
  then. A phone takes over inside its drawer (no full mode) and, like a touch screen, shows a
  takeover bar: 手机宽度 / 桌面宽度, 键盘 (raises the soft keyboard; its text, delete and line
  break reach the page) and 交还智能体, with 44 px targets; the phone width is suggested once per
  takeover, never switched for the person. A held page dialog shows as a box over the picture
  (page text as text): answer controls for the person in control (确定 / 取消, a prompt field, 离开 /
  留下, username + password + 登录 / 取消; the password field is cleared after sending), read-only
  with 接管后可回答 otherwise. Permission requests show a strip with 允许 for a grantable one. In the watch state the panel takes no page input (no pointer, keys, address bar,
  navigation or tab open / close; the cursor is the arrow), but a click on a tab of the strip shows
  that tab, and 其他对话 / Other conversations › 移到此对话 / Move here moves another conversation's
  tab here. Nothing is kept in storage (the sandboxed iframe has none);
  a remount rebuilds from the daemon's first state. Take over is offered only in the live view;
  handing back with a pending handoff answers it Done.
- The strip shows the conversation tree's tabs: this conversation's first, then one 子任务 /
  Sub-task group per sub-agent conversation. With no tab in the tree while the browser runs, the
  panel shows 智能体尚未在此对话中打开网页 / "The agent has not opened a page in this conversation
  yet" (never another conversation's page). A refused Move here shows a short line (the tab is in
  use, or this conversation has its most tabs). The banner shows the tree's newest pending handoff;
  its Done / Cancel answer that handoff's conversation.
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
