# Set up Sign in with Google

{{pluginName}} adds a **Google** button to the login page. People sign in with their Google
Workspace account; the platform checks the account's hosted domain on the ID token Google signs,
never on what the browser sends.

1. In the [Google Cloud console](https://console.cloud.google.com/), pick or create a project. For
   a single Workspace, use a project owned by your Workspace organization.
2. Open **Google Auth Platform → Branding** and **Audience**. Choose the user type **Internal** when
   only your own Workspace signs in; choose **External** when consumer accounts or several
   Workspace domains must sign in. The scopes `openid email profile` need no app verification
   either way.
3. Open **Google Auth Platform → Clients → Create client**, application type **Web application**,
   and add this authorized redirect URI exactly:

   ```text title="Authorized redirect URI"
   {{publicUrl}}/api/v1/auth/sso/google/callback
   ```

4. On this page, paste the client ID into **Client ID** (`clientId`) and the client secret into
   **Client secret** (`clientSecret`). List your Workspace domains in **Allowed Google Workspace
   domains** (`allowedDomains`; recommended), or leave it empty to admit any Workspace domain and
   decide whether consumer accounts may sign in (`allowConsumerAccounts`, off by default). Save.

::check google-discovery Google's sign-in endpoints match the plugin
::check google-client Google accepts the client ID and secret

5. In the platform settings, add `google` to `auth.loginSources`. To let a Google sign-in join an
   existing account with the same verified email, also add `google:<your domain>` (for example
   `google:example.com`) to `auth.trustedIdentitySources`.

> **Never add `google:consumer` to `auth.trustedIdentitySources`.** Anyone can create a Google
> account on any email address; trusting consumer accounts would let a stranger take over an
> existing account.

The redirect URI cannot be checked automatically: if Google shows `redirect_uri_mismatch` at login,
compare the client's redirect URI with the one above character by character.
