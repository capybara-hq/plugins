# @capybara-hq/plugin-sandbox-docker

## 0.1.0-rc.7

### Patch Changes

- 7dec2f6: Run on core plugin-sdk 0.1.0-rc.7 (testing rc.10, plugin-tools rc.8).

## 0.1.0-rc.6

### Patch Changes

- ce8d729: The plugin ships an icon (`icon.svg`): the Docker mark from Docker's media resources (source and date in the README).

## 0.1.0-rc.5

No changes in this release.

## 0.1.0-rc.4

### Minor Changes

- 62606bf: Provide `sandbox@2`. BREAKING: needs a kernel with environments and `@capybara-hq/plugin-sdk` `^0.1.0-rc.3`.
  Files now outlive instances: the workspace and skills volumes are created by `createFileSystem` (idempotent by
  name) and kept by `destroy`; `create` on missing volumes throws `FileSystemGoneError` instead of mounting empty
  ones, and `destroyFileSystem` / `destroyFileSystemByName` remove them (legacy `cap-<conversationId>` names
  too). `exec` takes a required `tag` and an `actor`. The default sandbox and egress proxy images are now the
  published `ghcr.io/capybara-hq/capybara-sandbox[-egress]:<plugin version>`; `egressProxyImage` has no schema
  default and `sandbox.image` stays optional. Both sandbox plugins now release with one version.

## 0.1.0-rc.2

### Patch Changes

- 52b3698: Kill a command's leftover processes at the in-sandbox deadline also where `timeout` is uutils
  (Ubuntu 26.04's default coreutils), which kills only its direct child.

## 0.1.0-rc.1

### Patch Changes

- 726eacb: Run on core 0.1.0-rc.4: bilingual config field labels and a display name.
