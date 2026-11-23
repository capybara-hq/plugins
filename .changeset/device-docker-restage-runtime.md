---
"@capybara-hq/plugin-device-docker": patch
---

The sandbox image stages the SDK's current Linux launcher (`SANDBOX_RUNTIME_SOURCE.current`, the
one with exact file read roots; never run in the container), and staged runtime files are checked
against the kernel SDK's `SANDBOX_RUNTIME_SOURCE.accepted` instead of one exact digest: instances
made from an earlier image keep working while the kernel's SDK accepts what they staged, and
operations check only the files the agent runs (`native-files.py`). Needs a kernel whose
`@capybara-hq/plugin-sdk` lists `accepted` (the release of core#742); on an older one the device's
support is unavailable and says why.
