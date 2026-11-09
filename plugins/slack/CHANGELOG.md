# @capybara-hq/plugin-slack

## 0.1.0-rc.5

### Minor Changes

- f1b7696: Setup guides v2: the channel guide `slack-app` and the new connector template guide
  `slack-connector` are Markdown documents (`guides/*.md`, with Chinese translations) with mode and
  audience sections, titled manifest code blocks and live check rows. The extension registers three
  read-only setup checks (`permissions.setupChecks`): `bot-token` (`auth.test`), `bot-scopes` (the
  bot token's scopes against the manifest) and `app-token` (`apps.connections.open`, Socket Mode
  only). The v1 manifest templates and `app-manifest.connector.yaml` are gone; the README points at
  the in-product guides.

## 0.1.0-rc.4

### Minor Changes

- 7dec2f6: The app manifest is now a setup guide (`slack-app`): Capybara renders it for each channel connection,
  with the connection name, the Sign in with Slack callback and, in webhook mode, the webhook URL as
  every Request URL (`app-manifest.yaml` is replaced by `guides/`). Inbound senders carry their Slack
  time zone and language (`users.info` `tz` / `locale`, cached in kv per team and user). The approval
  card shows the call summary as plain text labelled Summary / 摘要. New connector template `slack`
  (off by default): per-person OAuth to Slack's MCP server through connector-mcp, with
  `app-manifest.connector.yaml` for the internal OAuth app.

## 0.1.0-rc.3

### Patch Changes

- ce8d729: The plugin ships an icon (`icon.svg`): the Slack mark from the Slack media kit (source and date in the README).

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
