---
"@capybara-hq/plugin-device-local": patch
---

Keeps the shown shared project directories when a policy event's `sharedProjectRoots` list is
unreadable (malformed or too long) in an otherwise readable summary, as an unreadable summary
already did. The "Also used by another connection" line now fits as many whole directories as it
can, skipping one too long, and counts the rest as a language-neutral ` +N` instead of English
` +N more`.
