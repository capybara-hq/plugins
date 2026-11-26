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

5. 在本页的「登录」分区打开「在登录页显示」（也可以让智能体调用 `login-sources.update`）。如果希望 Slack
   登录能并入邮箱相同且已验证的现有账号，在同一分区的「可信租户」里填写工作区 ID（`T…` 开头的 ID，例如
   `T0123ABCD`）。

默认情况下，Slack 账号还没有绑定账号的人第一次登录时会进入绑定页，用用户名和密码登录后完成绑定；如果希望
直接为他们创建新账号，在同一分区的「未绑定的账号」里选择「自动注册新账号」。

重定向 URL 无法自动检查：如果登录时 Slack 提示 `redirect_uri` 不匹配，请把应用里的重定向 URL 与上面的逐字比对。
