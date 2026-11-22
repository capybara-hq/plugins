---
"@capybara-hq/plugin-device-docker": patch
---

The egress proxy also refuses the Azure WireServer address `168.63.129.16`, and a new deployment
setting `deniedCidrs` (IPv4 / IPv6 CIDRs, validated) adds the deployment's own ranges to what every
proxy refuses (`DENIED_CIDRS`). With `refuseOpenNetwork` on, an open-public instance made before the
setting answers `gone` on resume and auto-start, so the kernel recreates it under the rule; an
update from an allowlist to `open-public` now recreates the instance, so its labels stay truthful.
The README states what the proxy enforces instead of "neither mode can reach the host".
