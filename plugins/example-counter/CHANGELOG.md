# @capybara-hq/plugin-example-counter

## 0.1.0-rc.4

### Patch Changes

- fd77b82: The deployment config is marked platform-only (unified plugin config, core#720): this plugin has no
  org-bound entry, so an org never overrides its fields.

## 0.1.0-rc.3

### Patch Changes

- 8aea061: Declare route access (plugin-sdk 0.1.0-rc.23): `/inc`, `/count` and `/inc-later` are `public`, a
  deployment-wide demo (the kernel rate-limits the public writes per client IP).

## 0.1.0-rc.2

### Patch Changes

- 7dec2f6: Run on core plugin-sdk 0.1.0-rc.7 (testing rc.10, plugin-tools rc.8).

## 0.1.0-rc.1

### Patch Changes

- ce8d729: The plugin ships an icon (`icon.svg`): a line counter icon.
