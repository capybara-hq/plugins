---
"@capybara-hq/plugin-push-fcm": patch
---

New plugin: the Firebase Cloud Messaging push provider (push-provider@1 over the FCM HTTP v1 API).
A service account key (secret) signs an RS256 JWT bearer grant; the access token is cached in kv
for its lifetime minus five minutes. collapseId maps to android.collapse_key, the thread to the
notification tag. A platform setup guide checks the key with one token exchange (fcm-credentials).
