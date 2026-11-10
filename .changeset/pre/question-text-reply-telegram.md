---
"@capybara-hq/plugin-telegram": patch
---

Question cards offer a text reply: with `textReply`, a question whose field allows "Other" still
gets its option buttons (no Other button; the Other path is a plain reply) and a pending card shows
the text-reply hint. The new `skipped` state (the person replied instead) has its label, and a
state the plugin does not know shows the SDK's label instead of `undefined`.
