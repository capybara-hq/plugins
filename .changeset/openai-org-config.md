---
"@capybara-hq/plugin-openai": minor
---

Every deployment field (API key, API URL, organization, models, reasoning summary, image models)
is org-overridable. Calls for an org use the org's whole effective config: an org copy without an
API key fails with `auth` before any request and never falls back to the platform key, and an org's
own API URL goes through the kernel's guarded network client. The platform may leave the key and
models empty. Needs the SDK release with `configUrlFetch` and `platformOnly`.
