---
"@capybara-hq/plugin-sandbox-e2b": minor
---

Implements the permission operation contract of `sandbox@2` (plugin SDK 0.1.0-rc.28):
`permissionSupport`, a fresh immutable operation per invocation (`operation`), owner browsing,
trusted skill and attachment preparation, `revokeOperation` tombstones and exact background
supervision (`start`, `status`, `tail`, `readOutput`, `stop`) for Full access. The provider stages
its operation runtime (the SDK native helper and launcher, plus its own agent) in the VM as root,
digest-checked, and keeps root-owned records on the VM's disk. Restricted profiles are reported
unavailable with the template's own facts: the SDK launcher needs Landlock ABI 6, and the tested E2B
template runs Linux 6.1 with Landlock ABI 2; restricted grants are refused
before any effect, never widened to Full access. Full access keeps the VM's OS user, environment
and network; no conversation grant updates the VM network. Requires
`@capybara-hq/plugin-sdk@^0.1.0-rc.28`.
