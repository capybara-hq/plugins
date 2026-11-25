# 设置使用 Slack 登录

{{pluginName}} 会在登录页加上 **Slack** 按钮。成员用自己的 Slack 账号通过 OpenID Connect 登录；平台校验
Slack 签名的 ID token。登录只会创建或进入账号：任何 Slack 工作区的人都能完成登录，组织成员身份仍来自邀请或
通讯录同步。

可以沿用为机器人创建的 Slack 应用，也可以另建一个：身份由 Slack 工作区 ID 和用户 ID 确定，同一工作区内的
所有应用都一样。

1. 打开 <https://api.slack.com/apps> 选择这个应用，或选择 **Create New App → From scratch** 新建。
2. 打开 **OAuth & Permissions → Redirect URLs**，选择 **Add New Redirect URL**，原样添加这个地址，再选择
   **Save URLs**（机器人设置指南里的应用清单已经包含它）：

```text title="重定向 URL"
{{signInCallbackUrl}}
```

3. **不要**把 `openid`、`email`、`profile` 加到 **Bot Token Scopes** 或 **User Token Scopes**。登录流程会
   自己申请这三个范围，走的是与安装应用不同的另一个 OAuth 流程；Slack 不接受它们与其他范围混在一起。
4. 打开 **Basic Information → App Credentials**。在本页把 Client ID 填入 **客户端 ID**（`clientId`），把
   Client Secret 填入 **客户端密钥**（`clientSecret`）。保存。

::check capybara:public-url 平台已设置公网地址

5. 把 `slack` 加入内核配置 `auth.loginSources`（环境变量 `CAPYBARA_AUTH__LOGIN_SOURCES`），在部署的配置
   所在处设置，而不是在管理后台。如果希望 Slack 登录能并入邮箱相同且已验证的现有账号，再把
   `slack:<工作区 ID>`（`T…` 开头的 ID，例如 `slack:T0123ABCD`）加入 `auth.trustedIdentitySources`。

重定向 URL 无法自动检查：如果登录时 Slack 提示 `redirect_uri` 不匹配，请把应用里的重定向 URL 与上面的逐字比对。
