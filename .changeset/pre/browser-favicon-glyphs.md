---
"@capybara-hq/plugin-browser": patch
---

Tab icons for sites with large favicons, and an icon slot that is never an empty grey square.
- www.baidu.com's favicon is a 64 px 32-bit ICO of 16958 bytes, over the 8 KiB cap, so it was
  dropped. The browser now draws an oversized raster icon into a 32 px PNG, in an isolated world of
  the tab's frame, and that PNG is checked against the same cap.
- The icon slot in the tab strip, the narrow tabs button and the tab menus always shows a
  deliberate 14 px glyph: a spinner while the tab loads (`ViewerTab.loading`), a neutral globe after
  load without an icon (and for the other conversations' tabs, which have none). The site's icon
  replaces it in the same box when it arrives.
