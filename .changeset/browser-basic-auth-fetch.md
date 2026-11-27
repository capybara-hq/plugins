---
"@capybara-hq/plugin-browser": patch
---

A page's own fetch, XHR or subresource that gets an HTTP Basic challenge now completes with its 401
for the page to handle instead of hanging in the full Chromium build: the daemon keeps its credential
route installed for the session and the vendored playwright-core cancels a site challenge no stored
credentials match. Stored credentials still go only to the exact origin they were entered for.
