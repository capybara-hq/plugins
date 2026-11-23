# Set up the Confluence connector

The Confluence connector lets agents read, search, create and edit Confluence pages, blog posts, comments and spaces **as the person using them**, through Atlassian's
remote MCP server (Atlassian Cloud only; Data Center and Server have no remote MCP server). Each
member connects their own Atlassian account, so an agent sees and changes only what that person
can, and Atlassian's audit log names that person.

::: audience admin
There is nothing to enter here. When the connector is installed, Capybara registers its own OAuth
client with Atlassian (dynamic client registration), so no client id or secret has to be created.
Each member's token carries only the Confluence scopes (`read:confluence:agent-interface`, `write:confluence:agent-interface`, `search:confluence:agent-interface`) plus `read:me`, `read:account`
and `offline_access`, so it cannot reach other Atlassian apps.

## 1. Public URL

Atlassian sends members back to the platform's OAuth callback, so the platform needs a public URL.

::check capybara:public-url The platform has a public URL

## 2. Allow Capybara in your Atlassian organization

By default Atlassian lets only its own list of supported AI tools receive OAuth redirects, and a
Capybara deployment is not on it. An **Atlassian organization admin** adds the callback URL as a
domain rule, once per Atlassian organization whose members connect:

```yaml title="Atlassian MCP server domain (Confluence connector)"
# Atlassian MCP server domain rule for the "{{templateName}}" connector template ({{pluginName}} {{pluginVersion}}).
# Reference: https://support.atlassian.com/security-and-access-policies/docs/control-atlassian-rovo-mcp-server-settings/ (checked 2026-11-23).
Where: "Atlassian Administration > Connectors > Atlassian MCP server > Add domain"
Domain: "{{oauthCallbackUrl}}"
```

If your Atlassian organization uses IP allowlisting, its rules also apply to tool calls: allow the
outbound address of this Capybara deployment for Confluence, or calls fail with an IP address error even
though connecting worked.

## Confluence on the Atlassian site

The Atlassian site members connect to must have Confluence. On a site with only Jira, connecting
succeeds but every Confluence tool answers 404. Add Confluence to the site in Atlassian
Administration; members do not need to reconnect.

## 3. Check

::check capybara:connector-tools A member connected and the tool list was read

## Tools and approvals

The connector uses Atlassian's flat tool list (`?tools=all` on the endpoint), so every tool has its
own policy. Reads and searches (content, CQL search, spaces, comments, versions, attachments, tasks, templates) run directly. Writes ask the member first, including the ones with wider reach: changing content permissions and restrictions, enabling a public link, archiving or moving content and creating spaces. The Remix tools (infographics, interactive visualizations) also consume Rovo credits. Change any of these per tool on the connector page.
:::

::: audience member
## Connect your Atlassian account

Choose **Connect**, sign in to Atlassian and approve the consent screen. If you belong to several
Atlassian sites, pick the one agents should work in (it must have Confluence): Atlassian usually grants the token for the site you choose.
If Atlassian refuses the redirect, ask your Atlassian organization admin to add this platform's
callback URL to the Atlassian MCP server domains.

Agents then act in Confluence as you, and writes ask you first unless your admin changed that.

**Disconnect** deletes the token in Capybara. To revoke it at Atlassian too, open your Atlassian
account's **Connected apps** (`https://id.atlassian.com/manage-profile/apps`) and remove the app.

::check capybara:connector-connected Your Atlassian account is connected
:::
