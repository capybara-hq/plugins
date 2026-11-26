# @capybara-hq/plugin-deepseek

## 0.1.0-rc.12

### Patch Changes

- 324a502: Stream tool call input: emit `tool_call_start` and `tool_call_delta` events as the arguments arrive (an id the upstream omits is synthesized once and reused in `message_complete`).

## 0.1.0-rc.11

### Patch Changes

- fd77b82: The deployment config drops `orgAccess`: every field is org-overridable by default (unified plugin
  config, core#720). An org's own base URL goes through `configUrlFetch`.
  
  The `openai` SDK client reads no `OPENAI_*` host environment variable: the key, admin key,
  organization, project, webhook secret and base URL are always explicit, and `OPENAI_CUSTOM_HEADERS`
  (which the SDK merges into every request, even over the key) is dropped, so no host value reaches
  an org-chosen URL.

## 0.1.0-rc.10

### Minor Changes

- 0a75f1b: An org's own `baseUrl` (the overridable field, when it differs from the platform's) is requested
  through the kernel's guarded `ctx.net.fetch` with the org's id, for listing and streaming: an org
  admin can no longer point the provider at an internal address the super admin did not allow for the
  org. A refusal is a `ModelError` of kind `invalid_request` that names the host. The platform's own
  base URL keeps the global `fetch`. Requires `@capybara-hq/plugin-sdk@^0.1.0-rc.29`.

## 0.1.0-rc.9

### Patch Changes

- acf43de: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.27, @capybara-hq/testing 0.1.0-rc.21,
  @capybara-hq/plugin-tools 0.1.0-rc.16 and @capybara-hq/plugin-model-fake 0.1.0-rc.28 (kernel
  0.1.0-rc.37: `model-provider@2` only, model providers opt-in per org, `FetchAttachment`).

## 0.1.0-rc.8

### Patch Changes

- 2526db2: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.19 (context providers, conversation sources,
  lifecycle hooks), @capybara-hq/plugin-model-fake 0.1.0-rc.19 and @capybara-hq/testing 0.1.0-rc.17
  (pgvector test containers). No behaviour change.

## 0.1.0-rc.7

### Patch Changes

- 4210a66: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.17 (the SDK with sandbox tiers) and
  @capybara-hq/plugin-model-fake 0.1.0-rc.17. sandbox-docker and sandbox-e2b drop their local tier
  types (`SandboxTier`, `TierLimits`, `TieredSandboxLimits`, `TieredSandboxProvider`) for the SDK's
  `SandboxLimits.tier`, `update` and `limitsApplyAt`. lark and slack label the approval state
  `skipped` (the person sent a message instead of deciding).

## 0.1.0-rc.6

### Patch Changes

- 202e2c0: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.14 and @capybara-hq/plugin-model-fake
  0.1.0-rc.14 (the new UI parts).

## 0.1.0-rc.5

### Patch Changes

- bd696b4: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.11, @capybara-hq/testing 0.1.0-rc.14,
  @capybara-hq/plugin-tools 0.1.0-rc.12 and @capybara-hq/plugin-model-fake 0.1.0-rc.11 (client
  extensions).

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
