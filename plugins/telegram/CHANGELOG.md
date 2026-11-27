# @capybara-hq/plugin-telegram

## 0.1.0-rc.15

### Patch Changes

- a81be16: Render a question form's `choices` as buttons (the first primary, a click answers at once, a boolean
  stays a boolean) and show its `body` text on the card; a form without choices is unchanged
  (plugins#241).

## 0.1.0-rc.14

### Patch Changes

- 45c4b18: Draws the run's progress card natively (`features.progress`): the title and meta, the status
  line and the pinned text, the latest steps as preformatted text (never links), and the pending
  actions and the web link as link buttons; the card is edited in place as the run goes on. A card
  kind this plugin does not know falls back to the SDK's text form instead of failing.

## 0.1.0-rc.13

### Patch Changes

- fd77b82: The deployment config is marked platform-only (unified plugin config, core#720): this plugin has no
  org-bound entry, so an org never overrides its fields.

## 0.1.0-rc.12

### Minor Changes

- 23a4b92: Send conversation files: the channel implements `sendFile` (`features.files`: 50 MB documents,
  10 MB photos). An image goes out as a photo, and once more as a document when Telegram refuses the
  picture; any other file is a document, one message per file in the conversation's chat, thread and
  topic. A 413 maps to `too_large`. No bot permission change is needed.

## 0.1.0-rc.11

### Patch Changes

- acf43de: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.27, @capybara-hq/testing 0.1.0-rc.21,
  @capybara-hq/plugin-tools 0.1.0-rc.16 and @capybara-hq/plugin-model-fake 0.1.0-rc.28 (kernel
  0.1.0-rc.37: `model-provider@2` only, model providers opt-in per org, `FetchAttachment`).

## 0.1.0-rc.10

### Patch Changes

- 2526db2: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.19 (context providers, conversation sources,
  lifecycle hooks), @capybara-hq/plugin-model-fake 0.1.0-rc.19 and @capybara-hq/testing 0.1.0-rc.17
  (pgvector test containers). No behaviour change.

## 0.1.0-rc.9

### Patch Changes

- 4210a66: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.17 (the SDK with sandbox tiers) and
  @capybara-hq/plugin-model-fake 0.1.0-rc.17. sandbox-docker and sandbox-e2b drop their local tier
  types (`SandboxTier`, `TierLimits`, `TieredSandboxLimits`, `TieredSandboxProvider`) for the SDK's
  `SandboxLimits.tier`, `update` and `limitsApplyAt`. lark and slack label the approval state
  `skipped` (the person sent a message instead of deciding).

## 0.1.0-rc.8

### Patch Changes

- 202e2c0: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.14 and @capybara-hq/plugin-model-fake
  0.1.0-rc.14 (the new UI parts).

## 0.1.0-rc.7

### Patch Changes

- 667bb15: Group mentions need privacy mode off (or the bot as a group admin): with it on Telegram delivers
  only commands and replies to the bot. The README says so and `verify` warns while privacy mode is
  on, instead of warning when it is off.
- ec95022: Tables in replies render as real tables: a reply with a Markdown table is sent (and edited while it
  streams) as a Bot API rich message with a native table. When Telegram refuses the rich message, the
  reply goes out as plain HTML with each table as a list, as before.

## 0.1.0-rc.6

### Patch Changes

- c19fa5c: Question cards offer a text reply: with `textReply`, a question whose field allows "Other" still
  gets its option buttons (no Other button; the Other path is a plain reply) and a pending card shows
  the text-reply hint. The new `skipped` state (the person replied instead) has its label, and a
  state the plugin does not know shows the SDK's label instead of `undefined`.

## 0.1.0-rc.5

### Patch Changes

- 55df138: Markdown tables in replies are shown as lists (one item per row, led by its first cell in bold)
  instead of raw pipes; long messages split at line ends where they can.

## 0.1.0-rc.4

### Patch Changes

- bd696b4: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.11, @capybara-hq/testing 0.1.0-rc.14,
  @capybara-hq/plugin-tools 0.1.0-rc.12 and @capybara-hq/plugin-model-fake 0.1.0-rc.11 (client
  extensions).

## 0.1.0-rc.3

### Patch Changes

- f1b7696: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.10, @capybara-hq/testing 0.1.0-rc.13 and
  @capybara-hq/plugin-tools 0.1.0-rc.11 (setup guides v2).

## 0.1.0-rc.2

### Patch Changes

- 7dec2f6: Run on core plugin-sdk 0.1.0-rc.7 (testing rc.10, plugin-tools rc.8).

## 0.1.0-rc.1

### Patch Changes

- 12fd744: The plugin ships an icon (`icon.svg`): the Telegram logo from telegram.org (source and date in the README).
