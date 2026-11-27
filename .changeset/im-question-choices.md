---
"@capybara-hq/plugin-slack": patch
"@capybara-hq/plugin-lark": patch
"@capybara-hq/plugin-telegram": patch
---

Render a question form's `choices` as buttons (the first primary, a click answers at once, a boolean
stays a boolean) and show its `body` text on the card; a form without choices is unchanged
(plugins#241).
