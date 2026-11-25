---
"@capybara-hq/plugin-browser": patch
---

The panel's tabs show the site's icon. When a page loads, the daemon finds the page's
`<link rel=icon>` (or `/favicon.ico`) and the browser fetches it (CDP
`Network.loadNetworkResource`, through the device's network rules). The daemon sniffs it, caps it
at 8 KiB and keeps it per tab, and sends it as `ViewerTab.favicon` (a `data:image/...` URL). The
panel shows it, with the grey placeholder only as a fallback. State messages over the size cap drop
the icons first.
