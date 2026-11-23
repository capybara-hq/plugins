# @capybara-hq/plugin-atlassian

Connector templates for Jira, Confluence and Bitbucket (declarative: no extension). Agents work in
Atlassian Cloud **as the person using them**, through Atlassian's remote MCP server (the
[Rovo MCP Server](https://developer.atlassian.com/cloud/rovo-mcp/), `https://mcp.atlassian.com/v2/mcp`)
on the [`connector-mcp`](../connector-mcp) connector. Atlassian Data Center and Server have no
remote MCP server.

| Template | Scopes requested | Tools (allow / ask) | Default |
|---|---|---|---|
| `jira` | `read:jira:agent-interface`, `write:jira:agent-interface`, `search:jira:agent-interface` | 50 (33 / 17) | on |
| `confluence` | `read:confluence:agent-interface`, `write:confluence:agent-interface`, `search:confluence:agent-interface` | 75 (32 / 43) | on |
| `bitbucket` | `read:bitbucket:agent-interface`, `write:bitbucket:agent-interface` | 45 (30 / 15) | off |

Every template also requests `read:me`, `read:account` and `offline_access` (the refresh token).
A member's Jira token therefore cannot reach Confluence or Bitbucket, and the reverse. The
admin-gated `delete:jira:agent-interface` and `manage:jira:agent-interface` scopes are never
requested.

## Auth

All three templates use per-person OAuth with MCP discovery and dynamic client registration
(`oauth_code`, `discovery: "mcp"`, `client: "dcr"`). An unauthenticated request to the server
answers 401 with `resource_metadata` pointing at its protected resource metadata (RFC 9728), which
names the authorization server `https://auth.atlassian.com/<id>`. That server publishes its
metadata (RFC 8414) with a `registration_endpoint`, PKCE S256 and the client authentication methods
`none`, `client_secret_post` and `client_secret_basic`. The kernel registers one client per
installed connector, so the org admin enters no client id or secret. It needs `http.publicUrl` for
the callback, and it sends the template's scopes and the `resource` from the metadata.

On the Atlassian side, OAuth redirects go only to the domains an Atlassian organization allows
(Atlassian Administration > Connectors > Atlassian MCP server). By default that is Atlassian's own
list of supported AI tools, so an Atlassian organization admin adds the deployment's callback URL
there. If the organization uses IP allowlisting, it applies to tool calls as well. Atlassian's API
token sign-in (Basic `email:token`, enabled by an Atlassian admin) is not supported yet.

## Tools and policies

The endpoint carries `?tools=all`, Atlassian's paginated flat tool list. Without it the server
lists a few primary tools and the generic `discover` / `executeRead` / `executeWrite` /
`executeDestructive`, which would put every call behind one policy. `defaultToolPolicies` lists,
per template, that product's permission groups from Atlassian's
[supported tools](https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/) page
(recorded 2026-11-23 in `test/fixtures/<id>-tools.json`) plus the common tools:

- `read_*` and `search_*` groups: `allow`; `write_*` groups: `ask`, including Confluence permission
  and restriction changes, public links and Bitbucket merges and pipeline runs. Nothing is `deny`.
- Common: `atlassianUserInfo`, `getAccessibleAtlassianResources`, `getContentFormatGuide`,
  `discover` and `executeRead` `allow`; `executeWrite` and `executeDestructive` `ask`, in case the
  server keeps offering them next to the flat list.

Which tools a member actually gets depends on the scopes, the permission groups the Atlassian
organization has on and the member's own app access. A tool Atlassian adds later gets the kernel's
default from its annotation (read-only: allow, else ask) and goes through the drift review. Every
name is `[A-Za-z]` only, so every tool key is valid. Some tools consume Rovo credits.

## Bitbucket

The `bitbucket` template is off by default. Atlassian offers the Bitbucket tools only for a
Bitbucket Cloud workspace linked to an Atlassian organization, and Atlassian's documents disagree
on whether these tools accept OAuth or only an API token. The template has not been checked
against a live workspace yet.

## Setup guides

`guides/jira-oauth.md`, `guides/confluence-oauth.md` and `guides/bitbucket-oauth.md`, each with a
Chinese version: the Atlassian domain rule with the callback URL, the IP allowlist note, the kernel
checks `public-url` and `connector-tools` (no client checks: the client is registered
automatically), and how a member connects and revokes. Preview with
`capybara-plugin guide jira-oauth --audience admin` from this directory.

## Tests

```bash
pnpm exec vitest run plugins/atlassian
```
