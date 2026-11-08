# @capybara-hq/plugin-openai-compatible

## 0.1.0-rc.3

### Patch Changes

- ce8d729: The plugin ships an icon (`icon.svg`): a line icon for a compatible API.

## 0.1.0-rc.2

### Patch Changes

- 8d34176: The deepseek dialect sends mid-conversation system messages (sub-agent deliveries, background task
  notices, reminders) as in-place `[system] ` user turns instead of `role: "system"` messages, which
  DeepSeek did not keep in position; it now reports `midConversationSystem: false`. An endpoint can
  still opt back in with `midConversationSystem: true`.

## 0.1.0-rc.1

### Patch Changes

- 726eacb: Run on core 0.1.0-rc.4: bilingual config field labels and a display name.
