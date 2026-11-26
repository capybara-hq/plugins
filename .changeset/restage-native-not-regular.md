---
"@capybara-hq/plugin-device-docker": patch
"@capybara-hq/plugin-device-e2b": patch
---

A read or write of a FIFO, device or other special file names its cause (capybara-hq/core#907,
step 2 of the runtime change): device-docker restages `native-files.py` from
`@capybara-hq/plugin-sdk` 0.1.0-rc.79's `current` (digest `41cf54ea…`, checked against the host
SDK's `accepted`, so kernels before and after the promotion both work), and both providers' agents
answer `NOT_REGULAR_FILE` when the helper they run raises `NotRegularFile` (an older staged helper
keeps the generic code).
