# @capybara-hq/plugin-ark

## 0.1.0-rc.12

### Patch Changes

- fd77b82: The deployment config drops `orgAccess`: every field is org-overridable by default (unified plugin
  config, core#720).
  
  The `openai` SDK client reads no `OPENAI_*` host environment variable: the key, admin key,
  organization, project, webhook secret and base URL are always explicit, and `OPENAI_CUSTOM_HEADERS`
  (which the SDK merges into every request, even over the key) is dropped, so no host value reaches
  Ark.

## 0.1.0-rc.11

### Patch Changes

- 203b5e7: Seedream 5.5, 5.0 flash, 5.0 pro and 4.0 list seven 1K image sizes (1024x1024, 1152x864,
  864x1152, 1248x832, 832x1248, 1280x720, 720x1280) besides the 2K set.

## 0.1.0-rc.10

### Patch Changes

- 3e9eb21: Image generation: Seedream models (5.5, 5.0 pro / flash / lite, 4.5, 4.0) list their image facts
  and are callable through `generateImage` (`/images/generations`, one image per call, base64,
  no watermark; an item without base64 data is a `server` error, URLs are never fetched);
  content moderation maps to `refusal`.

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
- 70a5937: Official vendor icons: the Model Studio mark for Bailian, the Volcengine mark for Ark and the OpenAI
  Blossom for OpenAI, in place of the generic icon.

## 0.1.0-rc.3

### Patch Changes

- f1b7696: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.10, @capybara-hq/testing 0.1.0-rc.13 and
  @capybara-hq/plugin-tools 0.1.0-rc.11 (setup guides v2).

## 0.1.0-rc.2

### Patch Changes

- 7dec2f6: Run on core plugin-sdk 0.1.0-rc.7 (testing rc.10, plugin-tools rc.8).

## 0.1.0-rc.1

### Patch Changes

- ce8d729: The plugin ships an icon (`icon.svg`): a generic model-provider icon (no public Volcengine Ark brand asset found).
