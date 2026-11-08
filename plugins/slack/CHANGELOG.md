# @capybara-hq/plugin-slack

## 0.1.0-rc.2

### Patch Changes

- 63d79ae: Slash commands `/new`, `/env` and `/capybara <skill> [args]` reach the kernel as the text it parses
  (Slack rejected unregistered `/` messages), and the org-level and channel connection config fields
  get zh / en labels and help (the org fields say they are optional and only for member sync).
  Existing apps re-paste the manifest (or add the commands and the `commands` / `im:write` scopes) and
  reinstall.

## 0.1.0-rc.1

### Patch Changes

- 726eacb: Run on core 0.1.0-rc.4: bilingual config field labels and a display name.
