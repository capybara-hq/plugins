---
"@capybara-hq/plugin-openai-compatible": patch
---

The deepseek dialect sends mid-conversation system messages (sub-agent deliveries, background task
notices, reminders) as in-place `[system] ` user turns instead of `role: "system"` messages, which
DeepSeek did not keep in position; it now reports `midConversationSystem: false`. An endpoint can
still opt back in with `midConversationSystem: true`.
