---
"@capybara-hq/plugin-sandbox-docker": minor
---

Implements the permission operation contract of `sandbox@2` (plugin SDK 0.1.0-rc.27): runtime
capabilities (`permissionSupport`), a fresh immutable operation per invocation (`operation`), owner
browsing, trusted skill and attachment preparation, `revokeOperation` tombstones and exact
background supervision (`start`, `status`, `tail`, `readOutput`, `stop`). Restricted work runs
through the SDK's Linux launcher (Landlock and a seccomp notification broker on the same pinned root
descriptors as the native helper), staged root-owned and digest-checked in the sandbox image, inside
the existing container with unchanged hardening; Full access keeps the existing environment without
restricted filters. A restricted allowlist reaches its hosts only through a per-operation forwarder
in front of the instance's egress proxy. Restricted support is reported only when the launcher's
own probe passes (validated architecture, Landlock ABI 6+, seccomp listener); otherwise restricted
operations are refused. Requires `@capybara-hq/plugin-sdk@^0.1.0-rc.27` and the matching sandbox
image.
