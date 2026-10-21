# @capybara-hq/plugin-sandbox-docker

对话沙箱（`sandbox@1`）的 Docker 实现：每个对话一个容器（`cap-<对话 id>`），运行时可选 runc 或 gVisor 的 runsc。
插件**只经 endpoint 访问 Docker**（`docker/sandbox-proxy` 的 socket 代理），自己不挂 `docker.sock`。

## 部署配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `endpoint` | （必填） | socket 代理地址：`tcp://sandbox-proxy:2375` 或 `unix:///path` |
| `runtime` | `runc` | `runc` 或 `runsc`（runsc 须先在 Docker 守护进程里登记） |
| `network` | `capybara-sandbox` | 共用的沙箱网络名，须以 `cap` 开头（socket 代理只放行这样的网络）；不存在时插件按 bridge、`enable_icc=false`（容器互不相通）创建 |
| `egressProxyImage` | `capybara-sandbox-egress:latest` | 出站代理镜像（`egress-proxy/Dockerfile`） |
| `volumeDriver` | （不填，用 local） | 工作区卷的驱动；设了就带 `DriverOpts.size=<diskMb>M` |
| `allowOpenEgress` | `false` | 允许 `sandbox.limits.egress = "open"`；为 false 时 `create` 收到 open 直接报错（英文错误） |

```bash
export CAPYBARA_PLUGIN_CONFIG='{"sandbox-docker":{"endpoint":"tcp://127.0.0.1:2375"}}'
```

部署配置 schema 是 strict：多出的键直接报错。

## 镜像

- 沙箱镜像 `image/Dockerfile`（Docker 插件与 E2B 模板共用）。标签与内核配置 `sandbox.image` 的默认值一致：
  `docker build -t capybara-sandbox:latest plugins/sandbox-docker/image`。
  Debian trixie-slim（按摘要固定），带 bash、coreutils、GNU find / grep（内核的 `sandbox_glob` / `sandbox_grep`
  依赖）、procps、util-linux（`setsid`）、curl、git、jq、python3（含 pip / venv）等；以非 root 用户 `sandbox`
  （uid 1000）运行，HOME 与工作目录是 `/workspace`。
- 出站代理镜像 `egress-proxy/Dockerfile`：`docker build -t capybara-sandbox-egress:latest plugins/sandbox-docker/egress-proxy`。
- 多架构（amd64 + arm64）：`docker buildx build --platform linux/amd64,linux/arm64 -t <仓库>/<名>:<标签> --push <目录>`。
- 本地开发：`docker compose -f docker/compose.dev.yaml --profile sandbox up -d` 构建两个镜像并起 socket 代理
  （`127.0.0.1:2375`，**只供本机开发**，见下面的部署要求）。镜像不在本地时插件会尝试拉取一次。

## socket 代理（`docker/sandbox-proxy/haproxy.cfg`）

HAProxy（官方镜像，按摘要固定），代理以 root 运行（读 socket）。两道检查：

1. **路径与名字**：只放行插件实际调用的接口（容器 create / inspect / start / stop / kill / restart / remove、
   exec create / start / inspect、卷 create / inspect / remove、网络 create / inspect / remove、镜像 inspect / pull、
   `_ping` / `version`），其余 403。容器与卷只认 `cap-` 开头的名字（建容器要求 `?name=cap-…`），网络只认 `cap`
   开头的名字；插件一律按名字访问容器，从不用 id。exec 实例（`/exec/{id}/…`）无法按名字过滤，但建 exec 已要求
   `cap-` 容器。
2. **请求体（纵深防御）**：带体的接口必须是 JSON、带 Content-Length、≤ 32 KiB 且已整个缓冲（大于缓冲区的请求体
   一律拒绝，不能靠超长请求体绕过）。拒绝（不区分大小写）：特权、`Binds` / `CapAdd` / `Devices` /
   `VolumesFrom` / `CgroupParent` / `Sysctls` / `Annotations` / `MaskedPaths` / `PortBindings` 等键、`volume` /
   `tmpfs` 以外的挂载类型、host / container 命名空间模式、`no-new-privileges` 以外的 `SecurityOpt`、runc / runsc
   以外的运行时、`none` / `cap…` 以外的网络、任何 `\u` 转义与非 ASCII 字节（Go 的 JSON 解码按 Unicode 折叠键名，
   `"Bindſ"` 会被当成 `Binds`；exec 的命令可以有中文，只拒绝键名里的 `\u` 与非 ASCII）、会绕过「必须是某值」检查的
   重复键；卷不能带 local 驱动的 `device` / `o` / `type`（可做成 bind），网络只能是 bridge。插件自己生成的建容器 / 卷 /
   网络请求体全是 ASCII，值里出现非 ASCII（镜像名、标签、白名单主机名须用 punycode）在插件里就报英文错误。
   **这只是正则兜底，不是 JSON 解析；主要防线是网络位置**（见下面的部署要求）。

**部署要求**：能访问代理就几乎能控制 Docker（第二道只是兜底）。**绝不要把它发布到宿主机的任何地址上**——包括
`127.0.0.1`：Docker Desktop 上普通 bridge 网络里的容器经 `host.docker.internal` 就能访问宿主机回环；Linux 上
网桥网关地址也能到达宿主机监听的端口。生产环境只把它放在内核所在的内部网络上，不映射端口，沙箱不接那个网络。
开发编排为了让本机的内核连上，把它发布在 `127.0.0.1:2375`：只在本机开发用，并且不要打开 `allowOpenEgress`。

## 生命周期

| 操作 | 做什么 |
|---|---|
| `create` | 先删掉同名旧实例（内核可能在记下句柄前退出），再建卷、（allowlist 时）内部网络与出站代理、沙箱容器并启动；句柄 id 就是 name |
| `suspend` | 停止沙箱容器与出站代理（文件留在卷上） |
| `resume` | 启动；容器不存在返回 `gone`。allowlist 的出站代理或内部网络丢了按容器标签里记下的白名单重建 |
| `destroy` / `destroyByName` | 删容器、出站代理、内部网络、两个卷；不存在也算成功 |
| `exec` | `docker exec`（沙箱用户、bash）；超时或中止时按会话 SIGKILL 命令及其派生的全部进程。杀进程用的 exec 本身起不来时（如进程数已到上限）退而重启整个容器（`restart?t=0`）：文件都在卷上，`/tmp` 清空、沙箱里其余进程一并结束。输出被截断时退回到完整的 UTF-8 字符边界 |
| `readFile` / `writeFile` / `stat` | 在容器里以沙箱用户跑 `head` / `stat` 小脚本（权限、符号链接都按沙箱用户解析，不经守护进程以 root 写卷） |

每个对话的资源：容器 `<name>`、出站代理 `<name>-egress`、内部网络 `<name>-net`、卷 `<name>-workspace`
（`/workspace`）与 `<name>-skills`（`/skills`）。都带标签 `dev.capybara.sandbox=1`、`dev.capybara.sandbox.name=<name>`。

## 隔离与限制

- 非 root（uid 1000）、`CapDrop: ALL`、`no-new-privileges`、根文件系统只读、`Init`（回收僵尸进程）、
  `PidsLimit` 1024、私有 IPC。
- cpu → `NanoCpus`；内存 → `Memory`（`MemorySwap` 同值，不用 swap）。
- `/tmp` 是 tmpfs（`nosuid,nodev`），大小取内存的一半且不超过 `diskMb`，计入内存配额；挂起后清空。
- `/skills` **只读挂载**；同一个卷另以可写方式挂在 `/opt/capybara/skills`（`/opt/capybara` 归 root、0700，
  沙箱用户进不去，也无法经符号链接绕进去），插件 `writeFile("/skills/…")` 以容器内 root 经它写入。
- **磁盘**：根文件系统只读，所有写入都落在工作区卷与 `/tmp`。`--storage-opt size` 只限制容器可写层，
  对只读根文件系统没有意义，所以不用。工作区卷的大小只在设了 `volumeDriver` 且该驱动支持 `size` 选项时生效；
  **默认的 local 驱动不限制卷大小**（`diskMb` 不生效），需要硬限制时用支持配额的卷驱动，或在宿主机上
  给 Docker 卷目录配 XFS project quota 等。

## 出站（`limits.egress`）

- `none`：`NetworkMode: none`，只有回环。
- `open`：接到共用网络 `network`（普通 bridge），**能访问宿主机网络能访问的一切**：宿主机上监听的服务（Docker
  Desktop 上经 `host.docker.internal` 连宿主机回环，所以发布在 127.0.0.1 上的 socket 代理也能被它访问到）、内网、
  云元数据地址。须显式打开部署配置 `allowOpenEgress`（默认关），只在可信环境用。
- `allowlist`（默认）：沙箱只接一个 `Internal` 的内部网络，上面只有它的出站代理；代理另一只脚接共用网络。
  `HTTP_PROXY` / `HTTPS_PROXY`（及小写）已设好，`NO_PROXY` 为回环。代理（`egress-proxy/proxy.mjs`，无依赖的 Node）：
  - 主机名精确匹配 `allowHosts`，或 `*.example.com` 匹配任意子域（**不含** `example.com` 本身）；IP 字面量永远不放行；
  - 先解析，**解析出的每个 IP** 都不能是私有、回环、链路本地（含 169.254.169.254）、CGNAT（100.64/10）、ULA
    （fc00::/7）、未指定、组播、保留或文档地址（IPv4 映射 / NAT64 / 6to4 按内嵌 IPv4 判断），否则 403——挡住
    DNS 重绑定（如 `10.0.0.1.nip.io`）；然后直连检查过的那个 IP，不再二次解析；
  - HTTPS 走 CONNECT（只放行 443、80 端口；代理容器环境变量 `ALLOW_CONNECT_PORTS` 可改），HTTP 走绝对 URL 转发；
    第一个地址连不上时依次试其余检查过的地址；不走代理的直连不通（内部网络没有出口）。
  - 内部网络没有默认路由，Docker 内置 DNS 也不替它解析外部域名（Docker 29 上验证）；不经 HTTP 代理的协议
    （ssh、git://）不可用。
  - 已知局限：旧版 Docker 的 Linux 宿主机上，内部网络里的容器可能连得到宿主机在该网桥地址上监听的服务；
    宿主机上的服务不要监听 0.0.0.0，或用防火墙挡掉来自沙箱网段的入站。

## 仅测试的选项

`createDockerSandbox(config, testOptions)` 的第二个参数只有直接调用它的代码能传，插件配置设不了：

- `labels`：给所有资源额外打标签（测试按标签清理）；
- `egressTestHosts`：出站代理把这些主机名固定到给定 IP，并豁免私有地址检查（仍须在白名单里），
  用于把测试里的本地 HTTP 服务当作放行目标。经代理容器的环境变量 `CAPYBARA_EGRESS_TEST_HOSTS` 传入。

## 测试

`test/egress-proxy.test.ts` 不需要 Docker；`test/sandbox-docker.test.ts` 需要 Docker（没有时整组跳过），
构建唯一标签的测试镜像、起 socket 代理，结束时按标签清理；runsc 用例只在守护进程登记了 runsc 时运行。
内核的冒烟用例在 `packages/kernel/test/tools/sandbox/sandbox-docker.smoke.test.ts`。
