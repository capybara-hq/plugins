---
"@capybara-hq/plugin-telegram": patch
---

Tables in replies render as real tables: a reply with a Markdown table is sent (and edited while it
streams) as a Bot API rich message with a native table. When Telegram refuses the rich message, the
reply goes out as plain HTML with each table as a list, as before.
