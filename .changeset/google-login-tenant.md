---
"@capybara-hq/plugin-google": patch
---

Sign in with Google declares its tenant (the Workspace primary domain, placeholder `example.com`, with
`consumer` never trusted), so the admin console labels trusted domains and refuses `consumer`. The
sign-in guide and README turn the login on in the extension page's 「登录」 section (or
`login-sources.update`) instead of the removed `auth.loginSources` / `auth.trustedIdentitySources`, and
say that an unlinked account goes to the link page by default. Needs `@capybara-hq/plugin-sdk`
0.1.0-rc.77 and kernel 0.1.0-rc.94.
