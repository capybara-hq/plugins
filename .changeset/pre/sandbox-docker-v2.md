---
"@capybara-hq/plugin-sandbox-docker": minor
---

Provide `sandbox@2`. BREAKING: needs a kernel with environments and `@capybara-hq/plugin-sdk` `^0.1.0-rc.3`.
Files now outlive instances: the workspace and skills volumes are created by `createFileSystem` (idempotent by
name) and kept by `destroy`; `create` on missing volumes throws `FileSystemGoneError` instead of mounting empty
ones, and `destroyFileSystem` / `destroyFileSystemByName` remove them (legacy `cap-<conversationId>` names
too). `exec` takes a required `tag` and an `actor`. The default sandbox and egress proxy images are now the
published `ghcr.io/capybara-hq/capybara-sandbox[-egress]:<plugin version>`; `egressProxyImage` has no schema
default and `sandbox.image` stays optional. Both sandbox plugins now release with one version.
