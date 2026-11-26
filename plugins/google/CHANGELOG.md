# @capybara-hq/plugin-google

## 0.1.0-rc.4

### Patch Changes

- 2396551: Sign in with Google declares its tenant (the Workspace primary domain, placeholder `example.com`, with
  `consumer` never trusted), so the admin console labels trusted domains and refuses `consumer`. The
  sign-in guide and README turn the login on in the extension page's 「登录」 section (or
  `login-sources.update`) instead of the removed `auth.loginSources` / `auth.trustedIdentitySources`, and
  say that an unlinked account goes to the link page by default. Needs `@capybara-hq/plugin-sdk`
  0.1.0-rc.77 and kernel 0.1.0-rc.94.
- f535a1e: Slack and Lark ship a platform setup guide for their sign-in (`slack-sign-in`, `lark-sign-in`,
  place `extension-deployment`) with the callback URL filled in; the Google sign-in guide now says
  that `auth.loginSources` is kernel config, not a platform setting.

## 0.1.0-rc.3

### Patch Changes

- 6cb229b: Connector template descriptions in English and Chinese (`{ en, zh }`, plugin-sdk 0.1.0-rc.65), so a
  deployment shows each template's description in the page language.
- fd77b82: The deployment config is marked platform-only (unified plugin config, core#720): this plugin has no
  org-bound entry, so an org never overrides its fields.

## 0.1.0-rc.2

### Patch Changes

- 19123cd: Connector-template setup guides name their templates as `templates: [...]` (plugin-sdk
  0.1.0-rc.60 replaced the single `template` key).

## 0.1.0-rc.1

### Minor Changes

- 08b152a: Google Workspace (Gmail, Drive, Calendar, Sheets, Docs, Slides) and BigQuery connector templates on connector-mcp, each with a setup guide; needs kernel 0.1.0-rc.68 or newer
