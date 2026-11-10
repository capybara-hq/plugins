---
"@capybara-hq/plugin-telegram": patch
---

Group mentions need privacy mode off (or the bot as a group admin): with it on Telegram delivers
only commands and replies to the bot. The README says so and `verify` warns while privacy mode is
on, instead of warning when it is off.
