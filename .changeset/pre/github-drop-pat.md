---
"@capybara-hq/plugin-github": patch
---

Drop the `github-pat` template (a member-pasted personal access token): the `github` template's
OAuth through a GitHub App gives expiring tokens, per-installation repositories and admin control.
