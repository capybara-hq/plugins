---
"@capybara-hq/plugin-sandbox-e2b": patch
---

Sandbox tiers: the setting `openEgress: "off" | "proxy" | "direct"` (default `"proxy"`) replaces
`allowOpenEgress` (the old key fails with a pointer to it); on E2B `"proxy"` and `"direct"` both mean
plain internet access. `limitsApplyAt: "fileSystem"` and `update`, which resumes the sandbox and
replaces its egress through `PUT /sandboxes/{id}/network`, so a tier change no longer needs a file
reset.
