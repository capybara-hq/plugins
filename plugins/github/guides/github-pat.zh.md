# 用个人访问令牌设置 GitHub 连接器

本模板给智能体的 GitHub 工具和 **GitHub** 模板相同，区别是每位成员粘贴自己的个人访问令牌，而不是用 OAuth
连接。智能体以这位成员的身份操作 GitHub，能做什么由令牌决定。

::: audience admin
本模板默认关闭。只在允许个人访问令牌的组织里打开：令牌由成员自己创建、自己决定范围，经典令牌能访问成员能
访问的所有仓库。能用 **GitHub** 模板（GitHub App）时优先用它。

如果 GitHub 组织要求审批细粒度令牌，需要组织所有者在 **Settings → Personal access tokens → Pending
requests** 里批准每位成员的令牌。要禁止经典令牌，设置 **Settings → Personal access tokens → Restrict access
via personal access tokens (classic)**。

和 **GitHub** 模板一样：读取直接执行，写入先征求成员同意，删除仓库默认禁止。

::check capybara:connector-tools 已有成员连接并读到工具列表
:::

::: audience member
## 创建令牌

在 GitHub 上打开 **Settings → Developer settings → Personal access tokens → Fine-grained tokens →
Generate new token**（`https://github.com/settings/personal-access-tokens/new`），按下面选择：

```yaml title="细粒度令牌（GitHub 连接器）"
# Personal access token for the "{{templateName}}" connector template ({{pluginName}} {{pluginVersion}}).
# Reference: https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens (checked 2026-11-12).
Resource owner: (your account or the organization that owns the repositories)
Expiration: 90 days or less
Repository access: Only select repositories
Repository permissions:
  Actions: Read and write
  Commit statuses: Read-only
  Contents: Read and write
  Issues: Read and write
  Metadata: Read-only
  Pull requests: Read and write
  Workflows: Read and write   # only to change files under .github/workflows
Organization permissions:
  Members: Read-only
```

细粒度令牌没有 Checks 权限；CI 状态由 Actions 和 Commit statuses 覆盖。
也可以用经典令牌（scope 为 `repo`、`read:org`、`read:user`、`user:email`、`workflow`）；这时 GitHub 会隐藏
令牌 scope 覆盖不到的工具。

## 连接

在**连接**里粘贴令牌。令牌加密保存，之后不再显示。过期后用新令牌重新连接。**断开连接**会删除 Capybara 里的
令牌；不再需要时也请在 GitHub 上删除它。

::check capybara:connector-connected 你的 GitHub 令牌已连接
:::
