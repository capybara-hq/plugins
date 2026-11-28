---
"@capybara-hq/plugin-browser": patch
"@capybara-hq/plugin-file-preview": patch
---

The browser panel and the file previewer paint no ground of their own before the host's `init`:
it was the light `Canvas` colour whatever the host's theme, so the embed flashed white in the
dark theme before its tokens arrived. Transparent, the host's pane shows through until then.
