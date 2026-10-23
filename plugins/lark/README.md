# @capybara-hq/plugin-lark

Lark（飞书国际版，`open.larksuite.com`）官方插件。当前提供：

- `channel@1`（机器人）：经 Lark **长连接**（官方 SDK `@larksuiteoapi/node-sdk` 的 `WSClient`）收消息事件与卡片回调
  （不需要公网回调地址），经 OpenAPI 发消息；所有回复与审批 / 提问 / 连接 / 绑定卡片都渲染为交互卡片（JSON 2.0）。

- `identity-source@1`（网页登录）：Lark OAuth 授权码 + PKCE，部署级配置。
- `directory@1`（通讯录）：按部门遍历通讯录，组织级配置。

身份键：`identities.source` = `lark:<tenant_key>`，`external_id` = 用户 `open_id`，登录、机器人、通讯录三处同一个键。

> **登录、机器人、通讯录必须用同一个 Lark 自建应用。** `open_id` 按应用区分（同一个人在不同应用里的 `open_id`
> 不同），换个应用身份就对不上，同一个人会变成两个账号。部署级登录的 `appId`、各组织渠道连接的 `appId`、组织级
> 通讯录的 `appId` 填同一个。插件会核对：部署配了登录应用时，同一租户的渠道连接（校验时、以及每次建立长连接前——
> 登录应用后来才配上或换过也能发现，连接记下错误并停用重连）或通讯录（每页同步时）用了别的应用就报错。只有登录应用的
> 凭据本身无效（10014 / 10015）时不拦；限流、网络等暂时性错误会报错，稍后重试。登录应用只能是一个，所以 Lark 登录只服务于这个应用所在的租户；其他租户的组织照样可以用机器人
> （在 IM 里点绑定卡片关联账号）。

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
  **待联调确认**：文档对事件写明了「抛异常即重推」，但卡片回调（`card.action.trigger`）在回 500 之后是否同样重推
  **尚未核实**，将在真实 Lark 联调时确认；不重推时这次点击丢失，用户需再点一次。
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
  回传值里的会话类型只是参考：卡片可被转发、值随之重放（卡片设了 `enable_forward_interaction: false`，转发后默认
  不可交互）；内核以发出卡片时记下的目标为准，点击所在的 chat 与卡片不符时只回「不能处理」，不发绑定链接。
- **格式与防注入**：模型回复的 Markdown 原样进卡片富文本（JSON 2.0 支持 CommonMark），代码之外的 `<` 与 `&`
  转成 `&#60;` / `&#38;`，代码里的 `<at`（含 `&#60;at` / `&lt;at` 实体写法）插入零宽空格拆开——模型文本无法写出
  `<at id=all></at>` 之类的标签去 @ 所有人或任何人（卡片里纯文本的 `@all` 不会 @ 人）。只有 `http(s)://` 与
  `mailto:` 的链接做成链接（地址里的括号、方括号、空格等百分号编码）；其他地址（`javascript:`、`lark://`…）、
  图片与引用式链接按普通文字显示。
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
- **权限清单**：`network: ["open.larksuite.com", "accounts.larksuite.com"]`，只展示不拦截：OpenAPI、取 token、
  OAuth 换 token、用户信息与长连接接入点都在 `open.larksuite.com`；网页授权页在 `accounts.larksuite.com`。
  长连接的 WebSocket 地址由接入点在连接时下发（文档没有写明固定主机），清单的域名不支持通配，故不列出。卡片交互时
  Lark 客户端还可能访问 `*.feishu.cn`（与服务端无关）。

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

## 网页登录（identity-source）

用同一个自建应用（见上）：

1. **开发配置 → 安全设置 → 重定向 URL** 添加 `<http.publicUrl>/api/v1/auth/sso/lark/callback`（例如
   `https://cap.example.com/api/v1/auth/sso/lark/callback`）。换 token 时 `redirect_uri` 须与授权时**严格**一致。
2. 登录**不申请任何 scope**（授权地址不带 `scope`）：申请应用没开通的 scope 会让所有人授权失败（20027），而登录只
   需要 `open_id`、`tenant_key`、姓名与头像。用户信息里有 `email` / `enterprise_email` 时才带上邮箱（取决于应用的
   字段权限与用户以前的授权），没有就不带。需要 `tenant:tenant:readonly`（机器人已要求）用来核对用户的租户。
3. 发布版本，**可用范围**包含要登录的人（不在范围内换 token 报 20010）。
4. 内核配置 `pluginConfig.lark.appId` / `appSecret`（`appSecret` 走密钥、日志打码），并把 `lark` 加进
   `auth.loginSources`。

流程与选择（文档均 2026-10-20 查阅）：

- 授权页 [获取授权码](https://open.larksuite.com/document/common-capabilities/sso/api/obtain-oauth-code)：
  `https://accounts.larksuite.com/open-apis/authen/v1/authorize`，带 `client_id`、`redirect_uri`、`state`
  与 **PKCE**（`code_challenge`，`code_challenge_method=S256`）。授权码 5 分钟内有效、只能用一次。
- 换 token [获取 user_access_token](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token)：
  v2 OAuth 端点 `POST /open-apis/authen/v2/oauth/token`（`client_id` / `client_secret` / `code` / `redirect_uri` /
  `code_verifier`），不需要先取 app_access_token。
- 用户信息 [获取用户信息](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get)：
  `open_id`、`tenant_key`、`name`、头像、`email` / `enterprise_email`。用户的 `tenant_key` 必须等于登录应用自己的
  租户（企业信息接口），否则拒绝。
- Lark 网页授权不是 OIDC，没有 ID token 与 nonce。防重放：内核的 state 单次有效且绑定浏览器 Cookie，授权码单次
  有效、5 分钟过期，PKCE 把授权码绑定到本次发起的 verifier，换 token 需要 App Secret，`redirect_uri` 严格一致。
- **邮箱一律视为未验证**（`emailVerified: false`）：文档没有说明 `email` 或 `enterprise_email` 经过验证，所以
  Lark 登录不会按邮箱合并已有账号（即使租户在 `auth.trustedIdentitySources` 里）。邮箱取 `email`，没有时取
  `enterprise_email`。

## 通讯录（directory）

用同一个自建应用（见上）。在组织设置里启用 `lark` 插件时填组织级配置 `appId` / `appSecret`（两项都可不填：只用
机器人的组织不填，通讯录视为未配置，不同步）。

1. **权限管理** 开通：

   | 权限 | 用途 |
   |---|---|
   | `contact:contact.base:readonly`（获取通讯录基本信息） | 列出部门与部门直属成员 |
   | `contact:user.base:readonly`（获取用户基本信息） | 姓名 |
   | `contact:user.employee:readonly`（获取用户受雇信息） | 用户状态（离职 / 冻结…）、企业邮箱 |
   | `contact:user.email:readonly`（获取用户邮箱信息） | 邮箱 |
   | `tenant:tenant:readonly`（获取企业信息） | 成员的租户 `tenant_key` |

   也可以用 `contact:contact:readonly_as_app`（以应用身份读取通讯录）代替前三项。缺了状态字段的权限时同步会报错
   （而不是把所有人当在职，否则离职的人永远不会被移除）。
2. **权限管理 → 数据权限 / 通讯录权限范围** 设为**全部成员**：从根部门遍历需要全员权限。只给了部分部门 / 成员时，
   第一页就报无部门权限（`40004`），同步记为不完整、不移除任何人。
3. 订阅 `contact.user.created_v3` / `updated_v3` / `deleted_v3`（见上文「创建 Lark 应用」第 5 步），人员变动会触发
   一次同步；此外内核每小时同步一次，管理员也可手动同步。

行为（文档：[获取子部门列表](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/children)、
[获取部门直属用户列表](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/find_by_department)、
[用户资源](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/field-overview)）：

- Lark 没有「列出全部用户」的接口，只能按部门取直属成员：先根部门（id `0`），再按递归子部门列表逐个部门，每页
  一个部门的最多 50 人。同一人在多个部门时会出现多次（内核按身份去重）。部门列表在同步途中变了就报错、本轮按不完整
  处理（不移除任何人），下一轮重来：每页核对当前部门仍在原位，最后一页再重列全部部门，与按访问顺序累积的部门摘要
  比对（发现已访问与未访问部门对调之类的变化）。
- 离职（`is_resigned`）、冻结（`is_frozen`）、主动退出（`is_exited`）→ 不在职；内核只移除由通讯录同步加入的成员。
  **未激活**（受邀未激活）与**未加入**（`is_unjoin`）的人不同步，激活后下一轮加入。机器人 / 应用不在通讯录里。
- 成员的租户 = 企业信息接口的 `tenant_key`，与机器人、登录同一口径；同一轮里租户变了就报错。
- 邮箱一律视为未验证（同登录）。
- 限流：两个接口都是 1000 次/分钟、50 次/秒；遇到 429 / `99991400`（含企业信息查询）按 `x-ogw-ratelimit-reset`
  等待后重试，每页累计等待不超过 30 秒，超出就报「rate limited」，本轮按不完整处理。
- 同步途中又来了人员变动事件时，内核把这一轮记为不完整（不移除），随后补跑的那一轮再移除（Ruling A32）。

## 部署级配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `region` | `lark` | 开放平台区域。目前只支持 `lark`（国际版）；`feishu`（飞书）已预留，暂不可用 |
| `apiUrl` | — | 开放平台根地址；只在测试或经代理时改写（默认按 `region` 取 `https://open.larksuite.com`） |
| `accountsUrl` | — | 网页授权页根地址；只在测试或经代理时改写（默认 `https://accounts.larksuite.com`） |
| `appId` | — | 网页登录用的自建应用 App ID（与机器人、通讯录同一个应用）；只用机器人时不填 |
| `appSecret` | — | 该应用的 App Secret（密钥） |

部署级配置写在内核配置 `pluginConfig.lark` 下。

## 组织级配置

| 字段 | 说明 |
|---|---|
| `appId` | 通讯录用的自建应用 App ID（与机器人、登录同一个应用）；只用机器人时不填 |
| `appSecret` | 该应用的 App Secret（密钥） |

## 渠道连接配置

| 字段 | 说明 |
|---|---|
| `appId` | 自建应用的 App ID（`cli_` + 16 位十六进制） |
| `appSecret` | 自建应用的 App Secret（密钥） |
| `encryptKey` | Encrypt Key (secret); webhook mode only, recommended |
| `verificationToken` | Verification Token (secret); webhook mode only |
