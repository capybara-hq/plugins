---
"@capybara-hq/plugin-sandbox-e2b": patch
---

Approval-only profiles (core R3): the microVM is the sandbox. `permissionSupport` reports support v2
(`boundary: "instance"`, `restricted: null`, `outsideSandbox: false`, network `openPublic`, `allowlist`
(off when `domainAllowlist` is), no per-operation hosts). The kernel's whole-instance scope runs every
profile; a narrower filesystem grant and the escalated pair are refused before any effect. Limits carry no
`mode` (the "limits carry no mode" error is gone), `list` / `scan` take no limits, `open-public` denies
every closed IPv4 class of the SDK table (metadata, multicast, reserved and the fake-IP range too; the MMDS
residual stays), and the runtime directory is named after every staged file, so new SDK bytes stage a
fresh one. Needs the R3 core release.
