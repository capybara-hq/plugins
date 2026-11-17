---
"@capybara-hq/plugin-connector-mcp": minor
"@capybara-hq/plugin-connector-openapi": minor
---

Every request to a connector endpoint (MCP requests; the OpenAPI document, its servers and the
`baseUrl`) goes through the kernel's guarded `ctx.net.fetch` with the org the session serves, so
internal endpoints are reachable only where a super admin allowed them for that org. Endpoints accept
http and https; `ctx.net` decides at request time. A refusal is a `ToolError` that names the host.
The deployment config `allowInsecureLoopback` is gone (the kernel's tests-only
`net.allowInsecureLoopback` replaces it). Requires `@capybara-hq/plugin-sdk@^0.1.0-rc.29`.
