# @capybara-hq/plugin-github

The GitHub connector template (declarative: no extension). Agents work with GitHub **as the
person using them**: issues, pull requests, comments and reviews, repository files and branches,
and Actions runs and logs, through [GitHub's remote MCP server](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
(`https://api.githubcopilot.com/mcp/`) on the [`connector-mcp`](../connector-mcp) connector.

| Template | Auth | Default |
|---|---|---|
| `github` | Per-person OAuth (`oauth_code`, MCP discovery, manual client): the org admin registers a GitHub App (recommended: fine-grained permissions, per-installation repositories, tokens that expire after eight hours and are refreshed) or an OAuth App (classic scopes `repo`, `read:org`, `read:user`, `user:email`, `workflow`) | on |

GitHub does not support dynamic client registration, so the OAuth template always needs a client
the org admin enters.

## Tools and policies

The template sets the endpoint header `X-MCP-Toolsets: context,repos,issues,pull_requests,users,actions`
(GitHub's default toolsets plus `actions` for CI status). The header and the URL are editable per
org (`editableEndpoint`): add toolsets, set `X-MCP-Readonly: true`, or point the URL at a GitHub
Enterprise Cloud data residency host (`https://copilot-api.<subdomain>.ghe.com/mcp`). GitHub
Enterprise Server has no remote MCP server.

`defaultToolPolicies` lists every tool of those toolsets in github/github-mcp-server (checked
2026-11-12, including the tools behind GitHub's feature flags): the read-only tools are `allow`,
every write is `ask` (creating issues and pull requests, comments, reviews, merging, pushing files,
branches, re-running workflows), and `delete_repository` is `deny`. GitHub's tool names use only
`[a-z0-9_]`, so every tool key is valid. A tool GitHub adds later gets the kernel's default from its
annotation (read-only: allow, else ask) and goes through the drift review.

## Setup guides

`guides/github-oauth.md` (template `github`: GitHub App settings, the OAuth App alternative, the
kernel checks `public-url`, `oauth-client`, `oauth-token-endpoint`, `connector-tools`, and how a
member connects and revokes), with a Chinese version. Preview with
`capybara-plugin guide github-oauth --audience admin` from this directory.

## Tests

```bash
pnpm exec vitest run plugins/github
# live, against GitHub (lists the tools and calls get_me; read-only):
CAPYBARA_TEST_LIVE_TOOLS=1 pnpm exec vitest run plugins/github/test/live -t live
```

The live test needs `CAPYBARA_TEST_GITHUB_MCP_TOKEN`: a personal access token stands in for a
member's OAuth token, since the OAuth flow needs a browser. Keep it in an env file outside the
repository.

A personal access token template was dropped before release: OAuth through a GitHub App gives
expiring tokens, per-installation repositories and admin control, which a member-made token does not.
