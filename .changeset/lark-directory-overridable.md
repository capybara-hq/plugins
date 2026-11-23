---
"@capybara-hq/plugin-lark": minor
---

The directory app moves from the org config into the overridable deployment key `directory`
(`{ appId, appSecret }`): an org saves its own app as its copy, otherwise it follows the
platform's (every org that follows the platform syncs that tenant's members). `directory@1` reads
only `config.directory` of the org's effective config. `region`, `apiUrl`, `accountsUrl` and the
login app `appId` / `appSecret` are platform-only. The same-app guard against the login app stays.
Needs the SDK release with `platformOnly`.
