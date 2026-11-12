# 设置 GitHub 连接器

GitHub 连接器让智能体**以使用者本人的身份**处理 issue、拉取请求、评审、仓库文件和 Actions 运行，经由
GitHub 的远程 MCP 服务器。每位成员连接自己的 GitHub 账号，所以智能体只能看到和修改这个人能看到和修改的
内容，GitHub 的审计日志里记的也是这个人。

::: audience admin
组织管理员只需设置一次：在 GitHub 上注册一个应用，再把它的 client id 和 secret 填到这里。之后成员各自连接。

## 1. 注册 GitHub App（推荐）

GitHub App 发给成员的令牌只有下面列出的权限，只能访问安装了这个应用的仓库，并且八小时后过期（Capybara
会自动刷新）。

打开存放仓库的 GitHub 组织的 **Settings → Developer settings → GitHub Apps → New GitHub App**
（`https://github.com/organizations/<org>/settings/apps/new`），按下面填写，未列出的项保持默认。

```yaml title="GitHub App 设置（GitHub 连接器）"
# GitHub App for the "{{templateName}}" connector template ({{pluginName}} {{pluginVersion}}).
# Reference: https://docs.github.com/apps/creating-github-apps (checked 2026-11-12).
GitHub App name: "Capybara connector"
Homepage URL: "{{publicUrl}}"
Callback URL: "{{oauthCallbackUrl}}"
Expire user authorization tokens: on
Request user authorization (OAuth) during installation: off
Enable Device Flow: off
Webhook Active: off
Repository permissions:
  Actions: Read and write        # read runs and logs, re-run workflows
  Checks: Read-only
  Commit statuses: Read-only
  Contents: Read and write       # files, branches, commits, merges
  Issues: Read and write
  Metadata: Read-only            # mandatory
  Pull requests: Read and write
  Workflows: Read and write      # change files under .github/workflows
Organization permissions:
  Members: Read-only             # teams
Account permissions:
  Email addresses: Read-only
Where can this GitHub App be installed: Only on this account
```

::check capybara:public-url 平台有公网地址

然后在组织上 **Install App**，选择全部仓库或允许智能体操作的那些仓库。成员令牌的范围永远不会超出成员本人的
权限与这次安装的交集。

### 改用 OAuth App

也可以用 OAuth App（**Settings → Developer settings → OAuth Apps → New OAuth App**，授权回调地址填
`{{oauthCallbackUrl}}`）。它的令牌不会过期，带着本模板申请的经典 scope（`repo`、`read:org`、`read:user`、
`user:email`、`workflow`），覆盖成员能访问的所有仓库。如果组织限制了 OAuth App 访问，需要组织所有者在
**Settings → Third-party access** 里批准这个应用。

## 2. 填写客户端

复制应用的 **Client ID**，生成一个 **client secret**，把两者填到下面的字段里。secret 加密保存，之后只显示「已设置」。

::check capybara:oauth-client 已填写 client id 和 secret
::check capybara:oauth-token-endpoint GitHub 接受这个 client id 和 secret
::check capybara:connector-tools 已有成员连接并读到工具列表

## 工具与审批

本模板开启 GitHub 的 `context`、`repos`、`issues`、`pull_requests`、`users` 和 `actions` 工具集（端点请求头
`X-MCP-Toolsets`，可编辑以增减工具集）。读取类操作直接执行；写入（创建 issue 和拉取请求、评论与评审、合并、
推送文件、创建分支、重新运行工作流）会先征求成员同意；删除仓库默认禁止。每个工具的策略都可以在连接器页面单独修改。

使用带数据驻留的 GitHub Enterprise Cloud 时，把端点地址改为
`https://copilot-api.<your-subdomain>.ghe.com/mcp`，并在那个域名上注册应用。
:::

::: audience member
## 连接你的 GitHub 账号

选择**连接**，在 GitHub 的授权页面上同意。之后智能体以你的身份操作 GitHub，写入操作会先问你（除非管理员改了
设置）。智能体只能看到你能看到的仓库；使用 GitHub App 时，还只限于安装了这个应用的仓库。

**断开连接**会删除 Capybara 里的令牌。如果还要在 GitHub 上吊销，打开 **Settings → Applications →
Authorized GitHub Apps**（或 **Authorized OAuth Apps**）撤销这个应用。

::check capybara:connector-connected 你的 GitHub 账号已连接
:::
