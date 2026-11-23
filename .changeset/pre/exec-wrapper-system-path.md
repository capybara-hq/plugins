---
"@capybara-hq/plugin-device-docker": patch
"@capybara-hq/plugin-device-e2b": patch
---

Security: the exec wrapper no longer looks up `setsid`, `timeout` or its own tools on the image's
PATH, whose first entry (`/workspace/.cache/npm-global/bin`) the sandbox user can write. A
planted `timeout` there could lift the in-sandbox time limit, and planted tools could defeat the
kill scripts or run as root during a `/skills` write. `setsid` starts by absolute path (Docker) or
through a lookup on the system PATH (E2B), `timeout` is resolved on the system PATH
(`/usr/sbin:/usr/bin:/sbin:/bin`, root-owned) inside the wrapper, and every other provider-run
script gets that PATH; only the user's command keeps the image's PATH (#106).
