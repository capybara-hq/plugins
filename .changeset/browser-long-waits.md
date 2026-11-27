---
"@capybara-hq/plugin-browser": patch
---

Long waits (plugins#207): browser_wait takes up to 24 h and two new conditions, `urlContains` and
`download`. A wait over 60 s needs a condition and parks the run as a watched input wait (core#939):
the daemon arms a watch on the conversation's active tab, the kernel polls it every 10 s without
starting the service or resuming the device, and the run resumes when the condition holds, a
decision dialog opens, the tab closes, the time passes or the person ends the wait from its card.
The panel's status line says what the agent waits for and until when.
