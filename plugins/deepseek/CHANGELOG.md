# @capybara-hq/plugin-deepseek

## 0.1.0-rc.4

### Patch Changes

- e6f6d06: The API key is required in the deployment config. A deployment without one now shows the provider as
  needing configuration (each organization following the platform needs its own key) instead of as
  failing to list its models. The key stays overridable, so an organization can still bring its own.

## 0.1.0-rc.3

### Patch Changes

- f1b7696: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.10, @capybara-hq/testing 0.1.0-rc.13 and
  @capybara-hq/plugin-tools 0.1.0-rc.11 (setup guides v2).

## 0.1.0-rc.2

### Patch Changes

- 7dec2f6: Run on core plugin-sdk 0.1.0-rc.7 (testing rc.10, plugin-tools rc.8).

## 0.1.0-rc.1

### Patch Changes

- ce8d729: The plugin ships an icon (`icon.svg`): the DeepSeek whale mark (source and date in the README).
