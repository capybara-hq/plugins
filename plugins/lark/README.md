# @capybara-hq/plugin-lark

Lark（飞书国际版，`open.larksuite.com`）官方插件。当前提供：

- `channel@1`（机器人）：经 Lark **长连接**（官方 SDK `@larksuiteoapi/node-sdk` 的 `WSClient`）收消息事件与卡片回调
  （不需要公网回调地址），经 OpenAPI 发消息；所有回复与审批 / 提问 / 连接 / 绑定卡片都渲染为交互卡片（JSON 2.0）。

登录（identity-source）与通讯录（directory）随后加入本插件。身份键：`identities.source` = `lark:<tenant_key>`，
`external_id` = 用户 `open_id`。

文中 Lark 文档均于 2026-10-20 查阅。

## 创建 Lark 应用

长连接**只支持企业自建应用**（商店应用不行），见
[使用长连接接收事件](https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/use-websocket)。

1. 在 [开发者后台](https://open.larksuite.com/app) **创建企业自建应用**。在 **凭证与基础信息** 里拿到 App ID
   （`cli_…`）与 App Secret。
2. **添加应用能力 → 机器人**（没有机器人能力时发消息报 230006）。
3. **权限管理** 开通以下权限：

   | 权限 | 用途 |
   |---|---|
   | `im:message.p2p_msg:readonly`（读取用户发给机器人的单聊消息） | 收私聊消息 |
   | `im:message.group_at_msg:readonly`（接收群聊中@机器人消息事件） | 收群里 @ 机器人的消息 |
   | `im:message:send_as_bot`（以应用的身份发消息） | 发送、回复消息，更新卡片 |
   | `tenant:tenant:readonly`（获取企业信息） | 校验连接时取 `tenant_key`（租户） |
   | `contact:user.base:readonly`（获取用户基本信息） | 发言人的显示名与头像；人员变动事件 |

   不需要 `im:message.group_msg`（获取群组中所有消息，敏感权限）：群里只处理 @ 机器人的消息。
   在 **权限管理 → 数据权限 / 通讯录权限范围** 把需要查资料的成员加进可见范围（不在范围内的人照样能对话，只是没有
   显示名 / 头像）。
4. 在 Capybara 组织设置里启用 `lark` 插件，然后**新建渠道连接**：插件选 Lark，填 `appId` 与 `appSecret`（存进
   密钥存储，接口只回「已设置」），绑定 agent。连接建好后插件会立即建立长连接——下一步保存订阅方式时，开发者后台
   要求长连接已在运行。
5. **事件与回调 → 事件配置**：订阅方式选 **使用长连接接收事件**，添加事件：
   - `im.message.receive_v1`（接收消息 v2.0）；
   - `contact.user.created_v3`、`contact.user.updated_v3`、`contact.user.deleted_v3`（员工入职 / 信息变更 / 离职，
     用于触发通讯录同步；只用机器人时可不加）。
6. **事件与回调 → 回调配置**：订阅方式选 **使用长连接接收回调**，添加回调 `card.action.trigger`（卡片回传交互）。
   旧版卡片回调不支持长连接，见
   [使用长连接接收回调](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/callback-subscription/configure-callback-request-address)。
7. **版本管理与发布**：创建版本，设置**可用范围**（谁能和机器人对话；对范围外的用户发消息报 230013），提交发布。
8. 在 Lark 里私聊机器人，或把机器人拉进群后 @ 它。第一次对话会收到绑定卡片，点按钮到网页上确认绑定。

注意：每个应用最多 50 条长连接；长连接推送是集群模式，同一应用有多个客户端时只有随机一个收到消息。Capybara 每个
渠道连接任一时刻只由一个副本持有一条长连接；同一个 Lark 应用不要同时配进多个渠道连接或其他程序。

## 行为

- **确认**：长连接要求 3 秒内处理完「且不抛出异常，否则会触发超时重推」。SDK 在处理函数返回后自动回响应帧
  （返回 → `code 200`，抛错 → `code 500`）。插件的处理函数等内核 `onEvent` resolve 后才返回；`onEvent` reject 时
  重新抛出，Lark 收到失败、稍后重推（内核按 `message_id` / 回调 `event_id` 去重）。忽略的事件直接确认。
- **入站**：私聊收文本（`text`）与富文本（`post`，按文本处理：链接写成 `[文字](地址)`、代码块保留）；群里收 @ 了
  机器人的，以及话题里的回复（内核目前只处理 @ 了的）。图片、文件等其他类型、机器人自己的消息、撤回等其他事件
  忽略。文本里的 `@_user_N` 占位：机器人本身去掉（只整理两侧空白，换行与缩进保留），其他人换成 `@名字`。
- **id**：消息 id = `message_id`（`om_…`）；群聊话题 id = 话题根消息的 `root_id`（`om_…`，不是 `thread_id` 的
  `omt_…`）；卡片点击的 `eventId` = 回调的 `header.event_id`（回调的唯一标识）。发言人租户 = `sender.tenant_key`，
  与 `verify`（企业信息接口的 `tenant_key`）同一口径。
- **群聊话题**：回复群里的 @ 消息时用 [回复消息](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply)
  并 `reply_in_thread: true`，回复进以该消息为根的话题。
- **卡片**：所有消息都发成交互卡片（[JSON 2.0](https://open.larksuite.com/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure)，
  `update_multi: true`），更新统一走 [更新应用发送的消息卡片](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch)
  （单条消息 5 QPS、14 天内可改、没有总次数上限）；不用文本消息的「编辑消息」，它一条最多改 20 次。审批卡片每个
  允许的范围一个按钮 + 拒绝 + 网页链接；提问能在 IM 内作答时单选为按钮、多选为表单里的多选下拉 + 提交，否则只给
  网页链接；状态变化后去掉按钮、只显示状态与「详情」链接。按钮回传值是紧凑的 JSON 数组（含卡片 id、会话类型），
  严格解析、不超过 2000 字符；链接按钮只用 http(s) 地址。卡片回调的应答为空（卡片不变），卡片随后由内核更新。
- **格式与防注入**：模型回复的 Markdown 原样进卡片富文本（JSON 2.0 支持 CommonMark），代码之外的 `<` 与 `&`
  转成 `&#60;` / `&#38;`，代码里的 `<at` 插入零宽空格拆开——模型文本无法写出 `<at id=all></at>` 之类的标签去 @ 所有人
  或任何人（卡片里纯文本的 `@all` 不会 @ 人）。
- **长度**：卡片消息请求体最多 30 KB（230025）。每张卡片正文最多 5000 个字符，超长拆成多条（返回最后一条 id）；
  编辑超长时报 `too_large`，由内核改发新消息。
- **流式编辑**：`minEditIntervalMs = 1500`。卡片更新接口整体每应用每租户 1000 次/分钟、50 次/秒
  （[频控策略](https://open.larksuite.com/document/ukTMukTMukTM/uUzN04SN3QjL1cDN)），1.5 秒一次约 25 个会话同时
  流式也不超限；更多并发时由限流（`99991400` + `x-ogw-ratelimit-reset`）兜底。
- **幂等**：`idempotencyKey` 作为 Lark 的 `uuid`（1 小时内同一 uuid 至多发出一条）；拆成多条时第 i 条用 `<key>-<i>`。
- **重连**：插件自管（关闭 SDK 自动重连：它按服务端下发的长间隔静默重试，失败不会回到调用方）。建立长连接前先取
  tenant token 与机器人信息，凭据错误立即报错；断开后立即重连，连接失败或连续短命（不到 10 秒）按指数退避（带抖动），
  连续 5 次、或接入点明确拒绝（如超过连接数上限）时报错，内核记 `last_error` 并退避。
- **资料**：显示名 / 头像取 [获取单个用户信息](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/get)
  （每个进程内缓存 10 分钟、最多 1000 人，1 秒超时，查不到就不带）。
- **错误映射**：限流（429 / `99991400` / `230020`）、5xx、网络错误 → 可重试；token / 权限 / 应用停用（如
  `99991663`、`99991672`、`10014`、`230006`、`230027`）→ `auth`；机器人不在群、群解散、用户不可达（`230002`、
  `232009`、`230013`、`230053`…）→ `target_gone`；`230025` → `too_large`；其他 → `rejected`。错误消息只带错误码。
- **tenant_access_token**：最长有效 2 小时，缓存到过期前 3 分钟；接口回 token 无效时重取一次再试。
- **权限清单**：`network: ["open.larksuite.com"]`，只展示不拦截：OpenAPI、取 token 与长连接接入点都在这个域名。
  长连接的 WebSocket 地址由接入点在连接时下发（文档没有写明固定主机），清单的域名不支持通配，故不列出。卡片交互时
  Lark 客户端还可能访问 `*.feishu.cn`（与服务端无关）。

## 部署级配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `region` | `lark` | 开放平台区域。目前只支持 `lark`（国际版）；`feishu`（飞书）已预留，暂不可用 |
| `apiUrl` | — | 开放平台根地址；只在测试或经代理时改写（默认按 `region` 取 `https://open.larksuite.com`） |

部署级配置写在内核配置 `pluginConfig.lark` 下。

## 渠道连接配置

| 字段 | 说明 |
|---|---|
| `appId` | 自建应用的 App ID（`cli_` + 16 位十六进制） |
| `appSecret` | 自建应用的 App Secret（密钥） |
