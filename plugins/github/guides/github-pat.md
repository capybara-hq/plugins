# Set up the GitHub connector with personal access tokens

This template gives agents the same GitHub tools as the **GitHub** template, but each member pastes
a personal access token of their own instead of connecting with OAuth. Agents then act on GitHub
as that member, with what the token allows.

::: audience admin
The template starts switched off. Switch it on only where personal access tokens are acceptable:
they are created and scoped by each member, and a classic token reaches every repository the
member can. Prefer the **GitHub** template (a GitHub App) where you can.

If your GitHub organization requires approval of fine-grained tokens, an owner approves each
member's token under **Settings → Personal access tokens → Pending requests**. To forbid classic
tokens, set **Settings → Personal access tokens → Restrict access via personal access tokens
(classic)**.

Reads run directly; writes ask the member first and deleting a repository is denied, as in the
**GitHub** template.

::check capybara:connector-tools A member connected and the tool list was read
:::

::: audience member
## Create a token

Open **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new
token** on GitHub (`https://github.com/settings/personal-access-tokens/new`) and choose:

```yaml title="Fine-grained token (GitHub connector)"
# Personal access token for the "{{templateName}}" connector template ({{pluginName}} {{pluginVersion}}).
# Reference: https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens (checked 2026-11-12).
Resource owner: the organization that owns the repositories
Expiration: 90 days or less
Repository access: Only select repositories
Repository permissions:
  Actions: Read and write
  Checks: Read-only
  Commit statuses: Read-only
  Contents: Read and write
  Issues: Read and write
  Metadata: Read-only
  Pull requests: Read and write
  Workflows: Read and write   # only to change files under .github/workflows
Organization permissions:
  Members: Read-only
```

A classic token works too (scopes `repo`, `read:org`, `read:user`, `user:email`, `workflow`); with
one, GitHub hides the tools the token's scopes do not cover.

## Connect

Paste the token in **Connect**. It is stored encrypted and never shown again. When it expires,
connect again with a new token. **Disconnect** deletes it in Capybara; delete the token on GitHub
as well when you no longer need it.

::check capybara:connector-connected Your GitHub token is connected
:::
