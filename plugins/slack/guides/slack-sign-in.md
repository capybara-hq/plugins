# Set up Sign in with Slack

{{pluginName}} adds a **Slack** button to the login page. People sign in with their Slack account
through OpenID Connect; the platform verifies the ID token Slack signs. Signing in only creates or
opens an account: people of any Slack workspace can complete it, and org membership still comes
from invitations or directory sync.

You can use the Slack app you created for the bot or a separate one: the identity is the Slack
workspace id and user id, the same for every app in that workspace.

1. Open <https://api.slack.com/apps> and pick the app, or choose **Create New App → From scratch**.
2. Open **OAuth & Permissions → Redirect URLs**, choose **Add New Redirect URL**, add this URL
   exactly and choose **Save URLs** (the app manifest of the bot's setup guide already lists it):

```text title="Redirect URL"
{{signInCallbackUrl}}
```

3. Do **not** add `openid`, `email` or `profile` under **Bot Token Scopes** or **User Token
   Scopes**. The sign-in flow requests these three itself, in a separate OAuth flow from installing
   the app; Slack does not accept them mixed with other scopes.
4. Open **Basic Information → App Credentials**. On this page, paste the Client ID into **Client
   ID** (`clientId`) and the Client Secret into **Client secret** (`clientSecret`). Save.

::check capybara:public-url The platform has a public URL

5. Add `slack` to the kernel config `auth.loginSources` (env `CAPYBARA_AUTH__LOGIN_SOURCES`), set
   where the deployment's config lives, not in the admin console. To let a Slack sign-in join an
   existing account with the same verified email, also add `slack:<workspace id>` (the `T…` id,
   for example `slack:T0123ABCD`) to `auth.trustedIdentitySources`.

The redirect URL cannot be checked automatically: if Slack reports that the `redirect_uri` does not
match at login, compare the app's redirect URL with the one above character by character.
