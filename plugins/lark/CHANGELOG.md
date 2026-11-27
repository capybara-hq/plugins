# @capybara-hq/plugin-lark

## 0.1.0-rc.17

### Patch Changes

- 1f286ab: Question cards label the new `woken` state (a watched wait its watcher ended, core#939):
  等待已结束 / Wait ended, grey.
- a81be16: Render a question form's `choices` as buttons (the first primary, a click answers at once, a boolean
  stays a boolean) and show its `body` text on the card; a form without choices is unchanged
  (plugins#241).

## 0.1.0-rc.16

### Patch Changes

- 0ab87da: Draws the run's progress card natively (`features.progress`): the title and meta, the status
  line and the pinned text, the latest steps as preformatted text (never links), and the pending
  actions (at most 20 as buttons, the rest counted in one line) and the web link as link buttons;
  the card is edited in place as the run goes on. A card kind this plugin does not know falls back
  to the SDK's text form instead of failing.

## 0.1.0-rc.15

### Patch Changes

- 2396551: Lark login declares its tenant (the `tenant_key`), so the admin console labels trusted tenants. The
  sign-in guide and README turn the login on in the extension page's 「登录」 section (or
  `login-sources.update`) instead of the removed `auth.loginSources` / `auth.trustedIdentitySources`, and
  say that an unlinked account (also one linked only through the bot's binding card) goes to the link
  page by default. Needs `@capybara-hq/plugin-sdk` 0.1.0-rc.77 and kernel 0.1.0-rc.94.
- f535a1e: Slack and Lark ship a platform setup guide for their sign-in (`slack-sign-in`, `lark-sign-in`,
  place `extension-deployment`) with the callback URL filled in; the Google sign-in guide now says
  that `auth.loginSources` is kernel config, not a platform setting.

## 0.1.0-rc.14

### Minor Changes

- 1e67e0f: The directory app moves from the org config into the overridable deployment key `directory`
  (`{ appId, appSecret }`): an org saves its own app as its copy, otherwise it follows the
  platform's (every org that follows the platform syncs that tenant's members). `directory@1` reads
  only `config.directory` of the org's effective config. `region`, `apiUrl`, `accountsUrl` and the
  login app `appId` / `appSecret` are platform-only. The same-app guard against the login app stays.
  Needs the SDK release with `platformOnly`.

## 0.1.0-rc.13

### Minor Changes

- 8ba30b9: Send conversation files as native Lark images and files (`sendFile`: images up to 10 MB, files up to 30 MB). Admins must add the `im:resource` permission (获取与上传图片或文件资源) to the app and publish a new version; without it files are delivered as links.

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
