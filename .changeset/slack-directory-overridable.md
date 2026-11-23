---
"@capybara-hq/plugin-slack": minor
---

The directory credentials move from the org config into the overridable deployment key
`directory` (`{ teamId, botToken }`): an org saves its own as its copy, otherwise it follows the
platform's (every org that follows the platform syncs that workspace's members). `directory@1`
reads only `config.directory` of the org's effective config. `apiUrl`, `openidUrl` and the login
client `clientId` / `clientSecret` are platform-only. Needs the SDK release with `platformOnly`.
