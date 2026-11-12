---
"@capybara-hq/plugin-anthropic": patch
"@capybara-hq/plugin-ark": patch
"@capybara-hq/plugin-bailian": patch
"@capybara-hq/plugin-connector-mcp": patch
"@capybara-hq/plugin-connector-openapi": patch
"@capybara-hq/plugin-deepseek": patch
"@capybara-hq/plugin-jina": patch
"@capybara-hq/plugin-lark": patch
"@capybara-hq/plugin-object-store-s3": patch
"@capybara-hq/plugin-openai": patch
"@capybara-hq/plugin-openai-compatible": patch
"@capybara-hq/plugin-sandbox-docker": patch
"@capybara-hq/plugin-sandbox-e2b": patch
"@capybara-hq/plugin-slack": patch
"@capybara-hq/plugin-telegram": patch
"@capybara-hq/plugin-todo": patch
---

Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.17 (the SDK with sandbox tiers) and
@capybara-hq/plugin-model-fake 0.1.0-rc.17. sandbox-docker and sandbox-e2b drop their local tier
types (`SandboxTier`, `TierLimits`, `TieredSandboxLimits`, `TieredSandboxProvider`) for the SDK's
`SandboxLimits.tier`, `update` and `limitsApplyAt`. lark and slack label the approval state
`skipped` (the person sent a message instead of deciding).
