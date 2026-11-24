---
"@capybara-hq/plugin-anthropic": minor
---

The API key, API URL and models are org-overridable; `serverFallbacks` is platform-only and read
from the platform's config at call time. Calls for an org use the org's whole effective config: an
org copy without an API key fails with `auth` before any request and never falls back to the
platform key, and an org's own API URL goes through the kernel's guarded network client. The
platform may leave the key empty. The model cache in `ctx.kv` is keyed by endpoint
(`models:v4:<sha256(baseUrl)>:<id>`), so an org's endpoint never writes entries other orgs read.
Needs the SDK release with `configUrlFetch` and `platformOnly`.
