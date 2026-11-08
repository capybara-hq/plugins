---
"@capybara-hq/plugin-slack": patch
---

Slash commands `/new`, `/env` and `/capybara <skill> [args]` reach the kernel as the text it parses
(Slack rejected unregistered `/` messages), and the org-level and channel connection config fields
get zh / en labels and help (the org fields say they are optional and only for member sync).
Existing apps re-paste the manifest (or add the commands and the `commands` / `im:write` scopes) and
reinstall.
