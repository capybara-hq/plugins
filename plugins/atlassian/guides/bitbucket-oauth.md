# Set up the Bitbucket connector

The Bitbucket connector lets agents read Bitbucket Cloud repositories, pull requests, pipelines and deployments, and create, review and merge pull requests **as the person using them**, through Atlassian's
remote MCP server (Atlassian Cloud only; Data Center and Server have no remote MCP server). Each
member connects their own Atlassian account, so an agent sees and changes only what that person
can, and Atlassian's audit log names that person.

::: audience admin
There is nothing to enter here. When the connector is installed, Capybara registers its own OAuth
client with Atlassian (dynamic client registration), so no client id or secret has to be created.
Each member's token carries only the Bitbucket scopes (`read:bitbucket:agent-interface`, `write:bitbucket:agent-interface`) plus `read:me`, `read:account`
and `offline_access`, so it cannot reach other Atlassian apps.

## 1. Public URL

Atlassian sends members back to the platform's OAuth callback, so the platform needs a public URL.

::check capybara:public-url The platform has a public URL

## 2. Allow Capybara in your Atlassian organization

By default Atlassian lets only its own list of supported AI tools receive OAuth redirects, and a
Capybara deployment is not on it. An **Atlassian organization admin** adds the callback URL as a
domain rule, once per Atlassian organization whose members connect:

```yaml title="Atlassian MCP server domain (Bitbucket connector)"
# Atlassian MCP server domain rule for the "{{templateName}}" connector template ({{pluginName}} {{pluginVersion}}).
# Reference: https://support.atlassian.com/security-and-access-policies/docs/control-atlassian-rovo-mcp-server-settings/ (checked 2026-11-23).
Where: "Atlassian Administration > Connectors > Atlassian MCP server > Add domain"
Domain: "{{oauthCallbackUrl}}"
```

If your Atlassian organization uses IP allowlisting, its rules also apply to tool calls: allow the
outbound address of this Capybara deployment for Bitbucket, or calls fail with an IP address error even
though connecting worked.

## Bitbucket prerequisites and status

The template is **off by default**. Atlassian's MCP server offers the Bitbucket tools only for a
Bitbucket Cloud workspace that is **linked to an Atlassian organization**; link it first
(Bitbucket workspace settings, or Atlassian Administration). Atlassian's documentation is not
consistent on whether the Bitbucket tools accept OAuth or only an API token, and this template
has not been confirmed against a live workspace yet. Switch it on, connect one account and check
that the tool list shows Bitbucket tools before you announce it to members. Capybara does not
support Atlassian's API token sign-in yet.

## 3. Check

::check capybara:connector-tools A member connected and the tool list was read

## Tools and approvals

The connector uses Atlassian's flat tool list (`?tools=all` on the endpoint), so every tool has its
own policy. Reads (workspaces, repositories, files, commits, pull requests and their diffs and comments, pipelines and step logs, deployments) run directly. Writes (creating, updating, approving and merging pull requests, comments and tasks, creating branches and commits, running pipelines) ask the member first. Change any of these per tool on the connector page.
:::

::: audience member
## Connect your Atlassian account

Choose **Connect**, sign in to Atlassian and approve the consent screen. If you belong to several
Atlassian sites, pick the one agents should work in: Atlassian usually grants the token for the site you choose.
If Atlassian refuses the redirect, ask your Atlassian organization admin to add this platform's
callback URL to the Atlassian MCP server domains.

Agents then act in Bitbucket as you, and writes ask you first unless your admin changed that.

**Disconnect** deletes the token in Capybara. To revoke it at Atlassian too, open your Atlassian
account's **Connected apps** (`https://id.atlassian.com/manage-profile/apps`) and remove the app.

::check capybara:connector-connected Your Atlassian account is connected
:::
