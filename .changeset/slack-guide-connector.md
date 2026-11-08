---
"@capybara-hq/plugin-slack": minor
---

The app manifest is now a setup guide (`slack-app`): Capybara renders it for each channel connection,
with the connection name, the Sign in with Slack callback and, in webhook mode, the webhook URL as
every Request URL (`app-manifest.yaml` is replaced by `guides/`). Inbound senders carry their Slack
time zone and language (`users.info` `tz` / `locale`, cached in kv per team and user). The approval
card shows the call summary as plain text labelled Summary / 摘要. New connector template `slack`
(off by default): per-person OAuth to Slack's MCP server through connector-mcp, with
`app-manifest.connector.yaml` for the internal OAuth app.
