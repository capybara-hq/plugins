---
"@capybara-hq/plugin-example-board": patch
---

Declare route access (plugin-sdk 0.1.0-rc.23): the page and its script are `public`, the data
routes (`/ui/cards`, `/ui/cards/:id`, `/ui/events`) are `embed`. The kernel verifies the embed token
(Bearer or `?token=`) before the handler, which reads org, conversation and expiry from `caller`
instead of calling `ctx.ui.verifyEmbedToken`; a platform-scope token gets 403.
