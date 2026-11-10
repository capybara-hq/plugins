# @capybara-hq/plugin-telegram

The official Telegram plugin. It provides one capability:

- `channel@1` (bot): talk to Capybara agents in a private chat with a Telegram bot, or by mentioning the bot in a group.
  Messages arrive by long polling (`getUpdates`, the default, no public URL needed) or by webhook (optional),
  replies are sent with `sendMessage` and streamed by editing, and approval / question / connection / binding
  cards are rendered as inline keyboards.

It does not provide login (`identity-source@1`) or a directory (`directory@1`); see [Out of scope](#out-of-scope).

Identity: `identities.source` = `telegram:global`, `external_id` = the Telegram user id (decimal). Telegram user ids are
global (one person has the same id for every bot), so one person is one identity across every Telegram bot of a deployment.

The Telegram docs cited here are the [Bot API reference](https://core.telegram.org/bots/api) (Bot API 10.3), consulted on 2026-11-08.

Verified live on 2026-11-08 against a real bot: verify, send, edit, a 5000-character split send and a card with an inline callback keyboard, in a private chat and in a basic group. Verified live on 2026-11-10: a reply with a table sent as a rich message, and a plain draft edited into one and edited again, in a private chat (live test `rich table`; in Node, a slow IPv4 connect can lose to an unreachable IPv6 address: run it with `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=3000` if every call fails with a network error). Not covered live: a person clicking a card button, webhook mode and forum supergroups.

## Create the bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`. Pick a display name and a username
   (it must end in `bot`). BotFather replies with the bot token, such as `123456:ABC-DEF…`
   ([Bot API: authorizing your bot](https://core.telegram.org/bots/api#authorizing-your-bot)). Treat it like a password.
2. **Privacy mode** (`/setprivacy`): leave it **enabled** (the default). With it on, a bot in a group receives only
   commands, mentions of the bot and replies to the bot's own messages, which is exactly what this plugin forwards
   ([Bot API: `getMe`, `can_read_all_group_messages`](https://core.telegram.org/bots/api#getme)).
   If you turn it off the bot receives every group message; the plugin still forwards only mentions and replies to
   the bot, and `verify` logs a warning. Telegram applies a privacy change to a group only after the bot is removed from the group and added again.
3. **Groups** (`/setjoingroups`): enable it if people should add the bot to groups, disable it for a private-only bot.
4. **Topics in private chats**: leave the bot's topic mode off. It is not supported (see [Behavior](#behavior)); `verify` warns when it is on.
5. In the Capybara org settings, enable the `telegram` plugin, then **create a new channel connection** under Channels:
   pick Telegram as the plugin, fill in the bot token (`botToken`) and bind an agent. The token is stored in the secret
   store and the API only returns "set".
6. In Telegram, open the bot and press **Start** (see [Binding](#binding)). The first message gets a binding card; open its link to confirm the binding on the web page.

## Binding

A person must bind their Telegram user to a Capybara account before the agent answers. The kernel sends the binding card
in the private chat only.

- **Press Start once.** A bot cannot message a user who never started it: Telegram answers 403 ("Forbidden: bot can't initiate conversation with a user"),
  which the plugin maps to `target_gone`. So the first step for everyone is to open the bot and press **Start** (or send any message).
- **Start is a message.** Pressing Start sends `/start`, and the plugin forwards it like any other text: that is what gives a new
  user the binding card. A user who is already bound and presses Start again (for example after clearing the chat) sends `/start` to the agent.
- **In a group**, an unbound person who mentions the bot gets a "bind in a private chat" reply instead of a card: open the bot, press Start, and bind there.
- **The `anonymous` unbound policy has no effect on Telegram.** A Telegram bot is reachable by anyone who finds it, so
  anonymous guests would let the whole internet use an org's agent and model budget (maintainer decision). Every Telegram user is *external*
  to the connection: `verify` returns the tenant `bot<bot id>` while every inbound sender's tenant is `global`, and the kernel never lets an external sender be an anonymous guest.
  A connection set to `anonymous` therefore gives an unbound person the binding reply, not an agent run.

## Channel connection config

Shown in the form with zh / en labels and help.

| Field | Label | Description |
|---|---|---|
| `botToken` | Bot token / 机器人令牌 | `<bot id>:<secret>` from @BotFather (secret) |
| `webhookSecret` | Webhook secret / Webhook 密钥 | Secret, 1-256 characters of `A-Z a-z 0-9 _ -`; only needed in [webhook mode](#webhook-mode-optional) (the `secret_token` you give `setWebhook`), leave empty for long polling |

## Deployment-level config

| Field | Default | Description |
|---|---|---|
| `apiUrl` | `https://api.telegram.org` | Bot API root URL; change it only in tests or when going through a reverse proxy |

The deployment-level config lives under the kernel config `extensionConfig.telegram`. There is no org-level config.

## Behavior

- **Private chats**: every text message goes to the kernel (`chatType: "dm"`, one conversation per user). Topic mode in
  private chats (`has_topics_enabled`) is **not supported**: the kernel keys a private chat as one thread per user. `verify` warns when it is on; keep it off.
- **Groups and supergroups**: only messages that mention the bot (`@<username>`, a text mention, or a command addressed to the bot such as `/cmd@botname`)
  and replies to one of the bot's messages (a reply to the bot counts as a mention, since people address a bot by replying to it). Other group messages are dropped.
- **Threads**: each mention that is not a reply starts its own conversation, and replies continue it. Telegram replies only point to their direct parent,
  so the plugin records the thread of every message it sends into a group and of every inbound group message it forwards (kv, 30 days). A reply to a bot message older than that, or to an unknown message, starts a new conversation.
  Replies are sent as replies to the thread's root message.
- **Forum supergroups behave like groups.** A forum topic is only where the messages live, never the conversation key (otherwise a topic would become one ever-growing conversation):
  each mention starts a conversation and replies continue it. The plugin remembers the topic (`message_thread_id`, kv, 30 days) so replies land in the right topic. `/new` works only in private chats.
- **Ignored**: edited messages, channel posts, messages from bots, service messages (a group becoming a supergroup is logged; the old conversations in it then stop receiving replies), messages without text or caption.
  A caption on media is taken as the text; the media itself is ignored.
- **Text**: the bot mention is removed, a leading `/` is kept exactly where the person typed it (`/cmd@botname` becomes `/cmd`; commands are the kernel's), and mentions of other people become readable `@name`.
  The speaker's display name is first + last name from the update itself; there is no avatar (getting one needs two more calls and exposes a file URL that carries the token).
- **ids**: message id = `<chat id>:<message id>` (the chat id may be negative); the card-click `eventId` = the `callback_query.id`.
  Messages with `message_id` 0 (ephemeral or scheduled) send no event: they have no stable id.
- **Format**: the model reply's Markdown is converted to Telegram HTML (`parse_mode: "HTML"`); everything else is escaped.
  Link previews are off. Links are limited to http(s): `tg://` and other schemes stay plain text, so model text cannot produce `tg://user?id=…` mentions.
  A raw `@username` in model text would notify people, so the converter puts a U+2060 WORD JOINER after the `@` outside code and links, and Telegram no longer parses it as a mention.
- **Tables**: a reply with a Markdown (GFM) table is sent as a [rich message](https://core.telegram.org/bots/api/rich-messages)
  (Bot API 10.1: [`sendRichMessage`](https://core.telegram.org/bots/api#sendrichmessage), and `editMessageText` with `rich_message` while it streams),
  so the table renders natively (bordered, striped, column alignment from the delimiter row). The rest of the reply goes through the same converter
  as plain replies (escaping, http(s)-only links, the mention guard), as rich HTML with `<br>` line breaks (rich HTML collapses bare newlines).
  A rich message holds up to 32768 characters, so such a reply is never split. A table wider than 20 columns becomes the list described below;
  a reply over 500 blocks (table rows count) or 32768 characters, or one with cards, is sent as plain HTML.
  When Telegram refuses the rich message for its content (any 400, or 404 from a Bot API server without the method), the same reply is sent or edited
  as plain HTML, where each table is a list (one item per row, led by its first cell); flood waits, 5xx and a blocked bot are not retried as plain HTML.
  Telegram turns a text message into a rich one and back on edit, so streaming keeps the send-then-edit flow (no delete and resend, no extra notification).
- **Limit and splitting**: one plain message holds at most 4096 characters after entity parsing
  ([`sendMessage`, `text`](https://core.telegram.org/bots/api#sendmessage)); longer text is split into several messages and the last id is returned.
  An edit that would need several messages reports `too_large` and the kernel sends a new message instead.
- **Streaming edits**: replies are sent and then edited ([`editMessageText`](https://core.telegram.org/bots/api#editmessagetext)); `minEditIntervalMs = 3000`.
  Telegram's limit for a group is about 20 messages per minute ([Broadcasting to users, FAQ](https://core.telegram.org/bots/faq))
  and edits count; a 429 is honored through `retry_after`. "message is not modified" on an edit counts as success.
  [`sendMessageDraft`](https://core.telegram.org/bots/api#sendmessagedraft) and `sendRichMessageDraft` are not used: it exists only in private chats, is a 30-second preview that must be followed by a real
  `sendMessage`, and does not fit the kernel's send-then-edit model.
- **Idempotency**: the Bot API has no idempotent send, so `idempotencyKey` is ignored. A send whose response is lost and is retried can show the message twice; the alternative (never retrying) would lose messages.
- **Permission manifest**: `network: ["api.telegram.org"]`, shown only and not enforced.

## Cards

Approval, question, connection and binding cards are the message text plus an **inline keyboard** ([`InlineKeyboardMarkup`](https://core.telegram.org/bots/api#inlinekeyboardmarkup)),
with button labels in the org's language. Link buttons are used only for http(s) URLs.

- **One message per card.** The kernel sends a card with a short line of text ("Your input is needed") and later updates it the same way, so
  the text leads the card's own message (left out when it repeats the card's title) and the update edits that one message. A card message is
  never split: over 4096 characters the text is cut first, then the card, each ending in "…". Text without a card is split as described above.
- **Rejected link buttons.** Telegram refuses some link-button URLs that work as links in text, such as `http://localhost:3000/...`
  ("Wrong HTTP URL"; `127.0.0.1` and LAN addresses are accepted). When a send or edit is refused for that reason, the plugin sends it once more
  without link buttons and puts the link into the card text; callback buttons stay.

- `callback_data` is limited to 64 bytes ([`InlineKeyboardButton`](https://core.telegram.org/bots/api#inlinekeyboardbutton)), too small for a card id, action, scope and answer.
  Each button carries `cb:` plus a random 16-character token; the payload lives in kv for **30 days**, and any replica can decode it. A click whose token is missing, expired or malformed is answered and ignored.
  After 30 days a card's buttons stop working; use the card's "open on web" link.
- A question card with a single single-choice field of at most 5 options shows one button per option. Any other question (several fields, a multi-select field, a field that allows "other", a non-enum field, or more than 5 options) is answered on the web: its card carries only the link.
- A decided or expired card is edited to its new state without its action buttons; only the "Open on web" link button stays.
- Every click is answered with `answerCallbackQuery` (no text) so the client's progress indicator stops. In long polling this happens after the kernel accepted the click.

## Errors

| Telegram | `ChannelSendError` |
|---|---|
| 429 | retryable, waits `retry_after` |
| 5xx, network error, timeout | retryable |
| 401 Unauthorized | `auth` (not retryable) |
| 403 (bot blocked, kicked, can't initiate conversation) | `target_gone` |
| 400 chat not found, or the group migrated to a supergroup | `target_gone` |
| 400 message too long | `too_large` |
| other 400 | `rejected` |

The Bot API puts the token in the URL path (`/bot<token>/<method>`), so error messages and logs carry only the method, Telegram's `error_code` and its short description, never the URL.

## Long polling (default)

`connect` calls `getUpdates` in a loop (25-second long poll, `allowed_updates=["message","callback_query"]`), held by one `gateway` replica per connection.

- The offset is confirmed only **after the kernel accepted** the update (`onEvent` resolved, or the update was ignored). If `onEvent` rejects, the loop backs off and fetches the same update again; Telegram keeps updates for 24 hours.
  The confirmed offset is also kept in kv (7 days), so the replica that takes over after a failover resumes where the last one stopped (a repeat is safe: the kernel dedupes by message id).
- `connect` never changes webhook state behind your back. If a webhook is set for the bot, it fails with "A webhook is set for this Telegram bot; switch the connection to webhook mode or call deleteWebhook"
  (check with [`getWebhookInfo`](https://core.telegram.org/bots/api#getwebhookinfo)).
- **409 Conflict** means another client is polling the same bot (another deployment, a script, a second connection with the same token). The connection fails with "another client is polling this bot" and the kernel records `last_error`. A 401 fails with "bot token rejected".
- Network errors back off exponentially with jitter (cap 30 seconds); 5 failures in a row end `connect` with an error, and the kernel records `last_error` and takes over.

## Webhook mode (optional)

A connection can instead receive updates over HTTPS, when the deployment exposes a gateway replica and sets `channels.webhookBaseUrl` (see
[Deploying: webhook](https://github.com/capybara-hq/core/blob/main/docs/deploy/README.md#webhook-optional)). Switch the connection to webhook mode in the web app
(Channels → connection → Overview → Inbound mode); the connection page then shows its webhook URL. The plugin never calls `setWebhook` itself; you do, once:

1. Choose a secret (1-256 characters of `A-Z a-z 0-9 _ -`) and put it into the connection's `webhookSecret`. Every request is checked against it
   (the `X-Telegram-Bot-Api-Secret-Token` header, compared in constant time); without it every webhook request is refused with 401.
2. Register the webhook ([`setWebhook`](https://core.telegram.org/bots/api#setwebhook)), with the `url` from the connection page:

   ```bash
   curl "https://api.telegram.org/bot<botToken>/setWebhook" \
     --data-urlencode "url=<webhook URL from the connection page>" \
     --data-urlencode "secret_token=<webhookSecret>" \
     --data-urlencode 'allowed_updates=["message","callback_query"]'
   ```

3. To go back to long polling, call [`deleteWebhook`](https://core.telegram.org/bots/api#deletewebhook) (long polling refuses to start while a webhook is set) and switch the connection back to long polling.

Both modes parse updates the same way (same message and click ids), so the kernel's dedupe drops a redelivery that arrives across a mode switch. The kernel acks (200) only after it accepted the update; a non-2xx makes Telegram retry.

Trade-off: the webhook contract gives the plugin no hook after the kernel accepted the update, so a card click is answered with `answerCallbackQuery` **before** the event is handed over.
If the kernel then answers non-2xx and Telegram redelivers, the spinner has already stopped; the click itself is not lost and the redelivery is deduped.

## Out of scope

- **Login (`identity-source@1`)**: Telegram login gives no email and its widget does not fit the kernel's redirect / callback flow; binding through the bot already links a Telegram user to an account (maintainer decision).
- **Directory (`directory@1`)**: the Bot API cannot list group members and Telegram has no organization concept (maintainer decision).
- **Media**: attachments, voice, stickers, polls, inline mode, business accounts and broadcast channels are not handled; media without a caption sends no event.
- **Proxy**: no proxy support for networks where `api.telegram.org` is unreachable (maintainer decision); `apiUrl` can point at a reverse proxy you run.

## Icon

`icon.svg`: the Telegram logo (owner: Telegram), downloaded on 2026-11-09 from
https://telegram.org/tour/screenshots ("Download Telegram Logos", file `Logo.svg`). Telegram lets
its logos be used as long as people understand you're not representing Telegram officially. It is a
trademark of its owner, used only to identify the service this plugin connects to; the plugin is
not affiliated with or endorsed by the owner. The artwork is unchanged except for removing editor
metadata.
