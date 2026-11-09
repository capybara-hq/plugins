# 创建 Slack 应用

这会把一个 Slack 工作区以机器人的形式接入 Capybara。成员可以直接私信机器人、在频道里 @ 它，
并使用斜杠命令 `/new`、`/env` 和 `/capybara`。你需要有在该工作区创建应用的权限（工作区开启了
「Only allow pre-approved apps」时，第 2 步之后需要工作区管理员批准该应用）。

## 1. 用 manifest 创建应用

打开 <https://api.slack.com/apps>，选择 **Create New App → From a manifest**，选中你的工作区，
粘贴下面的 manifest。它会登记插件需要的机器人权限、事件和斜杠命令。

::: mode long_connection
Socket Mode 不需要公网地址：由 Slack 与 Capybara 之间保持一条长连接。

```yaml title="应用 manifest（Socket Mode）"
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
    display_name: capybara
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

## 2. 创建应用级令牌

在 **Basic Information → App-Level Tokens** 选择 **Generate Token and Scopes**，添加权限
`connections:write`，把 `xapp-…` 令牌填进下方的 **应用令牌**。

::check app-token 应用令牌能建立 Socket Mode 连接
:::

::: mode webhook
Webhook 模式下，Slack 把事件、卡片点击和斜杠命令发到这个渠道连接的地址，并在保存时校验该地址。

```yaml title="应用 manifest（Webhook）"
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
    display_name: capybara
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

创建应用或保存 **Event Subscriptions** 时，Slack 会校验 Request URL `{{webhookUrl}}`，由 Capybara
应答校验，所以要先保存渠道连接。若 Slack 提示地址未通过校验，先在这里保存连接，再到
**Event Subscriptions** 重试。

## 2. 复制签名密钥

把 **Basic Information → App Credentials → Signing Secret** 填进下方的 **签名密钥**。每个 webhook
请求都用它校验；不填则所有请求都会被拒绝。

::check capybara:webhook-public Webhook 地址可从公网访问
::check capybara:webhook-received Slack 已送达一个签名有效的请求
:::

## 3. 安装应用并复制机器人令牌

选择 **Install App → Install to Workspace**，把 **Bot User OAuth Token**（`xoxb-…`）填进下方的
**机器人令牌**。

::check bot-token 机器人令牌可用
::check bot-scopes 应用具备 manifest 中的全部权限

## Slack 登录

manifest 里的重定向地址 `{{signInCallbackUrl}}` 用于 **Sign in with Slack**（Slack 登录），需要部署
设置公网地址；未设置时，请从 manifest 中删掉该重定向地址，或请超级管理员设置 `http.publicUrl`。

::check capybara:public-url 平台已设置公网地址

## 插件更新了 manifest 时

Slack 插件更新并改动了 manifest 后，Capybara 会在这个渠道连接上显示提示。在
<https://api.slack.com/apps> 打开该应用，进入 **App Manifest**，粘贴新的 manifest 并保存，Slack
要求时重新安装应用，然后在这里点 **我已更新 Slack 应用** 确认。
