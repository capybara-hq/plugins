---
"@capybara-hq/plugin-slack": patch
---

Markdown tables in replies are sent as native Block Kit table blocks (one per message, split by
rows past 100 rows or 10,000 characters, with the header repeated); the notification text, tables
over 20 columns and messages Slack rejects show each row as a list item instead of raw pipes.
