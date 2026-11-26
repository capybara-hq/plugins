# Set up Lark login

{{pluginName}} adds a **Lark** button to the login page. People sign in with their Lark account
through Lark's web authorization (OAuth authorization code with PKCE). Signing in only creates or
opens an account; org membership still comes from invitations or directory sync.

> **Use the same self-built app as the bot and directory sync.** Lark gives the same person a
> different `open_id` in each app, so another app turns one person into two accounts; the plugin
> refuses a bot connection or directory sync of the same tenant that uses another app. There is one
> login app, so Lark login serves only the tenant that app belongs to.

1. In the [Developer Console](https://open.larksuite.com/app) (开发者后台), open the enterprise
   self-built app the bot uses, or create one. Under **Credentials & Basic Info** (凭证与基础信息)
   find the App ID (`cli_…`) and App Secret.
2. Under **Development Config → Security Settings → Redirect URLs** (开发配置 → 安全设置 → 重定向
   URL), add this URL exactly; Lark compares it strictly:

```text title="Redirect URL"
{{signInCallbackUrl}}
```

3. Under **Permissions & Scopes** (权限管理), make sure `tenant:tenant:readonly` is enabled (the bot
   needs it too): the platform checks that each person belongs to the app's own tenant. Login
   requests no scope, so nothing else is needed; the email is filled in only when the app may read
   it.
4. Publish a version whose **availability scope** (可用范围) includes everyone who will sign in.
   People outside it cannot sign in (Lark answers 20010).
5. On this page, paste the App ID into **App ID** (`appId`) and the App Secret into **App secret**
   (`appSecret`). Save.

::check capybara:public-url The platform has a public URL

6. In the **Sign-in** section of this page, turn on **Show on the login page** (or ask the agent
   to call `login-sources.update`). Lark does not say its emails are verified, so a Lark sign-in
   never joins an existing account by email, even when the tenant key is under **Trusted tenants**.

By default, a person whose Lark account is not linked to an account yet goes to the link page on
their first sign-in and links it by signing in with their username and password; to create a new
account for them instead, choose **Create a new account** under **Unlinked accounts** in the same
section. A person who linked their Lark identity through the bot's binding card confirms it the
same way once, then signs in to that account.

The redirect URL cannot be checked automatically: if Lark refuses the redirect URL at login (20071
on the token exchange), compare the app's redirect URL with the one above character by character.
