# @capybara-hq/plugin-openai-compatible

## 0.1.0-rc.14

### Patch Changes

- d895495: The `qwen` dialect sends DashScope's explicit cache markers (the last cached system block and the
  last block of the history), so long conversations cache their history; the `ark` dialect defaults
  `caching` to true and sends a per-conversation `prompt_cache_key`.

## 0.1.0-rc.13

### Patch Changes

- 324a502: Stream tool call input: emit `tool_call_start` and `tool_call_delta` events as the arguments arrive (an id the upstream omits is synthesized once and reused in `message_complete`).

## 0.1.0-rc.12

### Minor Changes

- f85fccb: `endpoints` and `apiKeys` are org-overridable (core#720). Each call resolves the org's effective
  config as a whole (never mixing in a platform key) and builds its client per call. An endpoint URL
  the platform also configures keeps the global fetch; any other URL an org sets goes through the
  kernel's guarded client (`ctx.net.fetch`) with the org's id, and a refusal is an
  `invalid_request` naming the host. An org copy starts with `apiKeys: {}`, so a kept platform
  endpoint is called without a key unless the org enters one. Setup reads the platform config
  leniently: the platform may leave `endpoints` to the orgs.
  
  Needs a kernel whose `@capybara-hq/plugin-sdk` ships `configUrlFetch` and org-bound per-call
  config (the release of core#720).
  
  The `openai` SDK client reads no `OPENAI_*` host environment variable: the key, admin key,
  organization, project, webhook secret and base URL are always explicit, and `OPENAI_CUSTOM_HEADERS`
  (which the SDK merges into every request, even over the key) is dropped, so no host value reaches
  an org-chosen URL.

## 0.1.0-rc.11

### Patch Changes

- acf43de: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.27, @capybara-hq/testing 0.1.0-rc.21,
  @capybara-hq/plugin-tools 0.1.0-rc.16 and @capybara-hq/plugin-model-fake 0.1.0-rc.28 (kernel
  0.1.0-rc.37: `model-provider@2` only, model providers opt-in per org, `FetchAttachment`).

## 0.1.0-rc.10

### Patch Changes

- 39ab73d: The composed Capybara icon with the plugin's function mark.

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

- f1b7696: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.10, @capybara-hq/testing 0.1.0-rc.13 and
  @capybara-hq/plugin-tools 0.1.0-rc.11 (setup guides v2).

## 0.1.0-rc.4

### Patch Changes

- 7dec2f6: Run on core plugin-sdk 0.1.0-rc.7 (testing rc.10, plugin-tools rc.8).

## 0.1.0-rc.3

### Patch Changes

- ce8d729: The plugin ships an icon (`icon.svg`): a line icon for a compatible API.

## 0.1.0-rc.2

### Patch Changes

- 8d34176: The deepseek dialect sends mid-conversation system messages (sub-agent deliveries, background task
  notices, reminders) as in-place `[system] ` user turns instead of `role: "system"` messages, which
  DeepSeek did not keep in position; it now reports `midConversationSystem: false`. An endpoint can
  still opt back in with `midConversationSystem: true`.

## 0.1.0-rc.1

### Patch Changes

- 726eacb: Run on core 0.1.0-rc.4: bilingual config field labels and a display name.
