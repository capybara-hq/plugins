---
"@capybara-hq/plugin-slack": minor
---

Setup guides v2: the channel guide `slack-app` and the new connector template guide
`slack-connector` are Markdown documents (`guides/*.md`, with Chinese translations) with mode and
audience sections, titled manifest code blocks and live check rows. The extension registers three
read-only setup checks (`permissions.setupChecks`): `bot-token` (`auth.test`), `bot-scopes` (the
bot token's scopes against the manifest) and `app-token` (`apps.connections.open`, Socket Mode
only). The v1 manifest templates and `app-manifest.connector.yaml` are gone; the README points at
the in-product guides.
