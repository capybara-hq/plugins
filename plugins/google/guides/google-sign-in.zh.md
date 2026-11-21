# 设置使用 Google 登录

{{pluginName}} 会在登录页加上 **Google** 按钮。成员用自己的 Google Workspace 账号登录；平台在 Google
签名的 ID token 上检查账号的托管域，从不依据浏览器发来的内容。

1. 在 [Google Cloud 控制台](https://console.cloud.google.com/) 选择或新建一个项目。只有一个 Workspace
   时，请使用归属于你的 Workspace 组织的项目。
2. 打开 **Google Auth Platform → 品牌塑造** 和 **目标对象**。只有自己的 Workspace 登录时选择用户类型
   **内部**；需要个人账号或多个 Workspace 域登录时选择 **外部**。两种情况下 `openid email profile`
   这几个范围都不需要应用验证。
3. 打开 **Google Auth Platform → 客户端 → 创建客户端**，应用类型选 **Web 应用**，并原样添加这个已获授权的
   重定向 URI：

   ```text title="已获授权的重定向 URI"
   {{publicUrl}}/api/v1/auth/sso/google/callback
   ```

4. 在本页把客户端 ID 填入 **客户端 ID**（`clientId`），把客户端密钥填入 **客户端密钥**（`clientSecret`）。
   在 **允许的 Google Workspace 域**（`allowedDomains`，推荐填写）里列出你的 Workspace 域；或者留空，允许
   任何 Workspace 域登录，并决定是否允许个人账号登录（`allowConsumerAccounts`，默认关闭）。保存。

::check google-discovery Google 的登录端点与插件一致
::check google-client Google 接受这个客户端 ID 和密钥

5. 在平台设置里把 `google` 加入 `auth.loginSources`。如果希望 Google 登录能并入邮箱相同且已验证的现有账号，
   再把 `google:<你的域>`（例如 `google:example.com`）加入 `auth.trustedIdentitySources`。

> **不要把 `google:consumer` 加入 `auth.trustedIdentitySources`。** 任何人都能用任意邮箱地址注册 Google
> 账号；信任个人账号会让陌生人接管现有账号。

重定向 URI 无法自动检查：如果登录时 Google 显示 `redirect_uri_mismatch`，请把客户端里的重定向 URI 与上面的
逐字比对。
