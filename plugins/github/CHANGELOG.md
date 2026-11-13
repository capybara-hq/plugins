# @capybara-hq/plugin-github

## 0.1.0-rc.2

### Patch Changes

- 2526db2: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.19 (context providers, conversation sources,
  lifecycle hooks), @capybara-hq/plugin-model-fake 0.1.0-rc.19 and @capybara-hq/testing 0.1.0-rc.17
  (pgvector test containers). No behaviour change.

## 0.1.0-rc.1

### Patch Changes

- 5554a58: Drop the `github-pat` template (a member-pasted personal access token): the `github` template's
  OAuth through a GitHub App gives expiring tokens, per-installation repositories and admin control.
