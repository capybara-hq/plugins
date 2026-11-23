---
"@capybara-hq/plugin-device-docker": patch
"@capybara-hq/plugin-device-e2b": patch
---

device-docker honors the kernel's fence token (core design device update fencing, core#748). The
egress proxy stores the highest token it applied next to its list (`allow.json` gains `fence`, the
proxy starts from `FENCE` without a file) and refuses an apply with a lower one inside its
serialized apply (`code: "stale-fence"`, mapped to `StaleFenceError`); `ifDigest` is gone. `create`
stamps the token on the sandbox container and the proxy (`dev.capybara.sandbox.fence`), refuses to
replace an instance holding a higher token, and returns a handle naming its incarnation
(`{ id, fence }`): a call on a handle whose instance was replaced under the same name answers
`SandboxGoneError`. `destroy` / `destroyByName` refuse an instance a newer holder created. The egress
control moves to version 2 (`dev.capybara.sandbox.egress-control=2`, also on the proxy image):
instances of earlier versions, and every `update` from a kernel that sends no token, answer
`recreate` for an allowlist change, so each existing instance is rebuilt fenced once, at its first
network change. device-e2b ignores the token (its network write is unconditional) and its README
states the residual race. Builds against plugin-sdk 0.1.0-rc.64.
