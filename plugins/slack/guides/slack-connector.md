# Set up the Slack connector

The Slack connector lets agents search, read and send Slack messages, canvases, lists and files
**as the person using them**, through Slack's MCP server. Each member connects their own Slack
account; there is no shared org token.

::: audience admin
An org admin sets it up once: create an internal Slack app (a separate app from the bot), then
enter its client id and secret here. Members connect afterwards.

## 1. Create the OAuth app

Open <https://api.slack.com/apps>, choose **Create New App → From a manifest** in the company
workspace and paste the manifest below. It turns on MCP and requests the user scopes the
{{templateName}} template asks for.

```yaml title="App manifest (Slack connector)"
# Slack app manifest for the "{{templateName}}" connector template ({{pluginName}} {{pluginVersion}}).
# A separate internal app: user scopes only, MCP on, no bot, no Socket Mode.
# Reference: https://docs.slack.dev/reference/app-manifest and
# https://docs.slack.dev/ai/slack-mcp-server/ (checked 2026-11-08).
display_information:
  name: "Capybara connector"
  description: Lets Capybara agents use Slack as you, with your permission.
  background_color: "#3d2f24"
oauth_config:
  redirect_urls:
    - "{{oauthCallbackUrl}}"
  scopes:
    user:
      - search:read.public
      - search:read.private
      - search:read.mpim
      - search:read.im
      - search:read.files
      - search:read.users
      - channels:history
      - groups:history
      - mpim:history
      - im:history
      - channels:read
      - groups:read
      - mpim:read
      - im:read
      - channels:write
      - groups:write
      - mpim:write
      - im:write
      - chat:write
      - canvases:read
      - canvases:write
      - lists:read
      - lists:write
      - files:read
      - files:write
      - reactions:read
      - reactions:write
      - emoji:read
      - users:read
      - users:read.email
settings:
  is_mcp_enabled: true
  org_deploy_enabled: false # true for an Enterprise Grid org-wide install
  socket_mode_enabled: false
  token_rotation_enabled: false
```

::check capybara:public-url The platform has a public URL

## 2. Keep the app internal

- Leave **Manage Distribution** off. Slack's MCP server serves only internal apps and Marketplace
  apps.
- Do **not** enable PKCE in the app settings: it turns the app into a public client for good.
  Capybara stays a confidential client.
- Keep token rotation off (the manifest does); without it user tokens do not expire.
- Approve or install the app as your workspace requires (with "Only allow pre-approved apps", a
  workspace admin approves it; on Enterprise Grid, an org admin).

## 3. Enter the client

Copy **Basic Information → App Credentials → Client ID** and **Client Secret** into the fields
below. The secret is stored encrypted and reads back only as "set".

::check capybara:oauth-client The client id and secret are entered
::check capybara:oauth-token-endpoint Slack accepts the client id and secret
::check capybara:connector-tools A member connected and the tool list was read

### Reusing the bot app instead

You can add the user scopes, turn on MCP and add the redirect URL `{{oauthCallbackUrl}}` to the
bot's app instead, as long as token rotation stays off (rotation is app-wide and would expire the
bot's `xoxb` token). Slack prefix-matches redirect URLs, so one entry `{{publicUrl}}/api/v1/`
covers this callback and the Sign in with Slack callback `{{signInCallbackUrl}}`.

## When the plugin changes this manifest

After an update that changes the scopes, Capybara shows a notice on the connector. Paste the new
manifest under **App Manifest**, save, and confirm here with **I have updated the Slack app**.
Members reconnect when Slack asks them to.
:::

::: audience member
## Connect your Slack account

Choose **Connect** and approve on Slack's consent screen. Agents then act in Slack as you, and
writes (sending, creating, reacting, uploading) ask you first unless your admin changed that.

**Disconnect** deletes the token in Capybara but does not revoke it at Slack: also remove the app
under your Slack profile's **Apps**, or ask a workspace admin.

::check capybara:connector-connected Your Slack account is connected
:::
