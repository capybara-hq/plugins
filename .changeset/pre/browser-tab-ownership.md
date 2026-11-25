---
"@capybara-hq/plugin-browser": patch
---

Browser tabs are owned per conversation. Each conversation acts only on its own tabs and has its
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
