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
fresh one. Needs the R3 core release (`@capybara-hq/plugin-sdk@^0.1.0-rc.39`, kernel 0.1.0-rc.55;
an earlier kernel refuses the manifest).

Security review: an operation whose network is narrower than the VM's applied policy (read from
`GET /sandboxes/{id}`) is refused instead of silently widened; an open-public VM made with an earlier,
shorter deny list gets the current policy re-applied on resume and on the next operation (a failed
re-apply is retried; a failed `update` answers `recreate`), so no device is left refusing every command. The README records the
live findings for `0.0.0.0/8` and the MMDS fields.
