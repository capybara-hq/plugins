# @capybara-hq/plugin-example-board

## 0.1.0-rc.4

### Patch Changes

- 64d564f: Repacked with the core#720 toolchain (plugin-sdk 0.1.0-rc.64): the package's static manifest no
  longer carries the removed `config.org` list. No behaviour change.

## 0.1.0-rc.3

### Patch Changes

- 8aea061: Declare route access (plugin-sdk 0.1.0-rc.23): the page and its script are `public`, the data
  routes (`/ui/cards`, `/ui/cards/:id`, `/ui/events`) are `embed`. The kernel verifies the embed token
  (Bearer or `?token=`) before the handler, which reads org, conversation and expiry from `caller`
  instead of calling `ctx.ui.verifyEmbedToken`; a platform-scope token gets 403.

## 0.1.0-rc.2

### Patch Changes

- 7dec2f6: Run on core plugin-sdk 0.1.0-rc.7 (testing rc.10, plugin-tools rc.8).

## 0.1.0-rc.1

### Patch Changes

- ce8d729: The plugin ships an icon (`icon.svg`): a line board icon.
