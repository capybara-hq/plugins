---
"@capybara-hq/plugin-sandbox-docker": patch
---

The open public network is the default: `create` / `update` map `limits.network` to the egress proxy
(`open-public`: any public host and port, with loopback, private, link-local and metadata addresses
still refused by resolved IP; `allowlist`: the given hosts, any port). The sandbox tiers and
`openEgress` are gone (no compatibility); the new `refuseOpenNetwork` setting refuses `open-public`
for locked-down deployments. Needs `@capybara-hq/plugin-sdk` `^0.1.0-rc.22` and the core release that
sends `limits.mode` / `limits.network`.
