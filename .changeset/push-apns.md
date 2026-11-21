---
"@capybara-hq/plugin-push-apns": patch
---

New plugin `push-apns`: a `push-provider@1` for Apple Push Notification service. Token-based
authentication with a `.p8` signing key (ES256 provider token shared through `ctx.kv` for 40
minutes), one HTTP/2 request per device to the production or sandbox host of its bundle, the event
id as `apns-collapse-id`, and a platform setup guide whose check `apns-credentials` verifies the key
against an all-zero device token without delivering anything.
