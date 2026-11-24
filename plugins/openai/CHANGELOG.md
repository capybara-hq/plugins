# @capybara-hq/plugin-openai

## 0.1.0-rc.12

### Minor Changes

- c46a3de: Every deployment field (API key, API URL, organization, models, reasoning summary, image models)
  is org-overridable. Calls for an org use the org's whole effective config: an org copy without an
  API key fails with `auth` before any request and never falls back to the platform key, and an org's
  own API URL goes through the kernel's guarded network client. The platform may leave the key and
  models empty. Needs the SDK release with `configUrlFetch` and `platformOnly`.
  
  The `openai` SDK client reads no `OPENAI_*` host environment variable: the key, admin key,
  organization, project, webhook secret and base URL are always explicit, and `OPENAI_CUSTOM_HEADERS`
  (which the SDK merges into every request, even over the key) is dropped, so no host value reaches
  an org-chosen URL.

## 0.1.0-rc.11

### Patch Changes

- 75a00e4: Image generation: the `imageModels` deployment setting offers GPT image models (`gpt-image-1.5`, `gpt-image-1-mini`, `gpt-image-2`, `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`) through `generateImage`, using `/v1/images/generations` and, with reference images, `/v1/images/edits`. Moderation rejections map to `refusal`.
  An unknown id in `imageModels` is ignored with a warning instead of failing the config; reference images must be PNG, JPEG or WebP; a response with fewer `b64_json` images than asked is a `server` error.

## 0.1.0-rc.10

### Patch Changes

- acf43de: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.27, @capybara-hq/testing 0.1.0-rc.21,
  @capybara-hq/plugin-tools 0.1.0-rc.16 and @capybara-hq/plugin-model-fake 0.1.0-rc.28 (kernel
  0.1.0-rc.37: `model-provider@2` only, model providers opt-in per org, `FetchAttachment`).

## 0.1.0-rc.9

### Patch Changes

- 2526db2: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.19 (context providers, conversation sources,
  lifecycle hooks), @capybara-hq/plugin-model-fake 0.1.0-rc.19 and @capybara-hq/testing 0.1.0-rc.17
  (pgvector test containers). No behaviour change.

## 0.1.0-rc.8

### Patch Changes

- 4210a66: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.17 (the SDK with sandbox tiers) and
  @capybara-hq/plugin-model-fake 0.1.0-rc.17. sandbox-docker and sandbox-e2b drop their local tier
  types (`SandboxTier`, `TierLimits`, `TieredSandboxLimits`, `TieredSandboxProvider`) for the SDK's
  `SandboxLimits.tier`, `update` and `limitsApplyAt`. lark and slack label the approval state
  `skipped` (the person sent a message instead of deciding).

## 0.1.0-rc.7

### Patch Changes

- 202e2c0: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.14 and @capybara-hq/plugin-model-fake
  0.1.0-rc.14 (the new UI parts).

## 0.1.0-rc.6

### Patch Changes

- bd696b4: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.11, @capybara-hq/testing 0.1.0-rc.14,
  @capybara-hq/plugin-tools 0.1.0-rc.12 and @capybara-hq/plugin-model-fake 0.1.0-rc.11 (client
  extensions).

## 0.1.0-rc.5

### Patch Changes

- 70a5937: Official vendor icons: the Model Studio mark for Bailian, the Volcengine mark for Ark and the OpenAI
  Blossom for OpenAI, in place of the generic icon.

## 0.1.0-rc.4

### Patch Changes

- f1b7696: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.10, @capybara-hq/testing 0.1.0-rc.13 and
  @capybara-hq/plugin-tools 0.1.0-rc.11 (setup guides v2).

## 0.1.0-rc.3

### Patch Changes

- 7dec2f6: Run on core plugin-sdk 0.1.0-rc.7 (testing rc.10, plugin-tools rc.8).

## 0.1.0-rc.2

### Patch Changes

- ce8d729: The plugin ships an icon (`icon.svg`): a generic model-provider icon (no official OpenAI asset could be downloaded).

## 0.1.0-rc.1

### Patch Changes

- 726eacb: Run on core 0.1.0-rc.4: bilingual config field labels and a display name.
