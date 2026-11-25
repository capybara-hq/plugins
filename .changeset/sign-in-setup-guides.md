---
"@capybara-hq/plugin-slack": patch
"@capybara-hq/plugin-lark": patch
"@capybara-hq/plugin-google": patch
---

Slack and Lark ship a platform setup guide for their sign-in (`slack-sign-in`, `lark-sign-in`,
place `extension-deployment`) with the callback URL filled in; the Google sign-in guide now says
that `auth.loginSources` is kernel config, not a platform setting.
