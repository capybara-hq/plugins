---
"@capybara-hq/plugin-sandbox-e2b": patch
---

Map `limits.network` to E2B's network policy (an allowlist, or no network) and refuse `open-public`:
E2B cannot block the sandbox's metadata endpoint even with `denyOut`, so the plugin never opens the
network. The `openEgress` / `allowOpenEgress` settings are gone, and an older kernel's `tier` /
`egress` limits are refused instead of guessed. The allowlist's `denyOut` also carries the IPv6
loopback, link-local and unique-local ranges.

Existing E2B devices created with the open network will fail on their next create / update after
the upgrade: the provider now refuses `open-public`, and auto mode always carries it. Move the org's
cloud network to an allowlist, or run the device on the Docker provider.
