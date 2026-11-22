# 设置 Google 幻灯片连接器

Google 幻灯片连接器让智能体经由 Google 的 Slides MCP 服务器、**以使用者本人的身份**读取演示文稿、幻灯片和缩略图，编辑演示文稿。每位成员连接自己的 Google 账号，所以智能体只能看到和修改这个人能看到和修改的内容。

::: audience admin
组织管理员只需在公司的 Google Cloud 项目里设置一次，再把 OAuth 客户端填到这里。之后成员各自连接。

## 1. 开始之前

Google 把 Slides MCP 服务器作为 Google Workspace Developer Preview Program（开发者预览计划）的一部分提供。你使用的 Workspace 账号和 Google Cloud 项目都必须已被该计划接纳（见 [Google 的预览计划页面](https://developers.google.com/workspace/preview)），并且适用计划条款：只有公司内部的人可以使用这个连接器。

## 2. 项目和服务

使用你的 Google Workspace 组织拥有的 Google Cloud 项目，最好就是 Sign in with Google 用的那个。在**存放下方 OAuth 客户端的同一个项目**里启用这些服务，把 `PROJECT_ID` 换成项目的 id：

```sh title="启用 Google 幻灯片 的服务"
gcloud services enable slides.googleapis.com slidesmcp.googleapis.com --project=PROJECT_ID
```

## 3. 同意屏幕

在 **Google Auth Platform → Audience** 里选择用户类型 **Internal**。Internal 应用不需要 Google 验证（即使是 Gmail 和云端硬盘这样的受限 scope），刷新令牌也不会在七天后过期。**External** 只能给列出的测试用户使用，应用处于 Testing 状态时他们的刷新令牌七天后过期；正式发布的 External 应用需要通过 Google 验证，受限 scope 还需要 CASA 安全评估。

## 4. OAuth 客户端

打开 **Google Auth Platform → Clients → Create client**，选择 **Web application**，按下面填写。其中的 scope 就是连接器向每位成员申请的权限。

```yaml title="OAuth 客户端（Google 幻灯片连接器）"
# OAuth client for the "{{templateName}}" connector template ({{pluginName}} {{pluginVersion}}).
# Reference: https://developers.google.com/workspace/guides/configure-mcp-servers (checked 2026-11-22).
Application type: Web application
Name: "Capybara connectors"
Authorized redirect URIs:
  - "{{oauthCallbackUrl}}"
Use this client for an AI-powered agent: on
Scopes requested:
  - https://www.googleapis.com/auth/drive.readonly
  - https://www.googleapis.com/auth/drive.file
  - https://www.googleapis.com/auth/presentations.readonly
  - https://www.googleapis.com/auth/presentations
```

务必打开上面列出的 AI 智能体客户端选项：没有打开这个选项的客户端会被 Google 拒绝访问 Workspace MCP 服务器。请使用一个**与 Sign in with Google 客户端分开**的客户端：如果一个客户端还用于登录等不属于智能体的功能，Google 要求另建一个。一个这样的客户端可以供组织里所有 Google 连接器使用。

## 5. 填写客户端

把客户端的 **Client ID** 和 **Client secret** 填到下面的字段里。secret 加密保存，读回时只显示“已设置”。

::check capybara:oauth-client 已填写 client id 和 secret
::check capybara:oauth-token-endpoint Google 接受这个 client id 和 secret
::check capybara:connector-tools 已有成员连接并读取了工具列表

## 工具和审批

读操作直接执行。写操作（`update_presentation`）会先询问成员。可以在连接器页面逐个工具修改。`drive.file` scope 只覆盖连接器创建或打开过的文件，所以写其他文件会失败并返回 Google 的权限错误。

## 调用被拒绝时

Workspace 管理员可能限制了第三方对 Google API 的访问（**Admin console → Security → Access and data control → API controls**）；请在那里把这个 OAuth 客户端设为受信任。如果 403 错误提到 AI 智能体客户端设置，说明客户端没有打开这个选项。
:::

::: audience member
## 连接你的 Google 账号

选择**连接**，在 Google 的同意屏幕上登录。**保持所有勾选框都勾上**：Google 允许取消单项权限，需要被取消权限的工具随后会失败并返回 Google 的 insufficient-scope 错误。要修复，请断开连接后重新连接，并勾上所有勾选框。

之后智能体以你的身份操作 Google 幻灯片，写操作会先询问你（除非管理员改了设置）。

**断开连接**会删除 Capybara 里的令牌。如果还要在 Google 上撤销，打开 **Google 账号 → 安全 → 你与第三方应用和服务的关联**，移除这个应用。

::check capybara:connector-connected 你的 Google 账号已连接
:::
