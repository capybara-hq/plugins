# Create the Slack app

This connects one Slack workspace to Capybara as a bot. People message the bot directly, mention
it in channels and use the slash commands `/new`, `/env` and `/capybara`. You need permission to
create apps in the workspace (with "Only allow pre-approved apps", a workspace admin approves the
app after step 2).

## 1. Create the app from the manifest

Open <https://api.slack.com/apps>, choose **Create New App → From a manifest**, pick your
workspace and paste the manifest below.

::: mode long_connection
Socket Mode needs no public address: Slack keeps a connection open to Capybara. The manifest
registers the bot scopes, the events and the slash commands the plugin needs.

```yaml title="App manifest (Socket Mode)"
# Slack app manifest for the Capybara Slack plugin, Socket Mode (long connection).
# Reference: https://docs.slack.dev/reference/app-manifest (checked 2026-11-09).
display_information:
  # Slack caps app names at 35 characters; shorten it in the app settings if it is longer.
  name: "{{connectionName}}"
  description: Chat with your organization's Capybara agents.
  background_color: "#3d2f24"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Capybara
    always_online: true
  slash_commands:
    - command: /new
      description: Start a new conversation (direct message)
      should_escape: false
    - command: /env
      description: List or set your default environment (direct message)
      usage_hint: "[name]"
      should_escape: false
    - command: /capybara
      description: Run a skill
      usage_hint: "<skill> [args]"
      should_escape: false
oauth_config:
  # Sign in with Slack (identity-source@1).
  redirect_urls:
    - "{{signInCallbackUrl}}"
  scopes:
    bot:
      - chat:write # post and update replies and cards
      - commands # slash commands /new, /env, /capybara
      - im:write # conversations.open: tell the bot's own DM from other DMs
      - im:history # message.im: direct messages to the bot
      - app_mentions:read # app_mention: @capybara in channels
      - channels:history # message.channels: thread replies in public channels
      - groups:history # message.groups: thread replies in private channels
      - users:read # users.info; team_join / user_change; users.list
      - users:read.email # directory@1: email addresses in users.list
settings:
  event_subscriptions:
    bot_events:
      - message.im
      - app_mention
      - message.channels
      - message.groups
      - team_join
      - user_change
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
```
:::

::: mode webhook
In webhook mode Slack posts events, card clicks and slash commands to this connection's address,
which exists only once the connection is saved. Start with this basic manifest: it registers the
bot and its scopes, without any address. Step 5 adds the addresses after saving.

```yaml title="Basic app manifest (webhook)"
# Slack app manifest for the Capybara Slack plugin, webhook inbound mode, first step: no
# addresses yet. Step 5 replaces it with the full manifest once the connection is saved.
# Reference: https://docs.slack.dev/reference/app-manifest (checked 2026-11-09).
display_information:
  # Slack caps app names at 35 characters; shorten it in the app settings if it is longer.
  name: "{{connectionName}}"
  description: Chat with your organization's Capybara agents.
  background_color: "#3d2f24"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Capybara
    always_online: true
oauth_config:
  # Sign in with Slack (identity-source@1).
  redirect_urls:
    - "{{signInCallbackUrl}}"
  scopes:
    bot:
      - chat:write # post and update replies and cards
      - commands # slash commands /new, /env, /capybara
      - im:write # conversations.open: tell the bot's own DM from other DMs
      - im:history # message.im: direct messages to the bot
      - app_mentions:read # app_mention: @capybara in channels
      - channels:history # message.channels: thread replies in public channels
      - groups:history # message.groups: thread replies in private channels
      - users:read # users.info; team_join / user_change; users.list
      - users:read.email # directory@1: email addresses in users.list
settings:
  socket_mode_enabled: false
  org_deploy_enabled: false
  token_rotation_enabled: false
```
:::

::: mode long_connection
## 2. Create the app-level token

Under **Basic Information → App-Level Tokens** choose **Generate Token and Scopes**, add the scope
`connections:write` and copy the `xapp-…` token into the **App-level token** field below.

::check app-token App-level token opens a Socket Mode connection
:::

::: mode webhook
## 2. Copy the signing secret

Copy **Basic Information → App Credentials → Signing Secret** into the **Signing secret** field
below. Every webhook request is verified with it; without it every request is refused.
:::

## 3. Install the app and copy the bot token

Choose **Install App → Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-…`)
into the **Bot token** field below.

::check bot-token Bot token works
::check bot-scopes The app has every scope in the manifest

## 4. Save the channel

Fill in the remaining fields on this page and save. Capybara verifies the bot token when you save.
With Socket Mode that is all: the bot connects and is ready for messages.

::: mode webhook
## 5. Point Slack at this connection

After saving, the manifest below carries this connection's address `{{webhookUrl}}` (before saving
it is shown as written). In the app open **App Manifest**, replace the manifest with this one and
save. It adds the slash commands, the event subscriptions and interactivity, all sent to this
address.

```yaml title="App manifest (webhook)"
# Slack app manifest for the Capybara Slack plugin, webhook inbound mode.
# Reference: https://docs.slack.dev/reference/app-manifest (checked 2026-11-09).
display_information:
  # Slack caps app names at 35 characters; shorten it in the app settings if it is longer.
  name: "{{connectionName}}"
  description: Chat with your organization's Capybara agents.
  background_color: "#3d2f24"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Capybara
    always_online: true
  slash_commands:
    - command: /new
      url: "{{webhookUrl}}"
      description: Start a new conversation (direct message)
      should_escape: false
    - command: /env
      url: "{{webhookUrl}}"
      description: List or set your default environment (direct message)
      usage_hint: "[name]"
      should_escape: false
    - command: /capybara
      url: "{{webhookUrl}}"
      description: Run a skill
      usage_hint: "<skill> [args]"
      should_escape: false
oauth_config:
  # Sign in with Slack (identity-source@1).
  redirect_urls:
    - "{{signInCallbackUrl}}"
  scopes:
    bot:
      - chat:write # post and update replies and cards
      - commands # slash commands /new, /env, /capybara
      - im:write # conversations.open: tell the bot's own DM from other DMs
      - im:history # message.im: direct messages to the bot
      - app_mentions:read # app_mention: @capybara in channels
      - channels:history # message.channels: thread replies in public channels
      - groups:history # message.groups: thread replies in private channels
      - users:read # users.info; team_join / user_change; users.list
      - users:read.email # directory@1: email addresses in users.list
settings:
  event_subscriptions:
    request_url: "{{webhookUrl}}"
    bot_events:
      - message.im
      - app_mention
      - message.channels
      - message.groups
      - team_join
      - user_change
  interactivity:
    is_enabled: true
    request_url: "{{webhookUrl}}"
  socket_mode_enabled: false
  org_deploy_enabled: false
  token_rotation_enabled: false
```

Slack verifies the Request URL when you save, and Capybara answers because the connection now
exists. Reinstall the app if Slack asks.

::check capybara:webhook-public Webhook address is reachable from the internet
::check capybara:webhook-received Slack has delivered a signed request
:::

---

## Sign in with Slack

The manifest's redirect URL `{{signInCallbackUrl}}` is for **Sign in with Slack**. It needs the
deployment's public URL; without it, delete the redirect URL from the manifest or ask your super
admin to set `http.publicUrl`.

::check capybara:public-url The platform has a public URL

## When the plugin changes this manifest

After a Slack plugin update that changes the manifest, Capybara shows a notice on this connection.
Open the app at <https://api.slack.com/apps>, go to **App Manifest**, paste the new manifest,
save, reinstall the app if Slack asks, then confirm here with **I have updated the Slack app**.
