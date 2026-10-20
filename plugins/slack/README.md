# @capybara-hq/plugin-slack

Slack 官方插件，提供三种能力：

- `channel@1`（机器人）：经 [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)
  收事件（不需要公网回调地址），经 Web API 发消息，审批 / 提问 / 连接 / 绑定卡片渲染为 Block Kit。
- `identity-source@1`（Sign in with Slack，OpenID Connect）：用 Slack 账号登录 Capybara。
- `directory@1`（通讯录）：把 Slack 工作区成员同步为组织成员。

三处用同一个身份键：`identities.source` = `slack:<team id>`，`external_id` = Slack user id（`U…`）。
同一个人经登录、私聊机器人、通讯录同步出现时只对应一行身份、一个账号。

文中 Slack 文档均于 2026-10-20 查阅。

## 创建 Slack 应用

1. 打开 <https://api.slack.com/apps> → **Create New App** → **From a manifest**，选工作区，粘贴本目录的
   [`app-manifest.yaml`](./app-manifest.yaml)（格式见 [App manifest 参考](https://docs.slack.dev/reference/app-manifest)）。
   它开启 Socket Mode 与交互（Interactivity），订阅事件 `message.im`、`app_mention`、`message.channels`、
   `message.groups`、`team_join`、`user_change`，申请机器人权限：

   | scope | 用途 |
   |---|---|
   | `chat:write` | 发送与更新回复、卡片 |
   | `im:history` | 收私聊消息 |
   | `app_mentions:read` | 收频道里 @ 机器人的消息 |
   | `channels:history` / `groups:history` | 收公开 / 私有频道里的话题回复 |
   | `users:read` | 查发言人显示名与头像；人员变动事件；通讯录 `users.list` |
   | `users:read.email` | 通讯录同步时取邮箱（机器人本身不用） |

2. **Basic Information → App-Level Tokens → Generate Token and Scopes**：加 scope `connections:write`，
   得到应用级令牌 `xapp-…`（Socket Mode 用它调 `apps.connections.open`）。
3. **Install App → Install to Workspace**，得到机器人令牌 `xoxb-…`。
4. 在 Capybara 组织设置里启用 `slack` 插件，然后**新建渠道连接**：插件选 Slack，填 `appToken`（`xapp-…`）与
   `botToken`（`xoxb-…`），绑定 agent。两者都存进密钥存储，接口只回「已设置」。
5. 在 Slack 里私聊机器人，或把机器人拉进频道后 @ 它。第一次对话会收到绑定卡片，点按钮到网页上确认绑定。

注意：Socket Mode 的应用目前不能上架公开的 Slack Marketplace；同一应用最多同时 10 条 Socket Mode 连接
（[Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)）。Capybara 每个渠道连接
任一时刻只由一个副本持有一条连接。

## Sign in with Slack（登录）

[Sign in with Slack](https://docs.slack.dev/authentication/sign-in-with-slack/) 基于 OpenID Connect。

1. 在应用设置 **OAuth & Permissions → Redirect URLs** 加入
   `<http.publicUrl>/api/v1/auth/sso/slack/callback`（如 `https://capybara.example.com/api/v1/auth/sso/slack/callback`；
   内核发出的 `redirect_uri` 必须与它相同或是它的子路径）。
2. 登录流程在授权地址里申请 scope `openid`、`email`、`profile`（`openid` 必需；`email` 给出邮箱与
   `email_verified`，`profile` 给出姓名与头像）。**不要**把它们加进应用的 Bot / User Token Scopes：Slack 要求
   Sign in with Slack 的 scope 与其他 scope 在不同的 OAuth 流程里申请，安装应用（机器人）与登录是两条流程。
3. **Basic Information → App Credentials** 里的 Client ID 与 Client Secret 写进部署级配置（见下），并把 `slack`
   加入内核配置 `auth.loginSources`。登录页随即出现「Slack」。

插件的做法：授权地址 `https://slack.com/openid/connect/authorize`（`response_type=code`、`state`、`nonce`）；
回调用授权码调 `openid.connect.token`（`client_secret_post`），**校验 ID token**（JWKS
`https://slack.com/openid/connect/keys` 验 RS256 签名，`iss = https://slack.com`、`aud = clientId`、未过期、
`nonce` 与发起时一致），再用 access token 调 `openid.connect.userInfo` 取邮箱、姓名、头像（其用户 / 工作区必须与
ID token 一致）。`email_verified` 原样作为邮箱是否已验证。

**不用 PKCE**：Slack 的 OIDC 文档与 [discovery](https://slack.com/.well-known/openid-configuration) 都没有声明
PKCE；Slack 的 [PKCE](https://docs.slack.dev/authentication/using-pkce) 只针对 `oauth.v2.*`，且启用后应用不可逆地
变成公开客户端。插件忽略内核给的 PKCE 参数；登录的防护靠内核的 state（单次有效、绑定发起登录的浏览器）、nonce
（在已验签的 ID token 里核对）与 client secret。

注意：任何 Slack 工作区的用户都能完成 Sign in with Slack（与其他身份源一样，登录只建账号，不加入任何组织；
组织成员关系来自邀请或通讯录同步）。按已验证邮箱合并既有账号只对管理员信任的身份源租户生效。

## 通讯录（directory@1）

在组织设置里启用 `slack` 插件时填组织级配置 `teamId`（工作区 id，`T…`）与 `botToken`（`xoxb-…`，可以与某个
渠道连接用同一个机器人令牌，但配置独立存放、走密钥存储）。机器人令牌需要：

| scope | 用途 |
|---|---|
| `users:read` | [`users.list`](https://docs.slack.dev/reference/methods/users.list) 列出成员 |
| `users:read.email` | 成员邮箱（没有它 `users.list` 不返回邮箱） |

- 租户是**工作区**：`teamId` 只收 `T…`；企业 id（`E…`）会把同一个人拆成两行身份。每页先调 `auth.test`：
  组织级安装的令牌（`is_enterprise_install`）或 `team_id` 不是 `T…` 的令牌都拒绝；令牌所属工作区还必须等于
  `teamId`，否则同步报错（避免把别的工作区的人记成本租户）。Enterprise Grid 请用各工作区自己的机器人令牌。
- `users.list` 按游标分页（每页 200，Slack 建议不超过 200）；排除机器人（`is_bot`）、Slackbot（`USLACKBOT`）、
  **访客**（`is_restricted` 多频道访客、`is_ultra_restricted` 单频道访客——访客不成为组织成员，需要时可手动邀请），
  以及 Enterprise Grid 下自身 `team_id` 与 `teamId` 不同的其他工作区成员；`deleted = true` 的人报为离职
  （`active = false`），内核只撤销由通讯录同步加入的成员关系。
- 邮箱一律报为**未验证**：`users.list` 文档没有说明 `profile.email` 是否经过验证（登录时 OIDC 的
  `email_verified` 才算数）。
- 限流：`users.list` 为 Tier 2（20+ 次/分钟）。遇到 HTTP 429 在本次同步内按 `Retry-After` 等待后重试，最多 3 次、
  每页累计最多等 30 秒；超出就报错，内核把本轮记为不完整（只加人、不移除任何人），下次再同步。
- 人员变动事件（`team_join`、`user_change`，经渠道连接收到）会触发一次同步。
- `teamId` / `botToken` 没填时（组织只用机器人），插件的 `configured()` 返回 false：内核不扫描、不同步、不记审计
  与警告；手动同步返回 409 `directory.not_configured`。不会被当作空通讯录。

## 行为

- **私聊**：每条文本消息交给内核；**频道**：只有 @ 机器人的消息（新消息在它下面开话题回复），以及话题里的回复
  （内核目前只处理 @ 机器人的）。编辑、删除、机器人自己与其他机器人的消息、其他带 `subtype` 的消息忽略；
  带说明文字的文件分享（`file_share`，只取文字）与同时发到频道的话题回复（`thread_broadcast`）按文本处理。
  M4 只处理文本。文本去掉 @ 机器人（只整理 @ 两侧的空白，缩进与换行保留）并反转义 `&amp;` / `&lt;` / `&gt;`。
  模型回复里的链接地址中的 `<`、`>`、`|` 会被百分号编码，模型文本无法注入 `<!channel>` 之类的控制序列。
- **id**：消息 id = `<频道 id>:<ts>`（连接内唯一、稳定）；群聊话题 id = `<频道 id>:<thread_ts>`，即话题根消息的
  消息 id；卡片点击的 `eventId` = `<频道>:<卡片消息 ts>:<点击者>:<action_ts>`（重投时负载相同，故稳定）。
  发言人租户 = Slack team id（共享频道的外部成员取 `user_team`），与 `verify`（`auth.test` 的 `team_id`）同一口径。
- **确认**：内核 `onEvent` resolve 之后才 ack；reject 不 ack，Slack 会重投（Events API 立即、约 1 分钟、约 5 分钟后
  共三次，见 [Events API](https://docs.slack.dev/apis/events-api/)）。
- **格式**：模型回复的 Markdown 转为 [mrkdwn](https://docs.slack.dev/messaging/formatting-message-text)；
  单条文本上限 4000 字符（`chat.update` 超过即 `msg_too_long`，见 [chat.update](https://docs.slack.dev/reference/methods/chat.update)），
  超长拆成多条；编辑超长时报 `too_large`，由内核改发新消息。
- **流式编辑**：`minEditIntervalMs = 2500`（`chat.update` 为 Tier 3，约 50 次/分钟、按工作区计，见
  [chat.update](https://docs.slack.dev/reference/methods/chat.update) 与
  [Rate limits](https://docs.slack.dev/apis/web-api/rate-limits)）；更多并发时由 429 + Retry-After 兜底。
- **重连**：插件自管（关闭 SDK 自动重连）。Slack 正常回收连接时立即重连；连续短命（不到 10 秒）的连接按指数退避
  （带抖动），连续 5 次或收到 `link_disabled` 时报错，内核记 `last_error` 并退避。
- **幂等**：`chat.postMessage` 没有幂等参数，`idempotencyKey` 忽略。
- **资料**：显示名 / 头像取事件自带的 `user_profile`，否则 `users.info`（每个进程内缓存 10 分钟、最多 1000 人，
  1.5 秒超时，查不到就不带）。
- **权限清单**：`network: ["slack.com", "wss-primary.slack.com"]`，只展示不拦截；登录（OIDC）与通讯录也都在
  `slack.com`。Socket Mode 的 WSS 主机由
  Slack 分配、并不固定（如 `wss-primary.slack.com`、`wss-backup.slack.com`、`wss-111.slack.com`），清单的域名
  校验不支持通配，故只列主要的一个。

## 部署级配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiUrl` | `https://slack.com/api/` | Web API 根地址；只在测试或经代理时改写 |
| `openidUrl` | `https://slack.com/` | OIDC 授权页与 JWKS 的根地址；只在测试或经代理时改写（ID token 的 `iss` 固定为 `https://slack.com`） |
| `clientId` | — | Sign in with Slack 的 Client ID；不用登录时不填 |
| `clientSecret` | — | Sign in with Slack 的 Client Secret（密钥，日志打码）；不用登录时不填 |

部署级配置写在内核配置 `pluginConfig.slack` 下。

## 组织级配置

| 字段 | 说明 |
|---|---|
| `teamId` | 通讯录同步的 Slack 工作区 id（`T…`） |
| `botToken` | 通讯录同步用的机器人令牌（`xoxb-…`，密钥） |
