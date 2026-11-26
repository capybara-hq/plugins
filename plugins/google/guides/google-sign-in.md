# Set up Sign in with Google

{{pluginName}} adds a **Google** button to the login page. People sign in with their Google
Workspace account; the platform checks the account's hosted domain on the ID token Google signs,
never on what the browser sends.

1. In the [Google Cloud console](https://console.cloud.google.com/), pick or create a project. For
   a single Workspace, use a project owned by your Workspace organization.
2. Open **Google Auth Platform → Branding** and **Audience**. Choose the user type **Internal** when
   only your own Workspace signs in; choose **External** when consumer accounts or several
   Workspace domains must sign in. The scopes `openid email profile` need no app verification
   either way. An External app starts in **Testing**, where only listed test users can sign in:
   open **Audience → Publish app** so its status is **In production**.
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

5. In the **Sign-in** section of this page, turn on **Show on the login page** (or ask the agent
   to call `login-sources.update`). To let a Google sign-in join an existing account with the same
   verified email, add your primary domain (for example `example.com`) under **Trusted tenants** in
   the same section.

> **Consumer accounts (`google:consumer`) can never be trusted**, and the section refuses
> `consumer`: anyone can create a Google account on any email address, and Google vouches only for
> `@gmail.com` addresses there; trusting the whole consumer tenant would buy nothing and widen what
> a stranger could try.

By default, a person whose Google account is not linked to an account yet goes to the link page on
their first sign-in and links it by signing in with their username and password; to create a new
account for them instead, choose **Create a new account** under **Unlinked accounts** in the same
section.

The redirect URI cannot be checked automatically: if Google shows `redirect_uri_mismatch` at login,
compare the client's redirect URI with the one above character by character. If Google answers
`access_denied` for everyone outside a few people, the External app is still in Testing.
