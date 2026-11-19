---
"@capybara-hq/plugin-sandbox-docker": patch
---

Approval-only profiles (core R3): the container is the sandbox. `permissionSupport` reports support v2
(`boundary: "instance"`, `restricted: null`, `outsideSandbox: false`, network `openPublic` (off under
`refuseOpenNetwork`), `allowlist`, no per-operation hosts). The kernel's whole-instance scope runs every
profile on the ordinary exec and file paths behind the durable admission; a narrower filesystem grant and
the escalated pair are refused before any effect. Limits carry no `mode`, `list` / `scan` take no limits,
and the image stages the R3 SDK runtime bytes. The egress proxy refuses exactly the SDK's closed address
classes (`OPEN_PUBLIC_DENIED_CIDRS`; NAT64 is now closed whatever it embeds) and re-resolves a fake-IP
answer (198.18.0.0/15) through DNS-over-HTTPS per `SANDBOX_FAKE_IP_DNS`, never dialling the fake address.
Needs the R3 core release (plugin-sdk, kernel) and a rebuilt sandbox and egress image.

Security review: the instance's internal network is created with `com.docker.network.bridge.inhibit_ipv4`
and no IPv6, so the sandbox cannot reach the Docker host's services through a bridge gateway (Docker Engine
25 or newer, checked on first create; an instance on an older network answers `gone` on resume and is
recreated). With a local Docker endpoint the host's own interface addresses join the egress proxy's denied
ranges. An operation whose network is narrower than the instance's applied network (container labels) is
refused instead of silently widened. The agent carries no restricted launch path any more (`exec`, `native`
and `probe` are unknown commands; `direct` refuses writable scoped roots).
