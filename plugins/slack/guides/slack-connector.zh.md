# 设置 Slack 连接器

Slack 连接器让智能体通过 Slack 的 MCP 服务器，**以使用者本人的身份**搜索、读取和发送 Slack 消息、
画布、列表和文件。每个成员连接自己的 Slack 账号，组织没有共用的令牌。

::: audience admin
由组织管理员设置一次：创建一个内部 Slack 应用（与机器人应用分开），再把它的 Client ID 和
Client Secret 填到这里。之后成员各自连接。

## 1. 创建 OAuth 应用

打开 <https://api.slack.com/apps>，在公司工作区选择 **Create New App → From a manifest**，粘贴
下面的 manifest。它会开启 MCP，并申请 {{templateName}} 模板需要的用户权限。

```yaml title="应用 manifest（Slack 连接器）"
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

::check capybara:public-url 平台已设置公网地址

## 2. 保持应用为内部应用

- 不要开启 **Manage Distribution**。Slack 的 MCP 服务器只服务内部应用和 Marketplace 应用。
- **不要**在应用设置里开启 PKCE：开启后应用会永久变成公开客户端。Capybara 始终是机密客户端。
- 保持令牌轮换关闭（manifest 已关闭）；不轮换时用户令牌不会过期。
- 按工作区的要求批准或安装应用（开启了「Only allow pre-approved apps」时由工作区管理员批准；
  Enterprise Grid 上由组织管理员批准）。

## 3. 填写客户端

把 **Basic Information → App Credentials → Client ID** 和 **Client Secret** 填进下方的字段。
密钥加密存储，读回时只显示「已设置」。

::check capybara:oauth-client 已填写 Client ID 和 Client Secret
::check capybara:oauth-token-endpoint Slack 接受该 Client ID 和 Client Secret
::check capybara:connector-tools 已有成员连接并读取到工具列表

### 改用机器人应用

也可以把这些用户权限、MCP 开关和重定向地址 `{{oauthCallbackUrl}}` 加到机器人应用上，前提是令牌
轮换保持关闭（轮换对整个应用生效，会让机器人的 `xoxb` 令牌过期）。Slack 按前缀匹配重定向地址，
所以一条 `{{publicUrl}}/api/v1/` 就能同时覆盖这个回调和 Slack 登录的回调 `{{signInCallbackUrl}}`。

## 插件更新了 manifest 时

插件更新并改动了权限后，Capybara 会在连接器上显示提示。在 **App Manifest** 粘贴新的 manifest
并保存，然后在这里点 **我已更新 Slack 应用** 确认。Slack 要求时，成员重新连接。
:::

::: audience member
## 连接你的 Slack 账号

点 **连接**，在 Slack 的授权页面上同意。之后智能体会以你的身份在 Slack 中操作；写操作（发送、
创建、回应、上传）会先征求你的同意，除非管理员改了设置。

**断开连接** 会删除 Capybara 中的令牌，但不会在 Slack 端撤销它：请同时在 Slack 个人资料的
**Apps** 中移除该应用，或请工作区管理员处理。

::check capybara:connector-connected 你的 Slack 账号已连接
:::
