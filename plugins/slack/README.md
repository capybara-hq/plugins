# @capybara-hq/plugin-slack

Slack 官方插件。当前提供 `channel@1`（机器人）：经 [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)
收事件（不需要公网回调地址），经 Web API 发消息，审批 / 提问 / 连接 / 绑定卡片渲染为 Block Kit。
登录（`identity-source@1`）与通讯录（`directory@1`）在后续版本加入同一插件。

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
   | `users:read` | 查发言人显示名与头像；人员变动事件 |
   | `users:read.email` | 通讯录同步（后续版本） |

2. **Basic Information → App-Level Tokens → Generate Token and Scopes**：加 scope `connections:write`，
   得到应用级令牌 `xapp-…`（Socket Mode 用它调 `apps.connections.open`）。
3. **Install App → Install to Workspace**，得到机器人令牌 `xoxb-…`。
4. 在 Capybara 组织设置里启用 `slack` 插件，然后**新建渠道连接**：插件选 Slack，填 `appToken`（`xapp-…`）与
   `botToken`（`xoxb-…`），绑定 agent。两者都存进密钥存储，接口只回「已设置」。
5. 在 Slack 里私聊机器人，或把机器人拉进频道后 @ 它。第一次对话会收到绑定卡片，点按钮到网页上确认绑定。

注意：Socket Mode 的应用目前不能上架公开的 Slack Marketplace；同一应用最多同时 10 条 Socket Mode 连接
（[Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)）。Capybara 每个渠道连接
任一时刻只由一个副本持有一条连接。

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
- **权限清单**：`network: ["slack.com", "wss-primary.slack.com"]`，只展示不拦截。Socket Mode 的 WSS 主机由
  Slack 分配、并不固定（如 `wss-primary.slack.com`、`wss-backup.slack.com`、`wss-111.slack.com`），清单的域名
  校验不支持通配，故只列主要的一个。

## 部署级配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiUrl` | `https://slack.com/api/` | Web API 根地址；只在测试或经代理时改写 |
