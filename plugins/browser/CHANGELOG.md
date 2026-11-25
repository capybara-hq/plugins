# @capybara-hq/plugin-browser

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
