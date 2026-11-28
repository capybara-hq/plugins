---
"@capybara-hq/plugin-browser": patch
---

The panel's empty-state heading uses the body text's face, and the panel's font stacks name
Windows faces (Segoe UI, Microsoft YaHei UI, Cascadia Mono, Consolas) before their generic family:
Chinese text no longer falls back to the Song face on Windows.
