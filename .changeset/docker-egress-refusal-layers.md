---
"@capybara-hq/plugin-device-docker": patch
---

A cloud docker device reports the hosts its egress proxy refused, with the same layers as a local
device. The proxy answers each refusal with the SDK's sandbox proxy reason as the 403 status phrase
(`host is not on the allow list`, `resolved to a private or reserved address`, …), which the browser
daemon classifies, and records each command's refusals under a tag carried in that command's proxy
credentials; a failed command's exec result reports them as `network.blocked`
(`sandboxProxyRefusalLayer`): a name resolving to a private address gets the address note, a host
off the allowlist the network ask. Needs `@capybara-hq/plugin-sdk` 0.1.0-rc.77.
