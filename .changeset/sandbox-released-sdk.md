---
"@capybara-hq/plugin-sandbox-docker": patch
"@capybara-hq/plugin-sandbox-e2b": patch
---

Build against @capybara-hq/plugin-sdk 0.1.0-rc.17, the SDK with sandbox tiers: the local tier types
(`SandboxTier`, `TierLimits`, `TieredSandboxLimits`, `TieredSandboxProvider`) are gone in favor of
the SDK's `SandboxLimits.tier`, `update` and `limitsApplyAt`.
