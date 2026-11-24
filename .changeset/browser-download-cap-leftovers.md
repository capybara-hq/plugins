---
"@capybara-hq/plugin-browser": patch
---

A download cancelled at the size cap no longer counts toward the cap of the downloads that follow while
its leftover file waits for removal, so a small download right after a cancelled big one is kept.
