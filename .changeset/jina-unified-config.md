---
"@capybara-hq/plugin-jina": minor
---

The API key moves from the org config into the deployment config as an overridable secret: the
platform may set a shared key or leave it empty, and an org saves its own copy through the
overrides. `searchUrl` and `readerUrl` are read per call from the effective config; an org's own
URL goes through the guarded client.
