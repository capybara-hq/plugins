# Set up the GitHub connector

The GitHub connector lets agents read and work on issues, pull requests, reviews, repository
files and Actions runs **as the person using them**, through GitHub's remote MCP server. Each
member connects their own GitHub account, so an agent sees and changes only what that person can,
and GitHub's audit log names that person.

::: audience admin
An org admin sets it up once: register an app on GitHub, then enter its client id and secret here.
Members connect afterwards.

## 1. Register a GitHub App (recommended)

A GitHub App gives members tokens limited to the permissions below and to the repositories the
app is installed on, and the tokens expire after eight hours (Capybara refreshes them).

Open **Settings → Developer settings → GitHub Apps → New GitHub App** of the GitHub organization
that owns your repositories (`https://github.com/organizations/<org>/settings/apps/new`) and fill
in the form as listed below. Leave everything not listed at its default.

```yaml title="GitHub App settings (GitHub connector)"
# GitHub App for the "{{templateName}}" connector template ({{pluginName}} {{pluginVersion}}).
# Reference: https://docs.github.com/apps/creating-github-apps (checked 2026-11-12).
GitHub App name: "Capybara connector"
Homepage URL: "{{publicUrl}}"
Callback URL: "{{oauthCallbackUrl}}"
Expire user authorization tokens: on
Request user authorization (OAuth) during installation: off
Enable Device Flow: off
Webhook Active: off
Repository permissions:
  Actions: Read and write        # read runs and logs, re-run workflows
  Checks: Read-only
  Commit statuses: Read-only
  Contents: Read and write       # files, branches, commits, merges
  Issues: Read and write
  Metadata: Read-only            # mandatory
  Pull requests: Read and write
  Workflows: Read and write      # change files under .github/workflows
Organization permissions:
  Members: Read-only             # teams
Account permissions:
  Email addresses: Read-only
Where can this GitHub App be installed: Only on this account
```

::check capybara:public-url The platform has a public URL

Then **Install App** on the organization, for all repositories or the ones agents may touch. A
member's token never reaches further than both the member's own access and this installation.

### An OAuth App instead

An OAuth App (**Settings → Developer settings → OAuth Apps → New OAuth App**, authorization
callback URL `{{oauthCallbackUrl}}`) also works. Its tokens do not expire and carry the classic
scopes this template asks for (`repo`, `read:org`, `read:user`, `user:email`, `workflow`) across
every repository the member can reach. If the organization restricts OAuth App access, an owner
approves the app under **Settings → Third-party access**.

## 2. Enter the client

Copy the app's **Client ID**, generate a **client secret**, and enter both in the fields below. The
secret is stored encrypted and reads back only as "set".

::check capybara:oauth-client The client id and secret are entered
::check capybara:oauth-token-endpoint GitHub accepts the client id and secret
::check capybara:connector-tools A member connected and the tool list was read

## Tools and approvals

The template turns on GitHub's `context`, `repos`, `issues`, `pull_requests`, `users` and
`actions` toolsets (the endpoint header `X-MCP-Toolsets`; edit it to add or remove toolsets).
Reads run directly. Writes (creating issues and pull requests, comments and reviews, merging,
pushing files, creating branches, re-running workflows) ask the member first, and deleting a
repository is denied. Change any of these per tool on the connector page.

For GitHub Enterprise Cloud with data residency, change the endpoint URL to
`https://copilot-api.<your-subdomain>.ghe.com/mcp` and register the app on that host.
:::

::: audience member
## Connect your GitHub account

Choose **Connect** and approve on GitHub's consent screen. Agents then act on GitHub as you, and
writes ask you first unless your admin changed that. An agent sees only the repositories you can
see and, with a GitHub App, only those the app is installed on.

**Disconnect** deletes the token in Capybara. To revoke it at GitHub too, open
**Settings → Applications → Authorized GitHub Apps** (or **Authorized OAuth Apps**) and revoke
the app.

::check capybara:connector-connected Your GitHub account is connected
:::
