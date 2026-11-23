---
"@capybara-hq/plugin-openai-compatible": patch
---

`endpoints` and `apiKeys` are org-overridable (core#720). Each call resolves the org's effective
config as a whole (never mixing in a platform key) and builds its client per call. An endpoint URL
the platform also configures keeps the global fetch; any other URL an org sets goes through the
kernel's guarded client (`ctx.net.fetch`) with the org's id, and a refusal is an
`invalid_request` naming the host. An org copy starts with `apiKeys: {}`, so a kept platform
endpoint is called without a key unless the org enters one. Setup reads the platform config
leniently: the platform may leave `endpoints` to the orgs.

Needs a kernel whose `@capybara-hq/plugin-sdk` ships `configUrlFetch` and org-bound per-call
config (the release of core#720).

The `openai` SDK client reads no `OPENAI_*` host environment variable: the key, admin key,
organization, project, webhook secret and base URL are always explicit, and `OPENAI_CUSTOM_HEADERS`
(which the SDK merges into every request, even over the key) is dropped, so no host value reaches
an org-chosen URL.
