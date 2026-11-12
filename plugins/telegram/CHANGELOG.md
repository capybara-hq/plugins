# @capybara-hq/plugin-telegram

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
