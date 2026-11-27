---
"@capybara-hq/plugin-device-docker": patch
---

An egress proxy on an earlier build of the configured `egressProxyImage` is replaced on resume and
before the next use even when the reference is unchanged (a new build under the same tag, such as
the offline route's `:local`): the proxy container's image id is compared with the configured
image's. Only the proxy is replaced, on the same config volume and networks, so the list in force
is kept; an instance with the egress control whose configured image lacks the control is recreated
instead of getting a proxy that would start from its create-time labels.
