---
"@capybara-hq/plugin-file-preview": patch
---

Drop the `html` previewer: the kernel's built-in previewer renders HTML (full rendering, CDN
allowlist) since a kernel release after 0.1.0-rc.50.
