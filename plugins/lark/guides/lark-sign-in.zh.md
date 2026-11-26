# 设置飞书 Lark 登录

{{pluginName}} 会在登录页加上 **Lark** 按钮。成员通过 Lark 网页授权（带 PKCE 的 OAuth 授权码）用自己的
Lark 账号登录。登录只会创建或进入账号；组织成员身份仍来自邀请或通讯录同步。

> **请使用与机器人、通讯录同步相同的自建应用。** 同一个人在不同应用里的 `open_id` 不同，换一个应用会让
> 一个人变成两个账号；同一租户的机器人连接或通讯录同步如果用了别的应用，插件会拒绝。登录应用只能有一个，
> 所以 Lark 登录只服务于该应用所属的租户。

1. 在 [开发者后台](https://open.larksuite.com/app)（Developer Console）打开机器人使用的自建应用，或新建
   一个。在 **凭证与基础信息**（Credentials & Basic Info）找到 App ID（`cli_…`）和 App Secret。
2. 在 **开发配置 → 安全设置 → 重定向 URL**（Development Config → Security Settings → Redirect URLs）原样
   添加这个地址；Lark 会严格比对：

```text title="重定向 URL"
{{signInCallbackUrl}}
```

3. 在 **权限管理**（Permissions & Scopes）确认已开通 `tenant:tenant:readonly`（机器人也需要它）：平台会
   核对每个人属于该应用自己的租户。登录不申请任何权限范围，因此不需要开通别的；只有应用有权读取邮箱时才会
   带上邮箱。
4. 发布一个版本，其 **可用范围** 包含所有要登录的人。不在范围内的人无法登录（Lark 返回 20010）。
5. 在本页把 App ID 填入 **应用 ID**（`appId`），把 App Secret 填入 **应用密钥**（`appSecret`）。保存。

::check capybara:public-url 平台已设置公网地址

6. 在本页的「登录」分区打开「在登录页显示」（也可以让智能体调用 `login-sources.update`）。Lark 没有说明
   它的邮箱经过验证，所以即使租户 key 在「可信租户」里，Lark 登录也从不按邮箱并入现有账号。

默认情况下，Lark 账号还没有绑定账号的人第一次登录时会进入绑定页，用用户名和密码登录后完成绑定；如果希望
直接为他们创建新账号，在同一分区的「未绑定的账号」里选择「自动注册新账号」。已经通过机器人的绑定卡片关联过
Lark 身份的人，第一次登录时也这样确认一次，之后直接登录到那个账号。

重定向 URL 无法自动检查：如果登录时 Lark 拒绝重定向 URL（换取 token 时返回 20071），请把应用里的重定向 URL
与上面的逐字比对。
