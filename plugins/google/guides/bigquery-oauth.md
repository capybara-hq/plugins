# Set up the BigQuery connector

The BigQuery connector lets agents act **as the person using them** through Google's BigQuery MCP
server: they explore datasets and tables and run SQL in the Google Cloud projects they can use. Each
member connects their own Google account, so an agent sees and changes only what that person can.

::: audience admin
An org admin sets it up once in the company's Google Cloud project, then enters the OAuth client
here. Members connect afterwards.

## 1. Before you start

Google's documentation gives the BigQuery MCP server no preview label (checked 2026-11-22). Members
need BigQuery roles in the projects they query (see "BigQuery roles" below).

## 2. Project and services

Use a Google Cloud project owned by your Google Workspace organization, ideally the one you use for
Sign in with Google. Enable the services in the **same project that holds the OAuth client** below,
replacing `PROJECT_ID` with the project's id:

```sh title="Enable the BigQuery services"
gcloud services enable bigquery.googleapis.com --project=PROJECT_ID
```

Enabling the BigQuery API also enables its MCP server, and new projects have the API on already.
Enabling a service needs the Service Usage Admin role (`roles/serviceusage.serviceUsageAdmin`).

## 3. Consent screen

In **Google Auth Platform → Audience**, choose the user type **Internal**. An Internal app needs no
Google verification, even for restricted scopes such as Gmail's and Drive's, and its refresh tokens
do not expire after seven days. **External** works only for listed test users, whose refresh tokens
expire after seven days while the app is in Testing; an External app in production needs Google's
verification, and a CASA security assessment for restricted scopes.

## 4. OAuth client

Open **Google Auth Platform → Clients → Create client**, choose **Web application** and fill it in
as listed below. The scopes are the ones the connector asks each member for.

```yaml title="OAuth client (BigQuery connector)"
# OAuth client for the "{{templateName}}" connector template ({{pluginName}} {{pluginVersion}}).
# Reference: https://docs.cloud.google.com/bigquery/docs/use-bigquery-mcp (checked 2026-11-22).
Application type: Web application
Name: "Capybara connectors"
Authorized redirect URIs:
  - "{{oauthCallbackUrl}}"
Use this client for an AI-powered agent: on
Scopes requested:
  - https://www.googleapis.com/auth/bigquery
```

Select **Use this client for an AI-powered agent**: Google blocks clients without it from its
Workspace MCP servers, and with it the same client serves the Workspace connectors too. Use a client
**separate from your Sign in with Google client**, because Google asks for a separate client when
one also serves features other than an agent's, such as sign-in. One such client can serve every
Google connector of your org.

## 5. Enter the client

Copy the client's **Client ID** and **Client secret** into the fields below. The secret is stored
encrypted and reads back only as "set".

::check capybara:oauth-client The client id and secret are entered
::check capybara:oauth-token-endpoint Google accepts the client id and secret
::check capybara:connector-tools A member connected and the tool list was read

## Tools and approvals

Reads run directly. Writes (`execute_sql` and `cancel_job`) ask the member first. Change any of
these per tool on the connector page. Read-only queries (`execute_sql_readonly`) run without asking,
and BigQuery bills the bytes they scan to the project they run in: set BigQuery's custom query
quotas on projects where that matters.

## BigQuery roles

Grant each member `roles/mcp.toolUser`, `roles/bigquery.jobUser` and `roles/bigquery.dataViewer` on
the projects they query. Every BigQuery tool takes a `projectId`, so tell the agent which project to
use.

## If calls are refused

A Workspace admin may restrict third-party access to Google APIs (**Admin console → Security →
Access and data control → API controls**); mark this OAuth client as trusted there. A 403 error that
names a BigQuery permission means the member lacks one of the roles above in the project the agent
named.
:::

::: audience member
## Connect your Google account

Choose **Connect** and sign in on Google's consent screen. **Keep every box ticked**: Google lets
you untick single permissions, and the tools that need an unticked one then fail with Google's
insufficient-scope error. To fix that, disconnect, connect again and tick every box.

Agents then act in BigQuery as you, and writes ask you first unless your admin changed that.

**Disconnect** deletes the token in Capybara. To revoke it at Google too, open **Google Account →
Security → Your connections to third-party apps & services** and remove the app.

::check capybara:connector-connected Your Google account is connected
:::
