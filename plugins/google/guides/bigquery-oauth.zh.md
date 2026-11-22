# 设置 BigQuery 连接器

BigQuery 连接器让智能体经由 Google 的 BigQuery MCP 服务器、**以使用者本人的身份**浏览数据集和表，并在本人有权使用的 Google Cloud 项目中运行 SQL。每位成员连接自己的 Google 账号，所以智能体只能看到和修改这个人能看到和修改的内容。

::: audience admin
组织管理员只需在公司的 Google Cloud 项目里设置一次，再把 OAuth 客户端填到这里。之后成员各自连接。

## 1. 开始之前

Google 的文档没有给 BigQuery MCP 服务器标注预览阶段（2026-11-22 查阅）。成员需要在要查询的项目中拥有 BigQuery 角色（见下面的“BigQuery 角色”）。

## 2. 项目和服务

使用你的 Google Workspace 组织拥有的 Google Cloud 项目，最好就是 Sign in with Google 用的那个。在**存放下方 OAuth 客户端的同一个项目**里启用这些服务，把 `PROJECT_ID` 换成项目的 id：

```sh title="启用 BigQuery 的服务"
gcloud services enable bigquery.googleapis.com --project=PROJECT_ID
```

启用 BigQuery API 也就启用了它的 MCP 服务器，新项目默认已经启用该 API。启用服务需要 Service Usage Admin 角色（`roles/serviceusage.serviceUsageAdmin`）。

## 3. 同意屏幕

在 **Google Auth Platform → Audience** 里选择用户类型 **Internal**。Internal 应用不需要 Google 验证（即使是 Gmail 和云端硬盘这样的受限 scope），刷新令牌也不会在七天后过期。**External** 只能给列出的测试用户使用，应用处于 Testing 状态时他们的刷新令牌七天后过期；正式发布的 External 应用需要通过 Google 验证，受限 scope 还需要 CASA 安全评估。

## 4. OAuth 客户端

打开 **Google Auth Platform → Clients → Create client**，选择 **Web application**，按下面填写。其中的 scope 就是连接器向每位成员申请的权限。

```yaml title="OAuth 客户端（BigQuery 连接器）"
# OAuth client for the "{{templateName}}" connector template ({{pluginName}} {{pluginVersion}}).
# Reference: https://docs.cloud.google.com/bigquery/docs/use-bigquery-mcp (checked 2026-11-22).
Application type: Web application
Name: "Capybara connectors"
Authorized redirect URIs:
  - "{{oauthCallbackUrl}}"
Use this client for an AI-powered agent: on
Scopes requested:
  - https://www.googleapis.com/auth/bigquery
```

务必打开上面列出的 AI 智能体客户端选项：没有打开这个选项的客户端会被 Google 拒绝访问 Workspace MCP 服务器，打开后同一个客户端也能供 Workspace 连接器使用。请使用一个**与 Sign in with Google 客户端分开**的客户端：如果一个客户端还用于登录等不属于智能体的功能，Google 要求另建一个。一个这样的客户端可以供组织里所有 Google 连接器使用。

创建表单里没有 scope 字段：成员连接时由连接器申请上面列出的 scope。也可以在 **Google Auth Platform → Data Access** 里添加它们（External 应用必须添加）。

## 5. 填写客户端

把客户端的 **Client ID** 和 **Client secret** 填到下面的字段里。secret 加密保存，读回时只显示“已设置”。

::check capybara:oauth-client 已填写 client id 和 secret
::check capybara:oauth-token-endpoint Google 接受这个 client id 和 secret
::check capybara:connector-tools 已有成员连接并读取了工具列表

## 工具和审批

读操作直接执行。写操作（`execute_sql`、`cancel_job`）会先询问成员。可以在连接器页面逐个工具修改。只读查询（`execute_sql_readonly`）不经询问直接运行，BigQuery 会按扫描的字节数向查询所在的项目计费：在需要控制费用的项目上设置 BigQuery 的自定义查询配额。

## BigQuery 角色

为每位成员在其要查询的项目上授予 `roles/mcp.toolUser`、`roles/bigquery.jobUser` 和 `roles/bigquery.dataViewer`。每个 BigQuery 工具都需要一个 `projectId`，请告诉智能体使用哪个项目。

## 调用被拒绝时

Workspace 管理员可能限制了第三方对 Google API 的访问（**Admin console → Security → Access and data control → API controls**）；请在那里把这个 OAuth 客户端设为受信任。如果 403 错误提到某项 BigQuery 权限，说明成员在智能体指定的项目里缺少上面列出的某个角色。
:::

::: audience member
## 连接你的 Google 账号

选择**连接**，在 Google 的同意屏幕上登录。**保持所有勾选框都勾上**：Google 允许取消单项权限，需要被取消权限的工具随后会失败并返回 Google 的 insufficient-scope 错误。要修复，请断开连接后重新连接，并勾上所有勾选框。

之后智能体以你的身份操作 BigQuery，写操作会先询问你（除非管理员改了设置）。

**断开连接**会删除 Capybara 里的令牌。如果还要在 Google 上撤销，打开 **Google 账号 → 安全 → 你与第三方应用和服务的关联**，移除这个应用。这会同时移除你所有使用同一客户端的 Google 连接器的访问权限：仍要使用的连接器请重新连接。

::check capybara:connector-connected 你的 Google 账号已连接
:::
