---
"@capybara-hq/plugin-browser": patch
---

The headless shell download host list includes `storage.googleapis.com`, where the Playwright CDN
redirects it, so a device allowlist that refuses it gets the ask instead of a bare "Failed to
download"; a blocked host's next step no longer claims the user is always asked.
