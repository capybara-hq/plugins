---
"@capybara-hq/plugin-browser": patch
---

The side panel sizes itself to the 16:10 frame at its width (embed `resize`) and letterboxes the
frame when the host fills it; before the first browser tool call it shows "not running" at once
and looks again quietly instead of a connecting loop; a navigation that Chromium drops for one
already in flight to the same address succeeds on the page that loads (after its redirects).
