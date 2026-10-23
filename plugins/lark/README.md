# @capybara-hq/plugin-lark

The official plugin for Lark (the international edition of Feishu, `open.larksuite.com`). It currently provides:

- `channel@1` (bot): receives message events and card callbacks over the Lark **long connection** (`WSClient` from the official SDK `@larksuiteoapi/node-sdk`)
  (no public callback URL needed) and sends messages through the OpenAPI; all replies and approval / question / connection / binding cards are rendered as interactive cards (JSON 2.0).

- `identity-source@1` (web login): Lark OAuth authorization code + PKCE, deployment-level config.
- `directory@1` (directory sync): walks the directory department by department, org-level config.

Identity key: `identities.source` = `lark:<tenant_key>`, `external_id` = the user's `open_id`; login, bot and directory sync all use the same key.

> **Login, bot and directory sync must use the same Lark self-built app.** `open_id` is per app (the same person has a different `open_id`
> in different apps), so switching apps breaks the identity match and one person becomes two accounts. Use the same `appId` in the deployment-level login config, in each org's channel connection and in the org-level
> directory config. The plugin checks this: when the deployment has a login app configured, a channel connection of the same tenant (when validated, and before every long connection is established,
> so a login app configured or changed later is also caught; the connection records the error and stops reconnecting) or a directory sync (on every page) that uses a different app is an error. It does not block only when the login app's
> credentials themselves are invalid (10014 / 10015); transient errors such as rate limits and network failures are reported as errors and retried later. There can be only one login app, so Lark login serves only the tenant that app belongs to; orgs of other tenants can still use the bot
> (click the binding card in IM to link an account).

The Lark docs cited here were consulted on 2026-10-20.

## Create the Lark app

The long connection **supports only enterprise self-built apps** (not store apps), see
[Receive events over a long connection](https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/use-websocket).

1. In the [Developer Console](https://open.larksuite.com/app) (开发者后台), **create an enterprise self-built app**. Under **Credentials & Basic Info** (凭证与基础信息) get the App ID
   (`cli_…`) and App Secret.
2. **Add app capabilities → Bot** (添加应用能力 → 机器人) (without the bot capability, sending messages fails with 230006).
3. Under **Permissions & Scopes** (权限管理), enable these permissions:

   | Permission | Purpose |
   |---|---|
   | `im:message.p2p_msg:readonly` (读取用户发给机器人的单聊消息; read DMs sent to the bot) | Receive DM messages |
   | `im:message.group_at_msg:readonly` (接收群聊中@机器人消息事件; receive events for messages that @-mention the bot in group chats) | Receive messages that @-mention the bot in groups |
   | `im:message:send_as_bot` (以应用的身份发消息; send messages as the app) | Send and reply to messages, update cards |
   | `tenant:tenant:readonly` (获取企业信息; get enterprise info) | Read `tenant_key` (the tenant) when validating the connection |
   | `contact:user.base:readonly` (获取用户基本信息; get basic user info) | The speaker's display name and avatar; people-change events |

   `im:message.group_msg` (获取群组中所有消息; get all messages in groups; a sensitive permission) is not needed: in groups only messages that @-mention the bot are handled.
   Under **Permissions & Scopes → Data permissions / Contacts permission scope** (权限管理 → 数据权限 / 通讯录权限范围), add the members whose profiles need to be looked up to the visible range (people outside the range can still chat; they just have no
   display name / avatar).
4. In the Capybara org settings, enable the `lark` plugin, then **create a new channel connection**: pick Lark as the plugin, fill in `appId` and `appSecret` (stored in the
   secret store; the API only returns "set"), and bind an agent. Once the connection is created the plugin establishes the long connection immediately; the next step, saving the subscription method, requires
   the developer console to see a running long connection.
5. **Events & Callbacks → Event Configuration** (事件与回调 → 事件配置): choose **Receive events through long connection** (使用长连接接收事件) as the subscription method, and add the events:
   - `im.message.receive_v1` (Receive messages v2.0, 接收消息 v2.0);
   - `contact.user.created_v3`, `contact.user.updated_v3`, `contact.user.deleted_v3` (employee onboarded / info changed / offboarded,
     used to trigger directory sync; may be skipped if you only use the bot).
6. **Events & Callbacks → Callback Configuration** (事件与回调 → 回调配置): choose **Receive callbacks through long connection** (使用长连接接收回调) as the subscription method, and add the callback `card.action.trigger` (card interaction callback, 卡片回传交互).
   The legacy card callback does not support long connections, see
   [Receive callbacks over a long connection](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/callback-subscription/configure-callback-request-address).
7. **Version Management & Release** (版本管理与发布): create a version, set the **availability scope** (可用范围) (who can talk to the bot; messaging a user outside the scope fails with 230013), and submit it for release.
8. In Lark, DM the bot, or add the bot to a group and @-mention it. The first conversation gets a binding card; click the button to confirm the binding on the web page.

Note: each app can have at most 50 long connections; long-connection push works in cluster mode, so when one app has several clients only one random client receives a message. Capybara has
only one replica hold one long connection per channel connection at any moment; don't configure the same Lark app into several channel connections or other programs at once.

## Behavior

- **Ack**: the long connection requires processing to finish within 3 seconds "without throwing, otherwise a timeout redelivery is triggered". The SDK sends the response frame automatically after the handler returns
  (return → `code 200`, throw → `code 500`). The plugin's handler returns only after the kernel's `onEvent` resolves; when `onEvent` rejects it
  rethrows, Lark receives a failure and redelivers later (the kernel dedupes by `message_id` / the callback's `event_id`). Ignored events are acked directly.
  **To be confirmed in live testing**: the docs state "throw means redelivery" for events, but whether a card callback (`card.action.trigger`) is likewise redelivered after a 500
  is **not yet verified**; it will be confirmed in live Lark testing. If it is not redelivered, that click is lost and the user has to click again.
- **Inbound**: DMs receive text (`text`) and rich text (`post`, handled as text: links are written as `[text](url)`, code blocks are kept); in groups, messages that @-mention
  the bot, and replies inside threads (the kernel currently handles only those that @-mention it). Other types such as images and files, the bot's own messages, and other events such as recalls are
  ignored. For the `@_user_N` placeholders in text: the bot itself is removed (only the whitespace on both sides is tidied; line breaks and indentation are kept), and other people are replaced with `@name`.
- **ids**: message id = `message_id` (`om_…`); group-chat thread id = the thread root message's `root_id` (`om_…`, not the `omt_…` of `thread_id`);
  the card-click `eventId` = the callback's `header.event_id` (the callback's unique identifier). The speaker's tenant = `sender.tenant_key`, on the same basis
  as `verify` (the `tenant_key` of the enterprise info API).
- **Group-chat threads**: when replying to an @-message in a group, use [Reply to message](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply)
  with `reply_in_thread: true`, so the reply goes into the thread rooted at that message.
- **Cards**: every message is sent as an interactive card ([JSON 2.0](https://open.larksuite.com/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure),
  `update_multi: true`), and updates all go through [Update a message card sent by the app](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch)
  (5 QPS per message, editable within 14 days, no total-count limit); the text message's "edit message" is not used, because it allows at most 20 edits per message. An approval card has one button per
  allowed scope + deny + a web link; when a question can be answered inside IM, single-choice becomes buttons and multi-choice becomes a multi-select dropdown in a form + submit, otherwise only a
  web link is given; after a state change the buttons are removed and only the status and a "Details" link are shown. The button's callback value is a compact JSON array (containing the card id and conversation type),
  parsed strictly and at most 2000 characters; link buttons use only http(s) addresses. The reply to a card callback is empty (the card is unchanged), and the card is updated by the kernel afterwards.
  The conversation type in the callback value is only a hint: a card can be forwarded and its value replayed with it (the card sets `enable_forward_interaction: false`, so a forwarded card is
  not interactive by default); the kernel relies on the target it recorded when the card was sent, and when the chat of the click does not match the card it only replies "cannot handle" and sends no binding link.
- **Format and injection protection**: the model reply's Markdown goes into the card rich text as-is (JSON 2.0 supports CommonMark); outside code, `<` and `&`
  are converted to `&#60;` / `&#38;`, and inside code `<at` (including the `&#60;at` / `&lt;at` entity forms) is split with an inserted zero-width space, so model text cannot write
  tags like `<at id=all></at>` to @ everyone or anyone (a plain-text `@all` in a card does not @ anyone). Only `http(s)://` and
  `mailto:` links become links (parentheses, brackets, spaces and the like in the address are percent-encoded); other addresses (`javascript:`, `lark://`…),
  images and reference-style links are shown as plain text.
- **Length**: a card message request body is at most 30 KB (230025). Each card body is at most 5000 characters, and longer text is split into several messages (the last id is returned);
  when an edit is too long it reports `too_large` and the kernel sends a new message instead.
- **Streaming edits**: `minEditIntervalMs = 1500`. The card update API overall allows 1000 per minute and 50 per second per app per tenant
  ([rate limit policy](https://open.larksuite.com/document/ukTMukTMukTM/uUzN04SN3QjL1cDN)); one edit per 1.5 seconds stays within the limit even with about 25 conversations
  streaming at once; under more concurrency, rate limiting (`99991400` + `x-ogw-ratelimit-reset`) is the backstop.
- **Idempotency**: `idempotencyKey` is used as Lark's `uuid` (within 1 hour at most one message is sent per uuid); when split into several messages, the i-th uses `<key>-<i>`.
- **Reconnect**: managed by the plugin (SDK auto-reconnect is turned off: it silently retries at the long interval the server sends, and failures never return to the caller). Before establishing the long connection it first fetches the
  tenant token and bot info, and a credential error is reported immediately; after a disconnect it reconnects immediately, connection failures or consecutive short-lived (under 10 seconds) connections back off exponentially (with jitter),
  and after 5 in a row, or when the endpoint explicitly refuses (such as exceeding the connection limit), it reports an error; the kernel records `last_error` and backs off.
- **Profile**: the display name / avatar come from [Get a single user's info](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/get)
  (cached per process for 10 minutes, at most 1000 people, 1 second timeout; if the lookup fails it is left out).
- **Error mapping**: rate limits (429 / `99991400` / `230020`), 5xx and network errors → retryable; token / permission / app disabled (such as
  `99991663`, `99991672`, `10014`, `230006`, `230027`) → `auth`; bot not in the group, group dissolved, user unreachable (`230002`,
  `232009`, `230013`, `230053`…) → `target_gone`; `230025` → `too_large`; others → `rejected`. Error messages carry only the error code.
- **tenant_access_token**: valid for at most 2 hours, cached until 3 minutes before expiry; when the API says the token is invalid it is fetched again once and retried.
- **Permission manifest**: `network: ["open.larksuite.com", "accounts.larksuite.com"]`, shown only and not enforced: the OpenAPI, token fetch,
  OAuth token exchange, user info and the long-connection endpoint are all on `open.larksuite.com`; the web authorization page is on `accounts.larksuite.com`.
  The long connection's WebSocket address is issued by the endpoint at connect time (the docs do not state a fixed host), and the manifest's domains do not support wildcards, so it is not listed. During card interaction
  the Lark client may also access `*.feishu.cn` (unrelated to the server side).

## Webhook inbound mode (optional)

The long connection is the default. A connection can instead receive events over HTTPS webhooks,
when the deployment exposes a gateway replica and sets `channels.webhookBaseUrl` (see
[Deploying: webhook](https://github.com/capybara-hq/core/blob/main/docs/deploy/README.md#webhook-optional)). Switch the connection to webhook mode in the web app (Channels →
connection → Overview → Inbound mode); the connection page then shows its webhook URL.

1. In the developer console, under **Events & Callbacks**, set the subscription method to send
   events to your server and enter the webhook URL (Lark verifies it with a challenge, which the
   plugin answers). Configure **card callbacks there too**, with the same URL.
2. Set an **Encrypt Key** (recommended) and copy it to the connection's `encryptKey`: requests must
   then be encrypted and signed, which also protects against replays.
3. Copy the **Verification Token** to `verificationToken`. Without `encryptKey`, only plaintext
   requests with a matching token are accepted; that mode is weaker (the token is static and there
   is no replay protection). With neither secret set, every webhook request is refused.

Both modes parse events the same way (same message and card-click ids), so the kernel's dedupe
still drops a redelivery that arrives across a mode switch.

## Web login (identity-source)

Use the same self-built app (see above):

1. Under **Development Config → Security Settings → Redirect URLs** (开发配置 → 安全设置 → 重定向 URL), add `<http.publicUrl>/api/v1/auth/sso/lark/callback` (for example
   `https://cap.example.com/api/v1/auth/sso/lark/callback`). When exchanging the token, `redirect_uri` must match the one used at authorization **strictly**.
2. Login **requests no scope** (the authorization URL carries no `scope`): requesting a scope the app has not enabled makes authorization fail for everyone (20027), and login only
   needs `open_id`, `tenant_key`, the name and the avatar. The email is included only when the user info has `email` / `enterprise_email` (depending on the app's
   field permissions and the user's earlier authorization), and left out otherwise. It needs `tenant:tenant:readonly` (already required by the bot) to check the user's tenant.
3. Publish a version whose **availability scope** (可用范围) includes the people who will sign in (outside the scope, the token exchange fails with 20010).
4. In the kernel config set `pluginConfig.lark.appId` / `appSecret` (`appSecret` goes through the secret store and is masked in logs), and add `lark` to
   `auth.loginSources`.

Flow and choices (docs consulted 2026-10-20):

- Authorization page [Obtain authorization code](https://open.larksuite.com/document/common-capabilities/sso/api/obtain-oauth-code):
  `https://accounts.larksuite.com/open-apis/authen/v1/authorize`, with `client_id`, `redirect_uri`, `state`
  and **PKCE** (`code_challenge`, `code_challenge_method=S256`). The authorization code is valid for 5 minutes and can be used only once.
- Token exchange [Get user_access_token](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token):
  the v2 OAuth endpoint `POST /open-apis/authen/v2/oauth/token` (`client_id` / `client_secret` / `code` / `redirect_uri` /
  `code_verifier`); no app_access_token needs to be fetched first.
- User info [Get user info](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get):
  `open_id`, `tenant_key`, `name`, avatar, `email` / `enterprise_email`. The user's `tenant_key` must equal the login app's own
  tenant (enterprise info API), otherwise it is rejected.
- Lark web authorization is not OIDC, so there is no ID token or nonce. Replay protection: the kernel's state is single-use and bound to the browser cookie, the authorization code is single-use
  and expires in 5 minutes, PKCE binds the authorization code to the verifier of this login attempt, the token exchange needs the App Secret, and `redirect_uri` must match strictly.
- **Emails are always treated as unverified** (`emailVerified: false`): the docs do not say that `email` or `enterprise_email` is verified, so
  Lark login does not merge into existing accounts by email (even if the tenant is in `auth.trustedIdentitySources`). The email is taken from `email`, and from
  `enterprise_email` when that is missing.

## Directory (directory)

Use the same self-built app (see above). When enabling the `lark` plugin in the org settings, fill in the org-level config `appId` / `appSecret` (both may be left empty: an org that only uses the
bot leaves them empty, and the directory is treated as not configured and does not sync).

1. Under **Permissions & Scopes** (权限管理), enable:

   | Permission | Purpose |
   |---|---|
   | `contact:contact.base:readonly` (获取通讯录基本信息; get basic directory info) | List departments and each department's direct members |
   | `contact:user.base:readonly` (获取用户基本信息; get basic user info) | Name |
   | `contact:user.employee:readonly` (获取用户受雇信息; get user employment info) | User status (resigned / frozen…), enterprise email |
   | `contact:user.email:readonly` (获取用户邮箱信息; get user email info) | Email |
   | `tenant:tenant:readonly` (获取企业信息; get enterprise info) | The members' tenant `tenant_key` |

   You can also use `contact:contact:readonly_as_app` (以应用身份读取通讯录; read the directory as the app) instead of the first three. When the permission for the status fields is missing, the sync errors
   (rather than treating everyone as active, which would mean departed people are never removed).
2. Set **Permissions & Scopes → Data permissions / Contacts permission scope** (权限管理 → 数据权限 / 通讯录权限范围) to **All members** (全部成员): walking from the root department needs all-member permission. When only some departments / members are granted,
   the first page fails with no department permission (`40004`), and the sync is recorded as incomplete and removes no one.
3. Subscribe to `contact.user.created_v3` / `updated_v3` / `deleted_v3` (see step 5 of "Create the Lark app" above); people changes trigger
   a sync. In addition the kernel syncs once an hour, and admins can also sync manually.

Behavior (docs: [Get the list of child departments](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/children),
[Get the direct users of a department](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/find_by_department),
[User resource](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/field-overview)):

- Lark has no "list all users" API; members can only be fetched per department as direct members: first the root department (id `0`), then each department from the recursive child-department list, with at most 50 people
  per page for one department. A person in several departments appears several times (the kernel dedupes by identity). If the department list changes mid-sync, the sync errors and the run is treated as incomplete
  (no one is removed) and starts over next time: each page checks that the current department is still in place, and on the last page it re-lists all departments and compares them with the department digest
  accumulated in visit order (catching changes such as a visited and an unvisited department swapping places).
- Resigned (`is_resigned`), frozen (`is_frozen`) and self-exited (`is_exited`) → not active; the kernel only removes members that were added by directory sync.
  People who are **not activated** (invited but not activated) or **not joined** (`is_unjoin`) are not synced and are added in the next run after they activate. Bots / apps are not in the directory.
- A member's tenant = the `tenant_key` of the enterprise info API, on the same basis as the bot and login; if the tenant changes within one run it errors.
- Emails are always treated as unverified (same as login).
- Rate limits: both APIs allow 1000 per minute and 50 per second; on 429 / `99991400` (including the enterprise info lookup) it waits per `x-ogw-ratelimit-reset`
  and retries, waiting at most 30 seconds cumulative per page, beyond which it reports "rate limited" and the run is treated as incomplete.
- If a people-change event arrives mid-sync, the kernel records this run as incomplete (no removals), and the follow-up run then removes them (Ruling A32).

## Deployment-level config

| Field | Default | Description |
|---|---|---|
| `region` | `lark` | Open platform region. Currently only `lark` (international edition) is supported; `feishu` is reserved and not yet usable |
| `apiUrl` | — | Open platform root URL; change it only in tests or when going through a proxy (by default taken from `region`, `https://open.larksuite.com`) |
| `accountsUrl` | — | Web authorization page root URL; change it only in tests or when going through a proxy (default `https://accounts.larksuite.com`) |
| `appId` | — | App ID of the self-built app used for web login (the same app as the bot and directory); leave empty if you only use the bot |
| `appSecret` | — | That app's App Secret (secret) |

The deployment-level config lives under the kernel config `pluginConfig.lark`.

## Org-level config

| Field | Description |
|---|---|
| `appId` | App ID of the self-built app used for the directory (the same app as the bot and login); leave empty if you only use the bot |
| `appSecret` | That app's App Secret (secret) |

## Channel connection config

| Field | Description |
|---|---|
| `appId` | The self-built app's App ID (`cli_` + 16 hex characters) |
| `appSecret` | The self-built app's App Secret (secret) |
| `encryptKey` | Encrypt Key (secret); webhook mode only, recommended |
| `verificationToken` | Verification Token (secret); webhook mode only |
