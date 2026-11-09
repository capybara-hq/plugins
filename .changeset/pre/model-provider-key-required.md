---
"@capybara-hq/plugin-bailian": patch
"@capybara-hq/plugin-ark": patch
"@capybara-hq/plugin-deepseek": patch
---

The API key is required in the deployment config. A deployment without one now shows the provider as
needing configuration (each organization following the platform needs its own key) instead of as
failing to list its models. The key stays overridable, so an organization can still bring its own.
