---
"@capybara-hq/plugin-browser": patch
---

A navigation keeps going while the device's network changes under it (Wi-Fi, a VPN, a container
network coming up), as often as the network changes within the navigation's time, instead of
failing with net::ERR_NETWORK_CHANGED after the fourth change; one the changes kept from loading in
its time is reported as not loaded within that time. A navigation Chromium starts once more itself
after the previous page's late error page interrupted it is followed to its page instead of failing
with "interrupted by another navigation".
