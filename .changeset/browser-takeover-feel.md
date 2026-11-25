---
"@capybara-hq/plugin-browser": patch
---

Takeover feels close to a local browser, and the watch state is read-only.

- The watch state (the agent drives) sends no input, and the daemon drops viewer input unless the person holds control.
- Frames are paced by how long they take on the link compared with a ping: quality and then scale drop while frames would keep a click waiting, only the newest frame waits, up to 15 frames per second on a fast link. Frames are binary (no base64 or JSON) and sized to the picture's CSS box with the pixel ratio capped at 1.25.
- Hover works (moves coalesced, the newest wins), the page's cursor shows on the picture, a press indicator appears at once on mousedown, and Chinese input (IME) and paste work through a hidden input field.
