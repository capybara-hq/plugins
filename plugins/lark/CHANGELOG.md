# @capybara-hq/plugin-lark

## 0.1.0-rc.11

### Patch Changes

- 2526db2: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.19 (context providers, conversation sources,
  lifecycle hooks), @capybara-hq/plugin-model-fake 0.1.0-rc.19 and @capybara-hq/testing 0.1.0-rc.17
  (pgvector test containers). No behaviour change.

## 0.1.0-rc.10

### Patch Changes

- 4210a66: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.17 (the SDK with sandbox tiers) and
  @capybara-hq/plugin-model-fake 0.1.0-rc.17. sandbox-docker and sandbox-e2b drop their local tier
  types (`SandboxTier`, `TierLimits`, `TieredSandboxLimits`, `TieredSandboxProvider`) for the SDK's
  `SandboxLimits.tier`, `update` and `limitsApplyAt`. lark and slack label the approval state
  `skipped` (the person sent a message instead of deciding).

## 0.1.0-rc.9

### Patch Changes

- 8ef540a: The plugin icon is the Lark logo instead of a generic chat bubble.

## 0.1.0-rc.8

### Patch Changes

- 202e2c0: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.14 and @capybara-hq/plugin-model-fake
  0.1.0-rc.14 (the new UI parts).

## 0.1.0-rc.7

### Patch Changes

- c19fa5c: Question cards offer a text reply: with `textReply`, a question whose field allows "Other" still
  gets its option controls (no Other button; the Other path is a plain reply) and a pending card shows
  the text-reply hint. The new `skipped` state (the person replied instead) has its label, and a
  state the plugin does not know shows the SDK's label instead of `undefined`.

## 0.1.0-rc.6

### Patch Changes

- 55df138: Markdown tables in replies render reliably in cards: a blank line around each table, escaped pipes
  kept inside cells, a table never split across cards when it fits (otherwise split by rows with the
  header repeated), and at most four tables per card.

## 0.1.0-rc.5

### Patch Changes

- bd696b4: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.11, @capybara-hq/testing 0.1.0-rc.14,
  @capybara-hq/plugin-tools 0.1.0-rc.12 and @capybara-hq/plugin-model-fake 0.1.0-rc.11 (client
  extensions).

## 0.1.0-rc.4

### Patch Changes

- f1b7696: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.10, @capybara-hq/testing 0.1.0-rc.13 and
  @capybara-hq/plugin-tools 0.1.0-rc.11 (setup guides v2).

## 0.1.0-rc.3

### Patch Changes

- 7dec2f6: The approval card shows the call summary as plain escaped text labelled Summary / 摘要 instead of
  an "Input" code block.

## 0.1.0-rc.2

### Patch Changes

- ce8d729: The plugin ships an icon (`icon.svg`): a generic chat icon (no public Lark brand asset found).

## 0.1.0-rc.1

### Patch Changes

- 726eacb: Run on core 0.1.0-rc.4: bilingual config field labels and a display name.
