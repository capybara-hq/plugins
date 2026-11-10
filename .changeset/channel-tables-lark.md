---
"@capybara-hq/plugin-lark": patch
---

Markdown tables in replies render reliably in cards: a blank line around each table, escaped pipes
kept inside cells, a table never split across cards when it fits (otherwise split by rows with the
header repeated), and at most four tables per card.
