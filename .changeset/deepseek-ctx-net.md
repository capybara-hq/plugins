---
"@capybara-hq/plugin-deepseek": minor
---

An org's own `baseUrl` (the overridable field, when it differs from the platform's) is requested
through the kernel's guarded `ctx.net.fetch` with the org's id, for listing and streaming: an org
admin can no longer point the provider at an internal address the super admin did not allow for the
org. A refusal is a `ModelError` of kind `invalid_request` that names the host. The platform's own
base URL keeps the global `fetch`. Requires `@capybara-hq/plugin-sdk@^0.1.0-rc.29`.
