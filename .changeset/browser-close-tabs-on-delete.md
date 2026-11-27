---
"@capybara-hq/plugin-browser": patch
---

A deleted conversation's tabs close right away: the daemon handles the kernel's conversation-deleted
notice (SDK `parseConversationDeleted`) by closing the tabs of the conversation and of its
sub-agent conversations, forgetting their state (handoffs and parks included) and dropping them
from the session file, so a restart does not restore them. The profile (logins) is never touched;
the idle close stays the backstop. The session file's restore window is the SDK's
`DEVICE_SERVICE_RESTORE_MAX_AGE_MS`. Needs `@capybara-hq/plugin-sdk` 0.1.0-rc.83.
