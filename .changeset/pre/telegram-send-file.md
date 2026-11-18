---
"@capybara-hq/plugin-telegram": minor
---

Send conversation files: the channel implements `sendFile` (`features.files`: 50 MB documents,
10 MB photos). An image goes out as a photo, and once more as a document when Telegram refuses the
picture; any other file is a document, one message per file in the conversation's chat, thread and
topic. A 413 maps to `too_large`. No bot permission change is needed.
