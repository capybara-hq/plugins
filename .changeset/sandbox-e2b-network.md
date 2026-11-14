---
"@capybara-hq/plugin-sandbox-e2b": patch
---

Map `limits.network` to E2B's network policy (an allowlist, or no network) and refuse `open-public`:
E2B cannot block the sandbox's metadata endpoint even with `denyOut`, so the plugin never opens the
network. The `openEgress` / `allowOpenEgress` settings are gone, and an older kernel's `tier` /
`egress` limits are refused instead of guessed.
