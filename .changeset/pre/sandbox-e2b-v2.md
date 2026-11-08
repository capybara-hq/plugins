---
"@capybara-hq/plugin-sandbox-e2b": minor
---

Provide `sandbox@2`. BREAKING: needs a kernel with environments and `@capybara-hq/plugin-sdk` `^0.1.0-rc.3`.
Files now outlive instances: `createFileSystem` makes a sandbox that is paused without memory and is the file
system, `destroy` / `suspend` only pause it, `create` reconnects it and throws `FileSystemGoneError` when E2B
reports it gone, and `destroyFileSystem*` delete it (legacy names too). The `template` setting is now
optional: when empty, a template is built from the published image
`ghcr.io/capybara-hq/capybara-sandbox:<plugin version>` under the non-public alias `capybara-sandbox-<tag>`
and the build status is polled until ready. Both sandbox plugins now release with one version.
