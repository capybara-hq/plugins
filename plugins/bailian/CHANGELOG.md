# @capybara-hq/plugin-bailian

## 0.1.0-rc.13

### Patch Changes

- 9f96623: Long conversations now cache their history, not only the system prompt: the last content block of
  the history carries DashScope's explicit `cache_control` marker, so each turn reads the whole earlier
  conversation from the cache (explicit and implicit caching exclude each other per request, so with
  only the system marker the history got neither). Verified live on qwen4-max, qwen3.7-max,
  qwen3.8-flash, qwen-plus and glm-5.1.

## 0.1.0-rc.12

### Patch Changes

- 324a502: Stream tool call input: emit `tool_call_start` and `tool_call_delta` events as the arguments arrive (an id the upstream omits is synthesized once and reused in `message_complete`).

## 0.1.0-rc.11

### Patch Changes

- fd77b82: The deployment config drops `orgAccess`: every field is org-overridable by default (unified plugin
  config, core#720).

## 0.1.0-rc.10

### Patch Changes

- 4ec9b98: Image generation: the Qwen-Image 2.0 models and wan2.6-t2i (sync multimodal-generation) and
  wan2.5 / wan2.2 / wanx2.1 / wanx2.0 text-to-image models (async task, polled inside the call) list
  `imageGeneration` and are callable through `generateImage`. Result images are downloaded inside the
  call and returned as bytes; content moderation rejections are `refusal`.
  Downloads are capped at 50 MB and never follow redirects (both `server`); a throttled (429) task
  poll waits longer and keeps polling instead of failing the call.

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

- ce8d729: The plugin ships an icon (`icon.svg`): a generic model-provider icon (no public Model Studio brand asset found).
