---
"@capybara-hq/plugin-todo": patch
---

The todo card is the run's pinned card: `write` returns its card with `placement: "pinned"`, so
the conversation keeps the latest list in view under the run's process block, and with `text`
(a heading with the count done, then the checklist as a Markdown list, cut to 2000 characters on
whole items), which channels show in the run's progress card. Needs plugin-sdk 0.1.0-rc.81; on an
older kernel the card stays an output card.
