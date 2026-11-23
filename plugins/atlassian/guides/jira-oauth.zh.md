# 设置 Jira 连接器

Jira 连接器让智能体经由 Atlassian 的远程 MCP 服务器、**以使用者本人的身份**读取、搜索和更新 Jira 工作项、评论、工时记录、看板和冲刺（仅限 Atlassian
Cloud；Data Center 和 Server 没有远程 MCP 服务器）。每位成员连接自己的 Atlassian 账号，所以智能体只能看到和
修改这个人能看到和修改的内容，Atlassian 的审计日志里记的也是这个人。

::: audience admin
这里不需要填写任何内容。安装连接器时，Capybara 会自动向 Atlassian 注册自己的 OAuth 客户端（动态客户端注册），
无需创建 client id 或 secret。每位成员的令牌只带 Jira 的 scope（`read:jira:agent-interface`, `write:jira:agent-interface`, `search:jira:agent-interface`）以及 `read:me`、`read:account`
和 `offline_access`，访问不到其他 Atlassian 应用。

## 1. 公网地址

Atlassian 会把成员送回平台的 OAuth 回调地址，所以平台需要有公网地址。

::check capybara:public-url 平台有公网地址

## 2. 在 Atlassian 组织里允许 Capybara

Atlassian 默认只允许它自己列出的 AI 工具接收 OAuth 回跳，Capybara 部署不在其中。需要由 **Atlassian 组织管理员**
把回调地址添加为域名规则；每个有成员要连接的 Atlassian 组织做一次：

```yaml title="Atlassian MCP 服务器域名（Jira 连接器）"
# Atlassian MCP server domain rule for the "{{templateName}}" connector template ({{pluginName}} {{pluginVersion}}).
# Reference: https://support.atlassian.com/security-and-access-policies/docs/control-atlassian-rovo-mcp-server-settings/ (checked 2026-11-23).
Where: "Atlassian Administration > Connectors > Atlassian MCP server > Add domain"
Domain: "{{oauthCallbackUrl}}"
```

如果你的 Atlassian 组织启用了 IP 白名单，它同样作用于工具调用：请为 Jira 放行本 Capybara 部署的出口地址，否则即使
连接成功，调用也会因 IP 地址被拒绝而失败。

## 3. 检查

::check capybara:connector-tools 已有成员连接并读到工具列表

## 工具与审批

连接器使用 Atlassian 的平铺工具列表（端点上的 `?tools=all`），所以每个工具都有自己的策略。读取和搜索（工作项、JQL 搜索、评论、看板、冲刺、用户）直接执行。写入（创建、编辑和流转工作项，评论、工时记录、链接、冲刺、版本、看板、附件）会先征求成员同意。每个工具的策略都可以在连接器页面单独修改。本模板不申请 Atlassian 的 `delete:jira:agent-interface` 和 `manage:jira:agent-interface` scope，所以即使 Atlassian 管理员开启了这些权限组，删除工作项以及修改空间、工作流和界面的工具也不可用。
:::

::: audience member
## 连接你的 Atlassian 账号

选择**连接**，登录 Atlassian 并在授权页面上同意。如果你属于多个 Atlassian 站点，请选择智能体要工作的那个：Atlassian 通常只为
你选择的站点授予令牌。如果 Atlassian 拒绝回跳，请联系你的 Atlassian 组织管理员，把本平台的回调地址加入 Atlassian MCP 服务器的域名列表。

之后智能体以你的身份操作 Jira，写入操作会先问你（除非管理员改了设置）。

**断开连接**会删除 Capybara 里的令牌。如果还要在 Atlassian 上撤销，打开 Atlassian 账号的 **Connected apps**
（`https://id.atlassian.com/manage-profile/apps`）移除这个应用。

::check capybara:connector-connected 你的 Atlassian 账号已连接
:::
