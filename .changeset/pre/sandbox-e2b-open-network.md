---
"@capybara-hq/plugin-device-e2b": patch
---

Map `open-public` instead of refusing it: internet access (`allow_internet_access: true`) with
`denyOut` of the private, loopback, CGNAT and link-local ranges (`10/8`, `172.16/12`, `192.168/16`,
`127/8`, `169.254/16`, `100.64/10`, `fc00::/7`, `fe80::/10`, `::1/128`), at create and through the
live network update, so auto mode runs on E2B. The E2B metadata service (MMDS, `169.254.169.254`)
stays reachable inside the sandbox whatever `denyOut` says, under an allowlist too; the README and
the manifest now state it as a residual E2B exposure in both modes.
