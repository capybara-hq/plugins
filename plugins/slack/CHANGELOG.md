# @capybara-hq/plugin-slack

## 0.1.0-rc.15

### Minor Changes

- 1e67e0f: The directory credentials move from the org config into the overridable deployment key
  `directory` (`{ teamId, botToken }`): an org saves its own as its copy, otherwise it follows the
  platform's (every org that follows the platform syncs that workspace's members). `directory@1`
  reads only `config.directory` of the org's effective config. `apiUrl`, `openidUrl` and the login
  client `clientId` / `clientSecret` are platform-only. Needs the SDK release with `platformOnly`.

### Patch Changes

- 6cb229b: Connector template descriptions in English and Chinese (`{ en, zh }`, plugin-sdk 0.1.0-rc.65), so a
  deployment shows each template's description in the page language.

## 0.1.0-rc.14

### Patch Changes

- 19123cd: Connector-template setup guides name their templates as `templates: [...]` (plugin-sdk
  0.1.0-rc.60 replaced the single `template` key).

## 0.1.0-rc.13

### Minor Changes

- 6b6cbff: Send conversation files: the channel implements `sendFile` (`features.files`: 1 GB, images
  included) through Slack's external upload (`files.getUploadURLExternal`, the upload POST,
  `files.completeUploadExternal`), one message per file in the conversation's channel and thread.
  The app needs the new bot scope `files:write`: admins re-paste the manifest from the setup guide (or
  add the scope under OAuth & Permissions) and reinstall the app to the workspace; the `bot-scopes`
  check names it until then. Without it the replies still arrive and files are delivered as links
  (a missing scope on an upload is `rejected`, not `auth`).
  The permission manifest gains the network host `files.slack.com` (where uploads go), so the upgrade
  asks the super admin to re-approve the plugin's permissions.

## 0.1.0-rc.12

### Patch Changes

- acf43de: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.27, @capybara-hq/testing 0.1.0-rc.21,
  @capybara-hq/plugin-tools 0.1.0-rc.16 and @capybara-hq/plugin-model-fake 0.1.0-rc.28 (kernel
  0.1.0-rc.37: `model-provider@2` only, model providers opt-in per org, `FetchAttachment`).

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

- 202e2c0: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.14 and @capybara-hq/plugin-model-fake
  0.1.0-rc.14 (the new UI parts).

## 0.1.0-rc.8

### Patch Changes

- c19fa5c: Question cards offer a text reply: with `textReply`, a question whose field allows "Other" still
  gets its option controls (no Other button; the Other path is a plain reply) and a pending card shows
  the text-reply hint. The new `skipped` state (the person replied instead) has its label, and a
  state the plugin does not know shows the SDK's label instead of `undefined`.

## 0.1.0-rc.7

### Patch Changes

- 55df138: Markdown tables in replies are sent as native Block Kit table blocks (one per message, split by
  rows past 100 rows or 10,000 characters, with the header repeated); the notification text, tables
  over 20 columns and messages Slack rejects show each row as a list item instead of raw pipes.
- 368f9a1: The app-level token belongs to long connection and the signing secret to webhook (`inboundModes`
  hints): 新建渠道 and the credentials tab draw and require each only in its mode.

## 0.1.0-rc.6

### Patch Changes

- bd696b4: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.11, @capybara-hq/testing 0.1.0-rc.14,
  @capybara-hq/plugin-tools 0.1.0-rc.12 and @capybara-hq/plugin-model-fake 0.1.0-rc.11 (client
  extensions).
- c7e141f: The Slack setup guide saves the channel before asking for webhook addresses; the bot shows as Capybara.

## 0.1.0-rc.5

### Minor Changes

- f1b7696: Setup guides v2: the channel guide `slack-app` and the new connector template guide
  `slack-connector` are Markdown documents (`guides/*.md`, with Chinese translations) with mode and
  audience sections, titled manifest code blocks and live check rows. The extension registers three
  read-only setup checks (`permissions.setupChecks`): `bot-token` (`auth.test`), `bot-scopes` (the
  bot token's scopes against the manifest) and `app-token` (`apps.connections.open`, Socket Mode
  only). The v1 manifest templates and `app-manifest.connector.yaml` are gone; the README points at
  the in-product guides.

## 0.1.0-rc.4

### Minor Changes

- 7dec2f6: The app manifest is now a setup guide (`slack-app`): Capybara renders it for each channel connection,
  with the connection name, the Sign in with Slack callback and, in webhook mode, the webhook URL as
  every Request URL (`app-manifest.yaml` is replaced by `guides/`). Inbound senders carry their Slack
  time zone and language (`users.info` `tz` / `locale`, cached in kv per team and user). The approval
  card shows the call summary as plain text labelled Summary / 摘要. New connector template `slack`
  (off by default): per-person OAuth to Slack's MCP server through connector-mcp, with
  `app-manifest.connector.yaml` for the internal OAuth app.

## 0.1.0-rc.3

### Patch Changes

- ce8d729: The plugin ships an icon (`icon.svg`): the Slack mark from the Slack media kit (source and date in the README).

## 0.1.0-rc.2

### Patch Changes

- 63d79ae: Slash commands `/new`, `/env` and `/capybara <skill> [args]` reach the kernel as the text it parses
  (Slack rejected unregistered `/` messages), and the org-level and channel connection config fields
  get zh / en labels and help (the org fields say they are optional and only for member sync).
  Existing apps re-paste the manifest (or add the commands and the `commands` / `im:write` scopes) and
  reinstall.

## 0.1.0-rc.1

### Patch Changes

- 726eacb: Run on core 0.1.0-rc.4: bilingual config field labels and a display name.
