---
"@capybara-hq/plugin-device-docker": patch
---

Docker devices change their egress allowlist in place: `update` hands the egress proxy the new host
list (wider, narrower or both) and the current `deniedCidrs` through a control socket only the
proxy container reaches. The proxy keeps the list on the instance's config volume
(`<name>-egress-conf`, removed with the instance), closes every connection the new list no longer
covers, also those still resolving or connecting, and acknowledges with the list's digest; the
sandbox container, its background processes and the connections still allowed stay. A lost proxy
is rebuilt only from that volume (without it the instance is recreated, never rebuilt from the wider
create-time labels). Kind changes and the empty list still recreate; instances of earlier versions
keep the old proxy swap until their next recreate.
