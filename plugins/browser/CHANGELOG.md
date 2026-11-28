# @capybara-hq/plugin-browser

## 0.1.0-rc.21

### Patch Changes

- 7c0d502: The panel's local port strip hides as soon as its port is in the conversation's granted list, and never shows for a port already granted.

## 0.1.0-rc.20

### Minor Changes

- e74b219: Loopback port grants: a page on `localhost`, `127.0.0.1` or `[::1]` that the device keeps closed
  is reported with its port and the `loopback` class, so the kernel asks for the port and reruns the
  call once it is granted (the manifest declares `permissions.deviceAccess.loopbackPorts`, which
  needs the super admin's approval on upgrade). Every daemon request carries the conversation tree's
  live ports, and the daemon lets a tab reach a loopback port only while its own tree holds it, even
  when the device opened the port for another conversation. The panel shows "本机端口 3999 未开放"
  with 允许本会话访问 (the person's own grant, then the page opens again) and lists the conversation's
  open local ports with 移除. Loopback now goes through the device's proxy in the proxy flag form as
  well (Playwright's rule for its proxy option).
  A panel grant or remove takes effect at once: the plugin pushes the tree's live ports to the
  running daemon (waiting for a service the change restarted), and the daemon keeps them in its
  state directory across restarts. Hosts are matched as the device's proxy canonicalizes them
  (`localhost.`, `127.1`), and a local port a page elsewhere requests as a subresource is only noted,
  never asked for.

## 0.1.0-rc.19

### Patch Changes

- a7a93b4: The browser panel and the file previewer paint no ground of their own before the host's `init`:
  it was the light `Canvas` colour whatever the host's theme, so the embed flashed white in the
  dark theme before its tokens arrived. Transparent, the host's pane shows through until then.

## 0.1.0-rc.18

### Patch Changes

- 44007f1: The browser panel keeps the conversation's empty state ("The agent has not opened a page in this
  conversation yet") while it reconnects (a stream that ended, a hidden tab coming back) instead of
  flashing the connecting skeleton: there is no page to wait for.

## 0.1.0-rc.17

### Patch Changes

- ef45d01: Closing the browser's last page no longer drops the live view: a deliberate close (the person's
  in a takeover, the agent's, an idle or deleted conversation's) that would leave Chromium without a
  page first opens an unowned blank tab, so Chromium never exits with its last window (which the
  daemon took for a crash, cutting the panel's stream: the panel showed the connecting skeleton
  before its empty state).
- ef45d01: The panel's empty-state heading uses the body text's face, and the panel's font stacks name
  Windows faces (Segoe UI, Microsoft YaHei UI, Cascadia Mono, Consolas) before their generic family:
  Chinese text no longer falls back to the Song face on Windows.

## 0.1.0-rc.16

### Patch Changes

- 333eb76: One Chromium download per machine and revision (#311): the daemon's service files carry
  `capybara-install-key` (the Chromium revisions), which a capybara-device with the machine-wide
  install cache keys the browser install by, so a plugin upgrade that keeps the revisions and the
  other devices of the same deployment reuse the sealed browser. While the first start still
  installs, a browser call answers within seconds with the download's progress ("The browser is
  being installed in the device (120 of 180 MB downloaded) …") instead of a 90 s service timeout.

## 0.1.0-rc.15

### Patch Changes

- 0847431: Report what the site answered to the credentials a person enters for HTTP sign-in (accepted, or rejected with the new sign-in dialog, once per origin) instead of always "signed in" (#306). After Chromium crashes, the daemon stays up and relaunches it on the next use, reopening each conversation's tabs; a request that was running when it crashed says so (#307).

## 0.1.0-rc.14

### Patch Changes

- 33494ab: Screenshots and the live view's first frame no longer drop a tab's viewport after a viewport
  profile switch (full Chromium on macOS showed the phone size, or the window's size, after hand
  back): captures go through the session holding the tab's device metrics, one at a time, never
  overlapping a profile change.

## 0.1.0-rc.13

### Patch Changes

- 84bb5d6: A page's own fetch, XHR or subresource that gets an HTTP Basic challenge now completes with its 401
  for the page to handle instead of hanging in the full Chromium build: the daemon keeps its credential
  route installed for the session and the vendored playwright-core cancels a site challenge no stored
  credentials match. Stored credentials still go only to the exact origin they were entered for.
  
  Stored credentials no longer follow a signed request that redirects out of their origin (the
  vendored playwright-core replayed the route's headers on every redirect hop), and a cross-origin
  frame embedded in the signed-in site's page no longer gets them.
- ac3d848: Document that Chromium runs with `--no-sandbox` in device-docker devices: the device container is
  the isolation boundary (plugins#286).

## 0.1.0-rc.12

### Patch Changes

- b71a5e9: A deleted conversation's tabs close right away: the daemon handles the kernel's conversation-deleted
  notice (SDK `parseConversationDeleted`) by closing the tabs of the conversation and of its
  sub-agent conversations, forgetting their state (handoffs and parks included) and dropping them
  from the session file, so a restart does not restore them. The profile (logins) is never touched;
  the idle close stays the backstop. The session file's restore window is the SDK's
  `DEVICE_SERVICE_RESTORE_MAX_AGE_MS`. Needs `@capybara-hq/plugin-sdk` 0.1.0-rc.83.
- 198fa25: Page dialogs, HTTP sign-in, permission prompts, phone viewport and touch takeover (plugins#208):
  confirm, prompt and leave-page dialogs are held until answered (new tool `browser_dialog`, the
  panel's dialog box), HTTP Basic sign-in from the panel with credentials kept in the daemon's
  memory, refused permission requests reported (notifications and clipboard can be allowed), and a
  phone viewport with touch input and a soft keyboard for a takeover from a phone.
- 1f286ab: Long waits (plugins#207): browser_wait takes up to 24 h and two new conditions, `urlContains` and
  `download`. A wait over 60 s needs a condition and parks the run as a watched input wait (core#939):
  the daemon arms a watch on the conversation's active tab, the kernel polls it every 10 s without
  starting the service or resuming the device, and the run resumes when the condition holds, a
  decision dialog opens, the tab closes, the time passes or the person ends the wait from its card.
  The panel's status line says what the agent waits for and until when.

## 0.1.0-rc.11

### Patch Changes

- 9253fc0: A navigation keeps going while the device's network changes under it (Wi-Fi, a VPN, a container
  network coming up), as often as the network changes within the navigation's time, instead of
  failing with net::ERR_NETWORK_CHANGED after the fourth change; one the changes kept from loading in
  its time is reported as not loaded within that time. A navigation Chromium starts once more itself
  after the previous page's late error page interrupted it is followed to its page instead of failing
  with "interrupted by another navigation".

## 0.1.0-rc.10

### Patch Changes

- d946859: Tab icons for sites with large favicons, and an icon slot that is never an empty grey square.
  - www.baidu.com's favicon is a 64 px 32-bit ICO of 16958 bytes, over the 8 KiB cap, so it was
    dropped. The browser now draws an oversized raster icon into a 32 px PNG, in an isolated world of
    the tab's frame, and that PNG is checked against the same cap.
  - The icon slot in the tab strip, the narrow tabs button and the tab menus always shows a
    deliberate 14 px glyph: a spinner while the tab loads (`ViewerTab.loading`), a neutral globe after
    load without an icon (and for the other conversations' tabs, which have none). The site's icon
    replaces it in the same box when it arrives.
- a41944f: A host the device's proxy refused is reported with the layer that refused it: a name that resolves
  to a private or local address on the device (or a closed IP literal) is reported as `address`, so
  the kernel writes the private-address note instead of offering a network ask or naming an
  organization admin, and the panel no longer offers to allow such a host. Needs
  `@capybara-hq/plugin-sdk` 0.1.0-rc.77 (`ServiceBlockedHost`, `sandboxProxyRefusalLayer`) and a
  kernel that reads the layers.
- 6de3967: "The device's network proxy is not reachable" is said only when the connection to the proxy could
  not be made (refused, unreachable, unresolved); a proxy that took the connection and then reset it
  is no longer reported as down.
- a97f338: A navigation that fails at the connection level (`ERR_TIMED_OUT`, `ERR_CONNECTION_*`,
  `ERR_NAME_NOT_RESOLVED`, a failed tunnel, ...) now asks the device's proxy about the host, as a
  failed tunnel did: blocked by the network settings, could not connect, or no page in time. When
  the proxy itself cannot be reached (`ERR_PROXY_CONNECTION_FAILED`, the device's network down or
  being set up), the result says so as `network_unavailable`, not an address problem, with its own
  next step.
- 942022a: Device services roll onto an upgraded plugin's files on device-docker and device-e2b as on local
  devices: the service manager records the digest of the files a service started from, reports it as
  `filesDigest` (`sha256:…`, the SDK's digest), keeps a running service on the same files and, on
  other files, stops it once the new files are there or were sent and checked, then starts it on
  them. The browser daemon answers the kernel's roll check (capybara-hq/core#879) busy while the
  person holds control or a handoff younger than 30 minutes waits, so a roll waits for a later
  call (a handoff nobody ends no longer holds it).
  A navigation the device's network change dropped (`ERR_NETWORK_CHANGED`: Wi-Fi, a VPN, a container
  network) is followed if Chromium keeps it going and run again otherwise, a few times within its
  deadline; a request it dropped has its host checked against the proxy, as a failed tunnel does.

## 0.1.0-rc.9

### Patch Changes

- c113a7c: Tab ownership follow-ups: a navigation that a late error page interrupted runs again when its
  request was aborted; `browser_wait` never claims or opens a tab (also while the person holds
  control); a conversation's first call claims only the browser's blank start tab; an evicted tab is
  closing from the start; the device cap leaves out tabs already closing; after losing its active tab,
  a conversation's newest gained tab becomes active.

## 0.1.0-rc.8

### Patch Changes

- 20c6274: Browser tabs are owned per conversation. Each conversation acts only on its own tabs and has its
  own active tab, so two conversations browsing on one device no longer navigate, click or type into
  each other's page; the profile (logins, cookies) stays shared. `browser_tabs list` also shows the
  task's sub-agent tabs and other conversations' tabs, and the new action `adopt` moves one to the
  calling conversation when the user points to a page opened elsewhere (the panel's "Move here" does
  the same). Caps: 10 tabs per device, 6 per conversation, with idle tabs of other conversations
  closed to make room; a conversation's tabs close after 15 minutes unused. A sub-agent's handoff is
  shown in, and answered from, the root conversation's panel. Every tool result ends with the
  conversation's tab count.
  
  Needs kernel 0.1.0-rc.92 or later (core v0.1.0-rc.117, plugin-sdk rc.75): the manifest's `sdk`
  range is `^0.1.0-rc.75`, `/ui/handoff-answer` requires `handoffConversationId`, and the daemon
  refuses viewer streams without the kernel's viewer context.

## 0.1.0-rc.7

### Patch Changes

- 3e7e986: The handoff question in the conversation now matches the panel banner. Its title is a short
  "请在浏览器中完成：<reason>" / "Finish in the browser: <reason>", the agent's full reason is the body,
  and 完成 / 取消 are buttons (InputForm `choices` on `{ done }`) instead of a toggle with Answer.
  Needs plugin-sdk rc.75 (core v0.1.0-rc.117).
  
  The panel's `/ui/handoff-answer` passes `handoffConversationId`, which plugin-sdk rc.75's
  `answerHandoff` requires. By default it is the panel's conversation, or the raising conversation
  when the panel names it (a sub-agent's).
- 004df64: Closing the last tabs quickly (two closes in a takeover, or a close beside a tab list) leaves one
  blank tab, not one per close: callers that find no tab share the one blank tab being opened. The
  panel labels a blank tab "New tab" (新标签页) instead of about:blank.

## 0.1.0-rc.6

### Patch Changes

- bbae7f8: device-local runs the full Chromium build too where its capybara-device sets `CAPYBARA_SERVICE_MACH=chromium` (an older one keeps
  the headless shell) (new headless mode, an ordinary Chrome), installed into the sealed install
  directory as before: the local sandbox now lets the browser service register Chromium's own Mach services (capybara-hq/core#843).
  On macOS the browser gets `MAC_CHROMIUM_TMPDIR` (its temporary directory) and runs with crash reporting off.
  Where it keeps the headless shell, the next tool result asks the user to update capybara-device.
- 4ba34aa: When there is no browser to show (not running, device offline, live view stopped), the browser
  panel shows only the centred idle state (title, one line, 重新连接) on the neutral ground. There is
  no empty tab strip, toolbar or status line reserving space above it. When the browser comes up, the
  panel switches once to the live layout on its first frame.
- cca40b2: The panel's tabs show the site's icon. When a page loads, the daemon finds the page's
  `<link rel=icon>` (or `/favicon.ico`) and the browser fetches it (CDP
  `Network.loadNetworkResource`, through the device's network rules). The daemon sniffs it, caps it
  at 8 KiB and keeps it per tab, and sends it as `ViewerTab.favicon` (a `data:image/...` URL). The
  panel shows it, with the grey placeholder only as a fallback. State messages over the size cap drop
  the icons first.
- 77d8eac: Pages such as www.google.com load through a device proxy with credentials: the daemon disables
  Chromium's `AcceptCHFrame` (Playwright's proxy-credential interception lost the request Chromium
  restarts for an ACCEPT_CH frame, so the navigation hung at about:blank), keeping Playwright's own
  disabled features. A navigation that fails now says why (`unreachable`): Chromium's net error, and
  for a failed tunnel what the device's proxy answers for the host. A navigation with no page within
  30 s is stopped, so the next snapshot and tab list answer at once; the tab list runs beside the
  actions, and a reply's title and verification check are bounded. A 204 answer says so, and a network error page no longer reloads itself
  (`--disable-auto-reload`), which aborted the next navigation. After a
  fresh browser install the plugin waits for the old daemon to exit before starting the new one,
  within the same tool call.

## 0.1.0-rc.5

### Patch Changes

- 955965f: A stopping browser daemon saves the persistent cookies to its state directory before it closes Chromium, and a start adds back any the profile lacks. A loaded stop that the service's kill cut short no longer loses a person's logins.
- 8eed389: The browser runs the full Chromium in its new headless mode on Linux devices and presents as an ordinary Chrome (Chrome's reduced
  user agent, no "HeadlessChrome"; its own client hints; a window the size of the viewport); macOS keeps the headless shell, which
  the local sandbox allows. It never runs a browser from a place it or an agent command could write (plugins#209): the image's
  read-only pinned browser (any revision shipped there), or on device-local the provider's install directory, installed afresh and
  sealed on the first start (the daemon then restarts within the same tool call); without either it refuses to start and says
  how to get one. Uploads are read by the daemon and handed over from memory, and downloads written only into exclusively created,
  checked files, so links planted in the workspace never reach the browser's profile. Verification pages (CAPTCHAs, bot checks) are recognised: tool results tell the
  agent to hand off, and the viewer's tab state carries `blocker: { kind: "verification", url }` for the panel.
- 5037a7b: The browser panel follows the approved browser panel design:
  - One box, using the host's theme tokens.
  - A single skeleton until the first frame.
  - A contained, centred picture with an accent ring while the person is in control.
  - A fixed-height status line.
  - Take over at every width, with a narrow form that has a tabs button and a "more" menu.
  - A verify strip, driven by the active tab's `blocker` (kind `verification`).
  
  The panel's full-mode layout now follows only the host's `panel-mode` message, and it no longer
  posts `resize` (the host fills the panel). `browser_handoff` opens the browser panel on the person's
  conversation page (`InputRequired.open`). Needs core v0.1.0-rc.115 (plugin-sdk rc.72, kernel rc.90).
- 12e1b51: A stopping browser daemon waits until Chromium's process is gone, not only for Playwright to report the close, so a restart on the same profile no longer reads cookies Chromium had not finished writing.
- 7435870: Takeover feels close to a local browser, and the watch state is read-only.
  
  - The watch state (the agent drives) sends no input, and the daemon drops viewer input unless the person holds control.
  - Frames are paced by how long they take on the link compared with a ping: quality and then scale drop while frames would keep a click waiting, only the newest frame waits, up to 15 frames per second on a fast link. Frames are binary (no base64 or JSON) and sized to the picture's CSS box with the pixel ratio capped at 1.25.
  - Hover works (moves coalesced, the newest wins), the page's cursor shows on the picture, a press indicator appears at once on mousedown, and Chinese input (IME) and paste work through a hidden input field.
- 0159774: Takeover follow-ups: a button held at hand back is released off the element (the release completes no click), held keys and buttons are released on the tab where they were pressed, the cursor is found in cross-site frames nested in other cross-site frames, frame sessions opened for it are detached with their frame, and cursor lookups never overlap on a slow page.
- c759ac5: Every browser tool declares a time limit of 300 s (`ToolSpec.timeoutMs`, plugin-sdk rc.72), in
  place of the deployment's 60 s default. Any tool may be a conversation's first call, which must
  start the device and the browser service before its request: resuming or creating the instance,
  the service files, and a download of about 200 MB of Chromium. Older kernels ignore the field.

## 0.1.0-rc.4

### Patch Changes

- bdacf8c: The side panel sizes itself to the 16:10 frame at its width (embed `resize`) and letterboxes the
  frame when the host fills it; before the first browser tool call it shows "not running" at once
  and looks again quietly instead of a connecting loop; a navigation that Chromium drops for one
  already in flight to the same address succeeds on the page that loads (after its redirects).

## 0.1.0-rc.3

### Patch Changes

- 939f780: The headless shell download host list includes `storage.googleapis.com`, where the Playwright CDN
  redirects it, so a device allowlist that refuses it gets the ask instead of a bare "Failed to
  download"; a blocked host's next step no longer claims the user is always asked.

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
