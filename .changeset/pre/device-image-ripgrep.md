---
"@capybara-hq/plugin-device-docker": patch
"@capybara-hq/plugin-device-e2b": patch
---

The sandbox image ships ripgrep (`rg`), which the kernel's Grep and Glob prefer so ignore files such as
`.gitignore` are honored (they fall back to GNU grep / find without it). The E2B plugin builds its
template from the same image, so a new version picks it up.
