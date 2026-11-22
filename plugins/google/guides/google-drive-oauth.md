# Set up the Google Drive connector

The Google Drive connector lets agents act **as the person using them** through Google's Drive MCP
server: they search, read and download files, create and copy files and upload new revisions. Each
member connects their own Google account, so an agent sees and changes only what that person can.

::: audience admin
An org admin sets it up once in the company's Google Cloud project, then enters the OAuth client
here. Members connect afterwards.

## 1. Before you start

Google offers the Drive MCP server as part of the Google Workspace Developer Preview Program. Both
the Workspace account and the Google Cloud project you use must be accepted into the program
([Google's preview page](https://developers.google.com/workspace/preview)), and its terms apply:
only people inside your company may use the connector.

## 2. Project and services

Use a Google Cloud project owned by your Google Workspace organization, ideally the one you use for
Sign in with Google. Enable the services in the **same project that holds the OAuth client** below,
replacing `PROJECT_ID` with the project's id:

```sh title="Enable the Google Drive services"
gcloud services enable drive.googleapis.com drivemcp.googleapis.com --project=PROJECT_ID
```

## 3. Consent screen

In **Google Auth Platform → Audience**, choose the user type **Internal**. An Internal app needs no
Google verification, even for restricted scopes such as Gmail's and Drive's, and its refresh tokens
do not expire after seven days. **External** works only for listed test users, whose refresh tokens
expire after seven days while the app is in Testing; an External app in production needs Google's
verification, and a CASA security assessment for restricted scopes.

## 4. OAuth client

Open **Google Auth Platform → Clients → Create client**, choose **Web application** and fill it in
as listed below. The scopes are the ones the connector asks each member for.

```yaml title="OAuth client (Google Drive connector)"
# OAuth client for the "{{templateName}}" connector template ({{pluginName}} {{pluginVersion}}).
# Reference: https://developers.google.com/workspace/guides/configure-mcp-servers (checked 2026-11-22).
Application type: Web application
Name: "Capybara connectors"
Authorized redirect URIs:
  - "{{oauthCallbackUrl}}"
Use this client for an AI-powered agent: on
Scopes requested:
  - https://www.googleapis.com/auth/drive.readonly
  - https://www.googleapis.com/auth/drive.file
```

Select **Use this client for an AI-powered agent**: Google blocks clients without it from its
Workspace MCP servers. Use a client **separate from your Sign in with Google client**, because
Google asks for a separate client when one also serves features other than an agent's, such as
sign-in. One such client can serve every Google connector of your org.

## 5. Enter the client

Copy the client's **Client ID** and **Client secret** into the fields below. The secret is stored
encrypted and reads back only as "set".

::check capybara:oauth-client The client id and secret are entered
::check capybara:oauth-token-endpoint Google accepts the client id and secret
::check capybara:connector-tools A member connected and the tool list was read

## Tools and approvals

Reads run directly. Writes (`copy_file`, `create_file` and `upload_file_revision`) ask the member
first. Change any of these per tool on the connector page. The `drive.file` scope covers only files
the connector created or opened, so a write to any other file fails with Google's permission error.

## If calls are refused

A Workspace admin may restrict third-party access to Google APIs (**Admin console → Security →
Access and data control → API controls**); mark this OAuth client as trusted there. A 403 error that
names the AI-powered agent setting means the client does not have it selected.
:::

::: audience member
## Connect your Google account

Choose **Connect** and sign in on Google's consent screen. **Keep every box ticked**: Google lets
you untick single permissions, and the tools that need an unticked one then fail with Google's
insufficient-scope error. To fix that, disconnect, connect again and tick every box.

Agents then act in Google Drive as you, and writes ask you first unless your admin changed that.

**Disconnect** deletes the token in Capybara. To revoke it at Google too, open **Google Account →
Security → Your connections to third-party apps & services** and remove the app.

::check capybara:connector-connected Your Google account is connected
:::
