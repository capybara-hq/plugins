---
"@capybara-hq/plugin-sandbox-docker": patch
---

Sandbox tiers (capybara-hq/core#190): `limits.tier` picks the egress proxy mode (`strict`: allowlist on
443 / 80; `dev`: allowlist on any port plus SOCKS5, with `ALL_PROXY`, `GRPC_PROXY` and an ssh
`GIT_SSH_COMMAND` in the container; `open`: any public host through the proxy), `dev` and `open` get
`/dev/shm` of `min(1 GiB, memoryMb / 4)`, and the new `update` changes an instance's egress proxy in
place or asks for a recreate (`limitsApplyAt: "instance"`). The deployment setting `allowOpenEgress`
is replaced by `openEgress: "off" | "proxy" | "direct"` (default `proxy`; `direct` is the old shared
bridge); an `allowOpenEgress` key now fails the config with a pointer to `openEgress`.
