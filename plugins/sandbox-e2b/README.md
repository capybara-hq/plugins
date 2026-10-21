# @capybara-hq/plugin-sandbox-e2b

对话沙箱（`sandbox@1`）的 E2B 实现：每个对话一个 E2B 沙箱（E2B 云或自托管 E2B），休眠用 E2B 的 pause，
恢复用 connect。与 `@capybara-hq/plugin-sandbox-docker` 二选一（`sandbox@1` 是单选能力），用同一份镜像。

## 部署配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `apiKey` | （必填，密钥） | E2B API key（`e2b_…`） |
| `template` | （必填） | 模板名或 id，由 `plugins/sandbox-docker/image/Dockerfile` 构建（见下文） |
| `apiUrl` | `https://api.<domain>` | 控制面 API 地址；自托管 E2B 填自己的地址 |
| `domain` | `e2b.app` | 沙箱域名：envd 地址为 `https://49983-<沙箱 id>.<domain>`；API 返回了沙箱自己的 `domain` 时以返回的为准 |
| `timeoutSeconds` | `3600` | 沙箱超时（60–86400 秒）；到点 E2B **自动暂停**（不是删除），见「生命周期」 |
| `domainAllowlist` | `true` | E2B 是否支持按域名的出站白名单；不支持的自托管版本设 `false`，`allowlist` 退化为 `none` 并打告警 |
| `allowOpenEgress` | `false` | 允许 `sandbox.limits.egress = "open"`；为 false 时 `create` 收到 open 直接报错（英文错误） |

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-sandbox-e2b"]'
export CAPYBARA_PLUGIN_CONFIG='{"sandbox-e2b":{"apiKey":"e2b_…","template":"capybara-sandbox"}}'
```

部署配置 schema 是 strict：多出的键直接报错。内核配置 `sandbox.image` 对本插件无效（镜像由模板决定）。

## 模板（与 Docker 插件同一份镜像）

模板由 `plugins/sandbox-docker/image/Dockerfile` 构建（E2B 的 Template SDK 解析 Dockerfile 的
FROM / RUN / COPY / ADD / WORKDIR / USER / ENV / ARG / CMD / ENTRYPOINT）。在仓库根目录：

```bash
export E2B_API_KEY=e2b_…           # 自托管另设 E2B_DOMAIN / E2B_API_URL
mkdir -p /tmp/e2b-build && cd /tmp/e2b-build && npm init -y >/dev/null && npm i e2b@2.58.0
cat > build.mjs <<'EOF'
import { readFileSync } from "node:fs";
import { defaultBuildLogger, Template } from "e2b";
const dockerfile = readFileSync(process.argv[2], "utf8");
await Template.build(Template().fromDockerfile(dockerfile), "capybara-sandbox", {
  cpuCount: 1,        // 与内核 sandbox.cpu 默认值一致
  memoryMB: 2048,     // 与内核 sandbox.memoryMb 默认值一致
  onBuildLogs: defaultBuildLogger(),
});
EOF
node build.mjs <仓库路径>/plugins/sandbox-docker/image/Dockerfile
```

然后把 `template` 配成 `capybara-sandbox`。镜像约定（插件依赖）：用户 `sandbox`（uid 1000），HOME 与工作目录
`/workspace`；`/skills` 归 root（0755）；`/opt/capybara` 归 root 且 0700；装有 `runuser` / `setsid`（util-linux）、
`pkill` / `pgrep`（procps）、GNU coreutils。改 Dockerfile 后重新构建模板。

## 生命周期

| 操作 | E2B 调用 |
|---|---|
| `create` | 先按元数据 `capybara-sandbox-name=<name>` 列出（`GET /v2/sandboxes?metadata=…&state=running,paused`，分页）并删掉同名旧实例（内核可能在记下句柄前退出），再 `POST /v2/sandboxes`（`templateID`、`metadata`、`timeout`、`autoPause: true`、出站设置）；句柄 id 是 E2B 的沙箱 id |
| `resume` | `POST /v2/sandboxes/{id}/connect`（暂停的会被恢复，运行中的把超时往后推）；404 → `gone` |
| `suspend` | `POST /sandboxes/{id}/pause`（文件与内存都保留）；不存在（404）或已暂停（409）也算成功 |
| `destroy` / `destroyByName` | `DELETE /sandboxes/{id}`（不存在也算成功）；按名字时先按元数据列出 |
| `exec` / 文件操作 | 先 connect（取 envd 访问令牌；超时至少推到「命令超时 + 120 秒」，不超过 24 小时），再调 envd；connect 404 → `SandboxGoneError`，401 / 5xx / 网络错误 → 普通错误 |

- **超时**：E2B 沙箱到点（`timeoutSeconds`）会被处理；本插件建沙箱时设 `autoPause: true`，到点**暂停**而不是删除，
  所以内核来不及 `suspend`（例如内核整个挂了）时文件也不丢。每次使用都经 connect 往后推（只延长不缩短）。
  空闲休眠、过期销毁由内核的维护任务负责。E2B 的连续运行上限（Pro 24 小时、Hobby 1 小时）在暂停 / 恢复后重新计算。
- 暂停的沙箱 E2B 无限期保留，直到被删除（内核按 `destroyAfterInactiveDays` 删）。

## exec 与文件

- **exec**：envd 的 `process.Process/Start`（Connect 协议的服务端流），以 `sandbox` 用户运行
  `setsid -w /bin/sh -c <包装> … /bin/bash -c <命令>`；包装先把会话 id 写到 `/tmp/.capybara-exec-<uuid>.pid`。
  超时或中止时：以沙箱用户跑杀进程脚本，按进程组与会话 `SIGKILL` 命令派生的全部进程（与 Docker 插件相同），
  再用 envd 的 `SendSignal` 按 pid 兜底；杀完才返回，宽限 3 秒后断开连接（断开连接本身不会结束沙箱里的进程）。
  超时 resolve `timedOut: true, exitCode: null`；启动后被中止 resolve `exitCode: null, timedOut: false`（带已收集
  输出）；调用时已中止立即 reject。stdout + stderr 合计按 `maxOutputBytes` 截断并置 `truncated`，截断时退回到完整的
  UTF-8 字符边界。envd 每 50 秒发一次保活事件，长时间无输出的命令不会被中间代理断开。
- **readFile / stat**：以沙箱用户在沙箱里跑 `head -c` / `stat` 小脚本（权限与符号链接按沙箱用户解析）。缺文件 → null，
  readFile 遇到目录也返回 null。
- **writeFile**：envd 的上传接口以 root 打开目标、跟随符号链接，直接写目标会被 `/workspace/l -> /etc` 之类绕过权限。
  所以插件只把字节传到 root 专用的中转目录 `/opt/capybara/upload/<uuid>`（`/opt/capybara` 归 root、0700），再以 root
  运行 `runuser -u sandbox -- sh -c 'mkdir -p …; cat > 目标' < 中转文件`：root 只负责打开中转文件，建目录与写目标都按
  沙箱用户解析；中转文件无论成败都删除（被中止时可能残留在 root 专用目录里，随沙箱删除）。
- **/skills 只读**：`/skills` 归 root（0755），沙箱用户只能读。`writeFile("/skills/…")` 以 root 直接写（`umask 022`、
  文件 0644），沙箱用户无法在 `/skills` 里放符号链接，所以 root 的写入不会被引到别处。

## 出站（`limits.egress`）

E2B 的出站控制（[文档](https://docs.e2b.dev/sandbox/internet-access)，2026-10-21 核实）：

| `egress` | 建沙箱时的设置 |
|---|---|
| `none` | `allow_internet_access: false`（等同 `denyOut: ["0.0.0.0/0"]`） |
| `allowlist` | `network: { allowOut: allowHosts, denyOut: ["0.0.0.0/0"] }`；`allowHosts` 为空时同 `none` |
| `open` | `allow_internet_access: true`；须显式打开 `allowOpenEgress` |

`allowlist` 的局限（E2B 的实现决定，写在这里供评估）：

- 按域名过滤只作用于 **80 端口的 HTTP（看 Host 头）与 443 端口的 TLS（看 SNI）**；其他端口只按 IP / CIDR 过滤，
  白名单里只有域名时一律不通。UDP（QUIC / HTTP3）不支持按域名过滤。
- 用了域名白名单时 E2B 自动放行到 `8.8.8.8` 的 DNS（53 端口），DNS 查询本身可被用来外传少量数据。
- 过滤看的是沙箱自报的 Host / SNI：同一 CDN / 对象存储上的其他站点可能一并被放行（E2B 文档也这么提示）。
- 被拒的 TCP 连接在沙箱里可能看起来「连上了」，要看应用层（HTTP 状态、TLS 握手）才知道被拒。
- `*.example.com` 匹配子域（与 Docker 插件一致，不含 `example.com` 本身）。
- 自托管 E2B 不支持按域名过滤时设 `domainAllowlist: false`：`allowlist` 退化为 `none` 并打告警（不会悄悄放开）。

## 资源（`limits.cpu` / `memoryMb` / `diskMb`）

E2B 的 CPU 与内存在**构建模板时**确定（`Template.build` 的 `cpuCount` / `memoryMB`），建沙箱时不能按次指定；磁盘大小由
E2B 的套餐 / 模板决定。所以 `limits` 的 cpu / memoryMb / diskMb 本插件只做合法性校验、**不按沙箱生效**：想要的规格请在
构建模板时给出（上面的示例与内核默认值 1 核 / 2048 MB 一致），不同规格用不同模板。

## 客户端

不用官方 `e2b` SDK，自写极简客户端（`src/e2b-api.ts`，全局 `fetch`，无第三方依赖）：

- 每个请求直接挂调用方的 AbortSignal，中止语义可控（命令流由插件自己断开：先杀进程再断开）；
- 官方 SDK 会读 `E2B_API_KEY` / `E2B_DOMAIN` / `E2B_SANDBOX_URL` / `E2B_DEBUG` 等进程环境变量、在模块级缓存连接池
  （多副本纪律不允许插件有模块级可变状态），还带 undici、Connect、protobuf 等一串依赖；
- 只用到控制面的 6 个接口与 envd 的 3 个接口，协议照 SDK `e2b@2.58.0` 的实现（`src/e2b-api.ts` 头部注释列出）。

协议出处（2026-10-21 核实）：`e2b@2.58.0` 的 `dist/index.mjs`；E2B 文档
[internet-access](https://docs.e2b.dev/sandbox/internet-access)、[persistence](https://docs.e2b.dev/sandbox/persistence)、
[sandbox lifecycle](https://docs.e2b.dev/sandbox)、[template quickstart](https://docs.e2b.dev/template/quickstart)、
[template migration（fromDockerfile）](https://docs.e2b.dev/template/migration-v2)；envd 源码
[upload.go](https://github.com/e2b-dev/infra/blob/main/packages/envd/internal/api/upload.go)。

## 仅测试的选项

`createE2BSandbox(config, { log }, testOptions)` 的第三个参数只有直接调用它的代码能传，插件配置设不了：

- `envdUrl`：envd 地址改为这个（按 `E2b-Sandbox-Id` 请求头路由），不按沙箱 id 与域名拼。

## 测试

- `test/sandbox-e2b.test.ts`：对着 `@capybara-hq/testing` 的 `startFakeE2B`（控制面 API + envd，Connect 流协议，
  命令在本机临时目录里真的跑），覆盖各方法、错误映射（404 → gone，401 / 5xx → 普通错误）、中止、超时杀进程、
  文件读写与 `/skills` 的写法、出站映射。
- `test/live`：真实 E2B，只在设了 `CAPYBARA_TEST_E2B_API_KEY` 与 `CAPYBARA_TEST_E2B_TEMPLATE` 时运行（可选
  `CAPYBARA_TEST_E2B_API_URL` / `CAPYBARA_TEST_E2B_DOMAIN`），否则跳过：沙箱用户、文件、`/skills` 只读（含经符号链接写入
  被拒）、出站白名单、超时杀进程、暂停 / 恢复、销毁后 gone。
