---
"@capybara-hq/plugin-slack": patch
---

Sign in with Slack declares its tenant (the workspace ID, `^T[A-Z0-9]+$`, placeholder `T0123ABCD`), so
the admin console labels and checks trusted workspaces. The sign-in guide and README turn the login
on in the extension page's 「登录」 section (or `login-sources.update`) instead of the removed
`auth.loginSources` / `auth.trustedIdentitySources`, and say that an unlinked account goes to the link
page by default. Needs `@capybara-hq/plugin-sdk` 0.1.0-rc.77 and kernel 0.1.0-rc.94.
