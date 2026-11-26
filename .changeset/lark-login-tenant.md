---
"@capybara-hq/plugin-lark": patch
---

Lark login declares its tenant (the `tenant_key`), so the admin console labels trusted tenants. The
sign-in guide and README turn the login on in the extension page's 「登录」 section (or
`login-sources.update`) instead of the removed `auth.loginSources` / `auth.trustedIdentitySources`, and
say that an unlinked account (also one linked only through the bot's binding card) goes to the link
page by default. Needs `@capybara-hq/plugin-sdk` 0.1.0-rc.77 and kernel 0.1.0-rc.94.
