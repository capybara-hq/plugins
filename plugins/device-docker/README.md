# @capybara-hq/plugin-device-docker

The Docker implementation of the device sandbox (`device-provider@1`), with a runtime of either runc or gVisor's runsc. Each device
(`cap-device-<device id>`) has a **file system**, its two Docker volumes, which lives until the device is deleted, and an **instance**, the container
(with its egress proxy and internal network), which is suspended when idle, destroyed after long disuse and recreated on the next use with the same files.
The plugin **reaches Docker only through the endpoint** (the socket proxy in capybara-hq/core's [`docker/sandbox-proxy`](https://github.com/capybara-hq/core/tree/main/docker/sandbox-proxy)) and does not mount `docker.sock` itself.

Renamed from `@capybara-hq/plugin-sandbox-docker` (no alias: devices made by the old plugin read as unavailable and are recreated); the image names
(`ghcr.io/capybara-hq/capybara-sandbox` and `capybara-sandbox-egress`) stay, tagged with this plugin's version. `device-provider@1` is a multi point,
so it can run alongside other device providers; each device stays bound to the provider that made it.

**Device page**: `report` describes the device as a Docker container (runc or gVisor) with its files on a volume, lists the cpu and memory the
container was created with (and the disk when a volume driver sizes the workspace volume), and offers a files reset. New devices are made from the
short `device-connection` guide (`guides/connect.md`): name it and create it.

## Deployment config

| Key | Default | Description |
|---|---|---|
| `endpoint` | (required) | Socket proxy address: `tcp://sandbox-proxy:2375` or `unix:///path` |
| `runtime` | `runc` | `runc` or `runsc` (runsc must be registered in the Docker daemon first) |
| `network` | `capybara-sandbox` | Name of the shared sandbox network every egress proxy joins for its outbound leg; it must start with `cap` (the socket proxy only allows such networks); if it does not exist the plugin creates it as a bridge with `enable_icc=false` (containers cannot reach each other) |
| `egressProxyImage` | `ghcr.io/capybara-hq/capybara-sandbox-egress:<plugin version>` | Egress proxy image (`egress-proxy/Dockerfile`); set it to use your own build (the offline route below) |
| `volumeDriver` | (unset, uses local) | Driver for the workspace volume; when set, `DriverOpts.size=<diskMb>M` is passed (at `createFileSystem`) |
| `deniedCidrs` | (unset) | The deployment's own public or corporate ranges (IPv4 / IPv6 CIDRs such as `203.0.113.0/24`, at most 256; a single address is `/32` or `/128`) that every egress proxy refuses in both modes, on top of its built-in list; invalid entries fail the config. Passed to the proxy as `DENIED_CIDRS`; applies to proxies created afterwards (a new instance, or an `update` that replaces the proxy) and goes with every in-place list change (`update`). See [Network and egress](#network-and-egress) |
| `refuseOpenNetwork` | `false` | Locked-down deployments: when on, a `create` / `update` whose effective network is `open-public` fails with an English error naming `extensionConfig."device-docker".refuseOpenNetwork`, and an existing open-public instance answers `gone` on `resume` / auto-start so the kernel recreates it under the rule; the device network then has to be the allowlist (the platform or org ceiling, or the device itself). See [Network and egress](#network-and-egress) |

```bash
export CAPYBARA_EXTENSION_CONFIG='{"device-docker":{"endpoint":"tcp://127.0.0.1:2375"}}'
```

The deployment config schema is strict: extra keys are errors, including the former `openEgress` and
`allowOpenEgress` (no compatibility; the network is now `limits.network`).

## Images

Both images are published by this repository's image workflow, multi-arch (amd64 + arm64), tagged with this plugin's version:

| Image | Used for |
|---|---|
| `ghcr.io/capybara-hq/capybara-sandbox:<plugin version>` | `create` without `image` (the kernel passes an `image` only when the kernel config `sandbox.image` or the device pins one) |
| `ghcr.io/capybara-hq/capybara-sandbox-egress:<plugin version>` | the egress proxy, unless `egressProxyImage` is set |

The version is the extension manifest's `version` (`src/index.ts`, kept equal to `package.json` by `capybara-plugin sync-versions`), so a
plugin upgrade moves both images with it and the kernel never needs to know the plugin's version.

- The sandbox image `image/Dockerfile` (shared by the Docker plugin and the E2B template).
  Debian trixie-slim (pinned by digest), with bash, coreutils, GNU find / grep (the kernel's `Glob` / `Grep`
  depend on them), ripgrep (`rg`: the kernel's `Glob` / `Grep` prefer it, so ignore files such as `.gitignore` are honored), procps, util-linux (`setsid`), curl, git, jq, python3 (with pip / venv) and so on; it runs as the non-root user `sandbox`
  (uid 1000), with HOME and the working directory at `/workspace`. **One image serves every device**: what limits a device is the
  container and its network, not missing binaries:
  - Node 22 LTS (the official tarball, checksum-pinned), pnpm (installed globally) and yarn (a corepack shim; `COREPACK_HOME`
    and its downloads under `/workspace/.cache/corepack`, no download prompt), `NODE_USE_ENV_PROXY=1` so Node's own `fetch`
    uses the proxy. The root file system is read-only, so `npm install -g` goes to `npm_config_prefix=/workspace/.cache/npm-global`
    (its `bin` is on `PATH`), and a pnpm version a project picks with its `packageManager` field is downloaded into pnpm's home
    under HOME (`/workspace/.local/share/pnpm`);
  - `openssh-client`, `netcat-openbsd` (`nc -X 5`, used by `GIT_SSH_COMMAND`), `socat`,
    `build-essential` and `pkg-config` (native npm / pip modules); `/etc/ssh/ssh_known_hosts` holds the published host keys
    of github.com, gitlab.com and bitbucket.org (other ssh hosts: add their key to `~/.ssh/known_hosts` in the workspace, or
    pass `-o StrictHostKeyChecking=accept-new` knowingly);
  - the Chromium runtime libraries (the Debian set `playwright install-deps chromium` installs), `fonts-liberation`
    and `fonts-noto-cjk`, but **no browser binary**: Playwright downloads its own into `PLAYWRIGHT_BROWSERS_PATH`
    (`/workspace/.cache/ms-playwright`, from `cdn.playwright.dev` / `playwright.download.prss.microsoft.com`). Chromium's
    own sandbox cannot start in a container without capabilities; Playwright's `chromiumSandbox` option defaults to
    `false`, keep it so (the container is the sandbox). `/dev/shm` is sized for browsers (below);
  - package caches on the workspace volume, so they persist with the device's files and pnpm can hard-link into
    `node_modules`: `XDG_CACHE_HOME=/workspace/.cache`, `npm_config_cache`, `npm_config_store_dir` (pnpm),
    `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `CARGO_HOME`, `GOMODCACHE`, `GOCACHE`, `GRADLE_USER_HOME` and
    `PLAYWRIGHT_BROWSERS_PATH`, all under `/workspace/.cache/`. The root file system stays read-only.
- The egress proxy image `egress-proxy/Dockerfile`.
- **Offline route** (a deployment without access to ghcr.io): build both images yourself
  (`docker build -t capybara-sandbox:local plugins/device-docker/image`,
  `docker build -t capybara-sandbox-egress:local plugins/device-docker/egress-proxy`, or
  `docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/<name>:<tag> --push <directory>` for a private registry), then set the kernel config
  `sandbox.image` to the sandbox image and this plugin's `egressProxyImage` to the egress image.
- Local development: in a [capybara-hq/core](https://github.com/capybara-hq/core) checkout, `docker compose -f docker/compose.dev.yaml --profile sandbox up -d` ([`docker/compose.dev.yaml`](https://github.com/capybara-hq/core/blob/main/docker/compose.dev.yaml)) builds both images and starts the socket proxy
  (`127.0.0.1:2375`, **for local development only**, see the deployment requirements below). If an image is not local the plugin tries to pull it once.
- **Size**: the sandbox image is about 1.5 GB unpacked (about 390 MB compressed to download), mostly the toolchain, the
  Chromium libraries and the CJK fonts.
- **In a deployment, pre-pull both images on every Docker node** (with the image size above this matters) (`docker pull …`): if an image is not local
  the plugin pulls it only when a device's instance is first created, and a pull of several hundred MB eats into the time limit of that tool call (`tools.timeoutMs` plus the lock wait and a 3-minute margin);
  when it is slow that call fails, and the next one tries again.

## Socket proxy (`docker/sandbox-proxy/haproxy.cfg`)

The proxy and its config live in capybara-hq/core: [`docker/sandbox-proxy/haproxy.cfg`](https://github.com/capybara-hq/core/tree/main/docker/sandbox-proxy/haproxy.cfg).

HAProxy (the official image, pinned by digest); the proxy runs as root (to read the socket). Two checks:

1. **Paths and names**: only the endpoints the plugin actually calls are allowed (container create / inspect / start / stop / kill / restart / unpause / remove,
   exec create / start / inspect, volume create / inspect / remove, network create / inspect / remove, image inspect / pull,
   `_ping` / `version`), everything else gets 403. The query string of an image pull (`POST /images/create`) may only be a single `fromImage`: `fromSrc`
   (importing an arbitrary filesystem from a URL or the request body), `repo` / `tag` (renaming to overwrite an image), `message` and `changes` always get 403. Containers and volumes accept only names starting with `cap-` (creating a container requires `?name=cap-…`), and networks accept only names starting with `cap`;
   the plugin always accesses containers by name and never by id. Exec instances (`/exec/{id}/…`) cannot be filtered by name, but creating an exec already requires
   a `cap-` container.
2. **Request body (defense in depth)**: an endpoint with a body must be JSON, carry Content-Length, be ≤ 32 KiB and be fully buffered (a body larger than the buffer
   is always rejected, so an oversized body cannot be used to bypass it). Rejected (case-insensitively): privileged, keys such as `Binds` / `CapAdd` / `Devices` /
   `VolumesFrom` / `CgroupParent` / `Sysctls` / `Annotations` / `MaskedPaths` / `PortBindings`, mount types other than `volume` /
   `tmpfs`, mounts whose `Source` does not start with `cap-` (the kernel's or another service's volumes cannot be mounted), host / container namespace modes, a `SecurityOpt` other than `no-new-privileges`, runtimes other than runc / runsc,
   networks other than `none` / `cap…`, any `\u` escape and non-ASCII byte (Go's JSON decoding folds key names by Unicode,
   so `"Bindſ"` would be treated as `Binds`; an exec command may contain Chinese, and only `\u` and non-ASCII in key names are rejected), duplicate keys that would bypass a "must be a given value" check;
   a volume cannot carry the local driver's `device` / `o` / `type` (which could make it a bind), and a network can only be bridge. The create container / volume /
   network request bodies the plugin generates itself are all ASCII, and a non-ASCII value (image names, tags and allowlist host names must use punycode) is reported as an English error in the plugin itself.
   **This is only a regex backstop, not JSON parsing; the main line of defense is network position** (see the deployment requirements below).

**Deployment requirement**: whoever can reach the proxy can almost control Docker (the second check is only a backstop). **Never publish it on any host address**, including
`127.0.0.1`: on Docker Desktop a container on an ordinary bridge network can reach the host loopback through `host.docker.internal`; on Linux
the bridge gateway address can also reach ports the host listens on. In production, put it only on the internal network the kernel is on, with no port mapping, and do not attach sandboxes to that network.
To let the local kernel connect, the dev compose publishes it on `127.0.0.1:2375`: use that for local development only.
Every sandbox reaches Docker through the proxy only and its egress proxy refuses loopback and private addresses.

## Lifecycle

| Operation | What it does |
|---|---|
| `createFileSystem` | Creates the volumes `<name>-workspace` (with the `volumeDriver` size option), `<name>-skills` and `<name>-services` (device service state; with `volumeDriver`, sized `min(diskMb, 2048)` MB), labelled `dev.capybara.sandbox.role=workspace` / `skills` / `svc`; a volume that already exists is kept as it is (idempotent by name, never replaced); the handle id is the name |
| `destroyFileSystem` / `destroyFileSystemByName` | Force-removes the instance of the same name first (Docker refuses to remove a volume a container still uses, even a stopped one), then removes its three volumes; a missing one counts as success. The kernel's one-off cleanup calls `destroyFileSystemByName("cap-<conversation id>")` for `sandbox@1` sandboxes, whose volumes `cap-<conversation id>-workspace` / `-skills` follow the same naming |
| `create` | Checks that both volumes of the file system exist and carry their role label (`GET /volumes/<name>`); otherwise it throws `FileSystemGoneError`, because Docker would silently create empty volumes for a missing mount source. A missing `<name>-services` volume (a file system made before isolated device services) is created, empty (sized like `createFileSystem`'s). Then deletes any old instance of the same name (the kernel may have exited before recording the handle; its volumes are kept), creates (see [Network and egress](#network-and-egress)) the internal network, the egress proxy and the sandbox container, checks the volumes again (if they were removed in between, Docker made empty unlabelled ones for the mounts: the container and those volumes are removed and `create` throws `FileSystemGoneError`) and starts it. **Fencing**: the kernel's token is stamped on the sandbox container and the proxy (`dev.capybara.sandbox.fence`) and given to the proxy (`FENCE`); before replacing an old instance under the name, `create` reads its token (the higher of its labels and its running proxy's own) and throws `StaleFenceError`, touching nothing, when it is higher than the call's (a stale holder). That read and the removal are two steps (Docker has no conditional remove), so the handle carries the token too: the handle is `{ id: <name>, fence: <token> }`, and every call on it checks the container's fence label first, a replacement under the same name answering `SandboxGoneError` (`gone` for `resume`). Without a token (an older kernel) the instance is seeded with 0, so every handle then names fence 0 and the identity check cannot tell incarnations apart (fencing is off with such a kernel). Without `image` it uses the published sandbox image |
| `destroy` / `destroyByName` | Force-removes the sandbox container, the egress proxy, the internal network and the proxy's config volume (never the file system's volumes); a missing one counts as success. With a fence token, an instance whose label carries a higher token (a newer holder created it) is refused with `StaleFenceError`; `null` (the kernel's cleanup without a device lease) or no token removes without a check |
| `suspend` | Stops the sandbox container and the egress proxy (files stay on the volumes). **Processes are not preserved**: all background processes in the sandbox end and `/tmp` (tmpfs) is cleared; E2B's pause, in contrast, keeps memory too |
| `resume` | Starts (or unpauses one that was `docker pause`d); if the container does not exist it returns `gone`. With `refuseOpenNetwork` on, a container whose labels say `open-public` (made before the setting was turned on) is not started and answers `gone` too, so the kernel recreates it under the current rule. If the egress proxy or internal network is gone, it is rebuilt: for an instance with the egress control (every instance this version creates) only on the instance's config volume `<name>-egress-conf`, which holds the list in force; when that volume is gone too (or the proxy lacks the control), `resume` answers `gone` and the kernel recreates the instance under the desired network, never a proxy rebuilt from the create-time labels, which an in-place narrowing left wider than the list in force. An instance made by an earlier version with the egress control (label `1`) is treated the same way (its list may have changed in place; its config file has no fence, so a rebuilt proxy refuses to start and `resume` answers `gone`); only an instance without any control label is rebuilt from the network and host list recorded in its labels (that version changed its proxy only to lists covering them). **A proxy on another image** than the configured `egressProxyImage` is replaced the same way, here and before every use of a running instance (auto-start, commands, operations, service starts): compared by image id once the configured image is local (pulled when missing), so a new build under the same tag (the offline route's `:local`, any moving tag) counts and the same image under another reference does not. Only the proxy container is replaced, on the same config volume and networks, with the instance's create-time token (a config file on the volume carries the list and token in force and wins); for an instance with the egress control the configured image must carry the control too, or `resume` answers `gone` (the kernel recreates the instance), never a proxy that would start from the labels. A configured image that cannot be resolved throws before the old proxy is touched. The sandbox container keeps the image it was created with until the instance is recreated (gone, destroyed after inactivity, a change of network kind, the services generation label) |
| `update` | Called by the kernel under the exclusive lease when the network of an existing instance changed (`limitsApplyAt: "instance"`). **Allowlist to a non-empty allowlist** (wider, narrower or both) is applied **in place**: `docker exec` runs the proxy's control client as its own user (`node /app/proxy.mjs control apply`, the new list and the current `deniedCidrs` as one JSON line on stdin); the proxy validates the whole list, writes it to its config volume (temp file, fsync, rename), swaps it, **closes every connection the new list no longer covers** (open tunnels and HTTP requests, and those still resolving or connecting) and only then answers with the list's digest. Every apply carries the kernel's **fence token**: the proxy keeps the highest token it applied in the same file as the list and, inside its serialized apply, refuses a lower one (`StaleFenceError` from `update`; nothing written, swapped or closed), so a kernel replica that lost its lease unnoticed can never land an older list after a newer holder's change; the same list with a higher token only stores the token. An `update` without a token (an older kernel) answers `"recreate"` for an allowlist change, since its freshness cannot be proven. `update` answers `"updated"` only on the digest of the list it sent; a non-zero exit, a timeout, a wrong digest or an abort throws, and the kernel recreates the instance (fail closed). The sandbox container, its processes and every connection the new list still allows stay; a repeated list is acknowledged at once (idempotent by digest). A suspended instance has its proxy started for the call and stopped again; a lost proxy is rebuilt from the config volume first (or `"recreate"` without it). Open-public to open-public replaces only the egress proxy. Everything else (a change of network kind in either direction, so the labels always name the kind in force; an empty list, which is `NetworkMode: none`; a container without this contract's labels; a missing container) answers `"recreate"`, and the kernel destroys and recreates the instance on the same files. An instance made by an earlier plugin version (no egress control label `2`) answers `"recreate"` for every allowlist change: replacing its proxy deletes first and cannot be fenced, so the recreate rebuilds it fenced, once, at its first network change (never at upgrade). A handle whose fence differs from the container's label throws `SandboxGoneError`. With `refuseOpenNetwork` on, an update to open-public throws like `create`. **Narrowing rule**: `"updated"` for a narrowing is answered only once no connection to a removed host survives and no new one can open |
| Auto-start | When `exec` / `readFile` / `writeFile` / `stat` / `killAll` find the container still exists but is not running (Docker returns 409: the host or daemon restarted, the idle sweep stopped the container before it could record `suspended`, someone ran `docker pause` on it…), they recover it the way `resume` does (egress proxy and network in place; unpause a paused one, start a stopped one; an open-public container under `refuseOpenNetwork` throws `SandboxGoneError` instead) and retry once (the `device-provider@1` contract: the kernel trusts only the `running` it recorded itself) |
| `killAll` | Kills every command started through `exec` that is still running (finds the wrapper by command line and sends SIGKILL by process group and session); called when the kernel takes over from a crashed previous lock holder. A process that a command puts in the background in a session of its own (`setsid`) is not guaranteed to be killed |
| Concurrent use (`concurrentExec`, `killTagged`) | Declares `concurrentExec: true`: the sessions of one device (and their sub-agents) run commands and file operations in its sandbox at the same time (independent `docker exec` instances; the socket proxy rules are unchanged). Each exec's control file carries the holder's tag (`/tmp/.capybara-exec-<tag>-<uuid>`, tags checked against `SANDBOX_TAG_RE`); `killTagged` kills only the commands of the given tags (a variant of the `killAll` script), used when the kernel takes over from a crashed holder while others keep running. Concurrent auto-starts of a stopped container are idempotent (`start` answers 304; a concurrent egress proxy create answers 409, tolerated). Concurrent commands share the container's `PidsLimit` (1024) and memory. When the kill exec itself cannot start, the container restarts, which also ends live siblings' commands (a last resort) |
| `destroy` / `destroyByName` | Deletes the instance: the container, egress proxy, internal network and the egress proxy's config volume `<name>-egress-conf` (it belongs to the instance), **never the file system's volumes**; a missing one also counts as success |
| `exec` | `docker exec` (sandbox user, bash); the `actor` argument is not used (phase 1); on timeout or abort it SIGKILLs the command and all processes it spawned by session. Commands run through `/usr/bin/setsid` and `timeout -s KILL <timeout + 5 seconds>`, `timeout` looked up on the system PATH (`/usr/sbin:/usr/bin:/sbin:/bin`, root-owned) inside the wrapper, never on the image's PATH, whose first entry `/workspace/.cache/npm-global/bin` the sandbox user can write; the command itself keeps the image's PATH, and every other provider-run script (kills, file calls, the root `/skills` write) gets the system PATH (#106): when a kernel replica crashes (the timer on the plugin side is gone, and a dropped connection does not end the command) the time limit inside the sandbox is the backstop. When the exec used to kill processes cannot itself start (for example the process count has hit its limit), it falls back to restarting the whole container (`restart?t=0`): files are all on the volumes, `/tmp` is cleared, and the remaining processes in the sandbox all end. When output is truncated it backs up to a full UTF-8 character boundary |
| `readFile` / `writeFile` / `stat` | Run small `head` / `stat` scripts in the container as the sandbox user (permissions and symlinks are resolved as the sandbox user, and the volume is not written as root through the daemon) |
| `list` / `scan` (projects) | A `python3 -I` script (`src/listing.ts`, the same file as the E2B plugin's; it follows the rules of core's local device docker mode) run in the container as the sandbox user under `timeout -s KILL 30` with `PATH=/usr/local/bin:/usr/bin:/bin` (never the writable `/workspace/.cache/npm-global/bin`), the normalized path passed as argv. The reachable area is `/workspace` (core spec 2026-11-14 project root §4.2; the kernel scopes a cloud device's projects to it): a path outside it, also through a link, is refused with `ProjectPathRefusedError` and a fixed reason (en / zh) the kernel answers as `device.project_refused`, and the owner browse (`browse`: `stat` / `list` / `scan`, what the kernel adds projects through) refuses such a path the same way before anything runs, so the device page explains the refusal when the project is added; a link whose target leaves it is not a directory. `scan` walks breadth-first, at most 500 directories, two levels below the base, without following links. An abort returns at once; the read-only script ends at its time limit at worst. Needs python3 and timeout in the image (a clear error otherwise; so is a listing that hits the 30 s limit) |

Resources for each device (`<name>` = `cap-device-<device id>`): the instance is the container `<name>`, the egress proxy `<name>-egress` and the
internal network `<name>-net` and the egress proxy's config volume `<name>-egress-conf` (the list in force, mounted only in the proxy at `/config`); the file system is the volumes `<name>-workspace` (`/workspace`), `<name>-skills` (`/skills`) and `<name>-services` (`/var/lib/capybara/svc`, device service state). All carry the labels
`dev.capybara.sandbox=1`, `dev.capybara.sandbox.name=<name>` and `dev.capybara.sandbox.role=<role>`.

## Isolation and limits

- Commands and file operations run as non-root (uid 1000); the container's main processes (`Init`'s tini and `sleep infinity`) run as root
  (`User: 0:0`, with all capabilities dropped too): the sandbox user cannot signal them, and `kill 1`, `pkill sleep` and `kill -9 -1` cannot stop
  the container. Every exec specifies the user explicitly; a manual `docker exec` without `-u` runs as root (with no capabilities).
- `CapDrop: ALL`, `no-new-privileges`, a read-only root filesystem, `Init` (reaps zombie processes), `PidsLimit` 1024, private IPC.
- **Chromium runs without its own sandbox** (`--no-sandbox`, plugins#286). The container is the boundary: the agent can already
  run arbitrary commands in it, so a browser renderer escape gains nothing beyond that. Chromium's sandbox needs unprivileged
  user namespaces, which Docker's default seccomp profile blocks without `CAP_SYS_ADMIN`; enabling it would mean a wider seccomp
  profile for every command in the device (rejected) or a separate browser container (not planned now). The provider
  refuses any `SecurityOpt` other than `no-new-privileges` for services.
- cpu → `NanoCpus`; memory → `Memory` (`MemorySwap` the same value, so no swap is used).
- `/tmp` is tmpfs (`nosuid,nodev`), sized at half the memory and no more than `diskMb`, and counts against the memory quota; it is cleared after suspension.
- `/dev/shm`: `ShmSize = min(1 GiB, memoryMb / 4)` for every instance (Chromium and other shared-memory users); it
  counts against the memory quota too.
- `/skills` is **mounted read-only**; the same volume is also mounted writable at `/opt/capybara/skills` (`/opt/capybara` is owned by root, 0700,
  so the sandbox user cannot enter it, nor get in through a symlink), and the plugin's `writeFile("/skills/…")` writes through it as root inside the container.
- **Disk**: the root filesystem is read-only, and all writes land on the workspace volume and `/tmp`. `--storage-opt size` limits only the container's writable layer,
  which is meaningless for a read-only root filesystem, so it is not used. The workspace volume size takes effect only when `volumeDriver` is set and that driver supports the `size` option;
  **the default local driver does not limit volume size** (`diskMb` has no effect). When you need a hard limit, use a volume driver that supports quotas, or configure an XFS project quota and the like
  on the Docker volume directory on the host.

**Command time limit**: a single command runs at most `sandbox.limits.maxCommandSeconds`, and no more than the time left in the run it belongs to (`runtime.maxRunSeconds`,
default 900 seconds, Ruling M20). To run long commands, raise `runtime.maxRunSeconds` to at least `maxCommandSeconds`.

**Limits take effect only at creation**: `cpu` / `memoryMb` / `network` are written into the container and egress proxy at `create`
(the network and host list of `create` are recorded in the container labels); a change of network, the host list included, goes through
`update` (above), which the kernel calls on the next use. `diskMb` is written into the workspace volume at `createFileSystem`. Any other
change (cpu, memory) affects only instances created afterwards; an existing instance (including one resumed after hibernation) keeps its limits until it is destroyed and recreated (destroyed for inactivity, then
recreated on the next use with the same files); the volume size stays for the life of the device. Likewise an existing file system keeps the volume driver and size it was
created with: a workspace volume made before `volumeDriver` was configured stays on the local driver with no size limit, and changing `volumeDriver` or `diskMb`
reaches only file systems created afterwards (a new device, or resetting the device's files).

## Network and egress

The kernel passes the device's effective sandbox network in `limits.network` (the limits carry no mode: the container is the
sandbox, see "Permission profiles"). The plugin maps it to the egress proxy's mode; every instance uses the same container profile:

| `limits.network` | Proxy mode | Reaches |
|---|---|---|
| `{ kind: "open-public" }` (the shipped default) | `open-public` | any **public** host on any port |
| `{ kind: "allowlist", hosts }` | `allowlist` | only `hosts`, on any port |
| `{ kind: "allowlist", hosts: [] }` (the kill switch) | none (`NetworkMode: none`) | nothing |

Limits without `limits.network` (a kernel that predates it) give the sandbox **no network at all** (the safe direction, never the open
public network). This plugin version goes together with the approval-only profiles core release (support v2, limits without `mode`).

- **Every instance with a non-empty network is proxied**: the sandbox joins only an `Internal` internal network, on which there is only its egress proxy; the
  proxy's other leg joins the shared network. A direct connection that bypasses the proxy does not work (the internal network has no
  exit; Docker's built-in DNS does not resolve external names for it either, verified on Docker 29). The proxy
  (`egress-proxy/proxy.mjs`, dependency-free Node) gets `MODE` from the plugin:
  - `open-public` (`MODE=open-public`, no host list, `SOCKS_PORT=1080`): any **public** host on any port.
  - `allowlist` (`MODE=allowlist`, `ALLOW_HOSTS`, `SOCKS_PORT=1080`): only the listed hosts, on any port. An empty list is the
    platform's kill switch: no internal network or proxy is created and the container gets `NetworkMode: none` (loopback only).
  - Both modes open an HTTP proxy (`HTTP_PROXY` / `HTTPS_PROXY` and the lowercase ones, `NO_PROXY` = loopback), `CONNECT` on any
    port, `ALL_PROXY` / `all_proxy` and `GRPC_PROXY` / `grpc_proxy` (`http://<proxy>:3128`), and a **SOCKS5** listener on 1080 with
    the same checks (`GIT_SSH_COMMAND="ssh -o ProxyCommand='nc -X 5 -x <proxy>:1080 %h %p'"`), so `git` over ssh, gRPC and SOCKS- or
    CONNECT-aware clients reach the network (a Postgres or Redis client that knows no proxy does not: tunnel it with `socat`).
  - In `allowlist` a host name matches the list exactly, or `*.example.com` matches any subdomain (**not** `example.com` itself); IP
    literals are refused. In every mode the proxy resolves first, and **every resolved IP** (and every IP literal) must be outside
    the SDK's closed address classes (`CLOSED_CIDRS` in `proxy.mjs`, a copy of plugin-sdk's `OPEN_PUBLIC_DENIED_CIDRS` that
    `test/egress-proxy-classes.test.ts` keeps equal: private 10/8, 172.16/12, 192.168/16, loopback, link-local 169.254/16 and the
    metadata addresses (169.254.169.254, `fd00:ec2::254`, the Azure WireServer `168.63.129.16`, `100.100.100.200`), CGNAT 100.64/10,
    ULA fc00::/7, IPv6 outside 2000::/3, unspecified, multicast, broadcast, the NAT64 prefixes whatever they embed, reserved and
    documentation addresses) and outside the deployment's `deniedCidrs` (which also judge the IPv4 address an IPv4-mapped, SIIT,
    NAT64 or 6to4 address embeds), otherwise it refuses; this blocks DNS rebinding (such as `10.0.0.1.nip.io`); it then connects to
    the address it checked, without resolving a second time, trying the other checked addresses when the first cannot be reached.
  - **Fake-IP resolvers**: when the host's resolver answers a name with an address in `198.18.0.0/15` (a router or local proxy in
    fake-IP mode, such as OpenClash), the proxy resolves the name again through DNS-over-HTTPS (RFC 8484, GET, wire format, A and
    AAAA) at `https://1.1.1.1/dns-query`, `https://1.0.0.1/dns-query`, `https://8.8.8.8/dns-query` and `https://8.8.4.4/dns-query`
    in order, TLS verified against the endpoint's IP certificate, within one 5 s deadline per name shared among the endpoints
    (`FAKE_IP_DNS`, a copy of plugin-sdk's `SANDBOX_FAKE_IP_DNS`). Only that answer is judged and dialled; it is cached per proxy
    for its TTL (at most 300 s, 256 names) when both queries succeeded. When encrypted DNS fails the name is refused with a reason
    naming the fake-IP resolver; the fake address is never dialled. The egress proxy container needs outbound HTTPS to those
    endpoints for this; only the IPv4 range is a signal.
  - **Refusals carry their reason and are reported**: a refusal answers 403 with the reason as its status phrase, in the words
    plugin-sdk's `sandboxProxyRefusalLayer` reads (`REFUSAL_REASONS` in `proxy.mjs`: `host is not on the allow list`, `address is
    a private or reserved address`, `resolved to a private or reserved address`, `malformed host`, the fake-IP case), so a client
    in the sandbox such as the browser daemon tells a closed address from a host off the list. Each command an operation runs gets
    proxy variables with the credentials `capybara:<random tag>` (the proxy authenticates nobody), and the proxy records that
    command's refusals under the tag (at most 64 per command, 256 commands); when the command fails (a non-zero exit, a timeout)
    the provider takes them through the control socket (`node proxy.mjs control refusals`) and returns them in the exec result's
    `network.blocked` with the SDK's layers (`address` for a closed address or a host no allowlist entry can name, which no grant
    lifts; `device` for a host off the list, which the kernel can offer to allow). A command that succeeds, the SOCKS listener and
    device services (no tag) report nothing; an instance whose proxy cannot answer reports nothing.
  - **What is enforced is that address list, nothing more.** The proxy does not know the deployment's own public addresses (a
    load balancer, the kernel's public URL, a corporate range reached over the internet) unless they are listed in `deniedCidrs`; in
    `open-public` mode any other public address is reachable, including the host's own public IP when it has one. Cloud metadata
    services at other addresses (for example a provider-specific public one) are reachable unless listed there too.
  - **No host gateway, no IPv6**: the internal network is created with `com.docker.network.bridge.inhibit_ipv4: "true"` and
    `EnableIPv6: false`, so the Docker host has no address on it and the sandbox cannot reach services the host listens on
    (`0.0.0.0` included) directly, over TCP or UDP; the egress proxy is reached on the bridge itself. This needs **Docker Engine 25
    or newer**: the first instance created checks `/version` and refuses an older engine with an English error. An instance whose
    internal network was made by an earlier plugin version answers `gone` on resume (and `recreate` on `update`), so the kernel
    recreates it, files kept, on a hardened network. `test/permission-scopes.test.ts` proves it against a service on the host
    network (TCP and UDP to the internal network's first address, the host's address and the shared network's gateway).
  - **The Docker host's own addresses**: when the Docker endpoint is local (a UNIX socket or a loopback address), the plugin adds
    this machine's non-loopback interface addresses to the egress proxy's denied ranges, so a public address of the host is closed
    in open-public mode too. With a **remote** Docker host (the usual socket-proxy container on another machine), the plugin cannot
    know that host's addresses: list them in `deniedCidrs`.
  - **DNS**: Docker's embedded resolver on an internal network does not resolve external names (it answers SERVFAIL), and direct
    UDP to an outside resolver has no route, so DNS is no side channel out of the sandbox; names are resolved only by the egress
    proxy. `test/permission-scopes.test.ts` probes it under the allowlist.
  - **In-place list changes**: every proxy this version creates has a **control socket** at `/run/egress/control.sock` (a tmpfs
    mounted only in the proxy, `uid=1000`, `mode=0700`; the socket itself `0600`), which only processes in the proxy container
    reach: the sandbox reaches the proxy only on TCP 3128 / 1080 over the internal network, so it cannot change its own list. The
    proxy keeps the list in force on the instance's config volume (`/config/allow.json`); at start that file wins over `MODE` /
    `ALLOW_HOSTS`, and an unreadable or invalid file stops the proxy rather than falling back to the create-time list. The denied
    ranges of the file join `DENIED_CIDRS` (they only ever add up until the next change). Every admitted connection is registered
    from the moment its request names a host (before name resolution) until its client side closes; a change closes each entry
    the new list does not cover (`*.example.com` judged by the same matching as admission), and an entry still resolving or
    connecting re-checks the list in force before it is spliced. The sandbox container labels keep the create-time list; the
    list in force is the proxy's (the permission operations read it through `control status`).
    Every apply carries the kernel's fence token (the device's fencing generation as the calling
    holder last committed it, core design `2026-11-23-device-update-fencing-design.md`): the proxy
    stores the highest token with the list (`{ mode, hosts, deniedCidrs, digest, fence }`, one
    file, one rename) and refuses a lower one inside its serialized apply, so the check and the
    swap are one step and a replica that lost its lease unnoticed never lands an older list after a
    newer holder's. Without a file the proxy starts with `FENCE` (the create-time token); a file
    without a valid token stops the proxy like any unreadable file. A proxy
    whose saved list cannot be read stops; `resume` then answers `gone` and the kernel recreates
    the instance. The control is given only when the egress image carries the label
    `dev.capybara.sandbox.egress-control=2` (the published image does): instances made with an
    older own build of `egressProxyImage` get no control and recreate on every allowlist change. The
    `deniedCidrs` setting reaches a running proxy only with a host list change (and never an
    open-public proxy); otherwise it applies to proxies created afterwards.
- `/dev/shm`, PidsLimit 1024, the read-only root file system, uid 1000, `CapDrop: ALL` and `no-new-privileges` are the same for every
  instance.

**What the allowlist guards against and what it does not**: it blocks the address list above (private ranges, the metadata address, `deniedCidrs`), and also hosts outside the allowlist; but it **cannot stop data being sent to a host
on the allowlist**: `git push` to github.com, publishing to npm / PyPI, and uploading to GitHub APIs other than the raw / release addresses
are all within the allowlist. The proxy sees only the host name and destination IP, not the request content. Attachments in a conversation and data the agent has read can all leak this way.
For orgs that handle sensitive data: in the org settings set `sandboxToolPolicy` to `ask` (execute, write and deliver need approval), and / or set the sandbox network
`sandboxEgress` to `none`; at the deployment level you can also narrow `sandbox.limits.allowHosts`, or set this plugin's
`refuseOpenNetwork` to `true`.

**Device network**: at `create` (and `update`) the kernel passes the device's effective sandbox network to the plugin, which never
reads org or device settings. The platform and org ceilings, the org default and the device's own choice (its owner or an org admin
switch it between open and the allowlist; a device host list only narrows the org's) decide it; a new allowlist host needs a change
of the device's list (a host cannot be granted per call, the egress proxy covers the whole instance); a host list change reaches a
running instance in place at its next use (`update`), without a restart. `refuseOpenNetwork` lets a
deployment refuse the open network outright (support then reports `openPublic: false`).

## Device services and streams

`ensureService` / `stopService` / `serviceStatus` / `serviceRequest` / `openStream` (core's browser use design §5–6): one long-lived
named process per device, started on an extension's behalf after the kernel's command review, reached only through the provider.
Services are keyed by their id `<extension>.<name>` (the kernel namespaces every name, core#817).

- **Isolation (plugins#210)**: the manager, every service and the socket relay run as the image's `capybara-svc` user (uid / gid
  1100), never as the sandbox user agent commands run as. Its state root `/var/lib/capybara/svc` and run root `/run/capybara-svc`
  are that user's, 0700, so an agent command can neither read a service's state (a browser profile with its cookies), nor reach
  its socket, nor signal or inspect its process (`/proc/<pid>/environ`, `cwd`); `test/services.test.ts` proves each. The service
  writes only its own directories and `/workspace/downloads`, which the provider makes (as the sandbox user, mode 2777, setgid) so
  what it saves stays the agent's group; any user in the device can write that directory, so a service saves there only into files
  it creates exclusively and checks (the browser does). Its environment drops every variable naming a workspace path (the agent's
  caches) and gets its own `HOME`, XDG directories and `TMPDIR`. Every service of a device shares that one user: services are not
  isolated from each other (extensions are full trust; one service is declared today).
- **Upgrade**: an instance made before isolated services (no `dev.capybara.sandbox.services=2` label) answers `gone` on resume,
  so the kernel recreates it on the same files and the current image, ending its old services; a running one that a start finds
  without the service user gets its old services (the sandbox user's) killed and the "predates" answer.
- **Browser (plugins#209)**: the image ships the browser plugin's Chromium (Playwright's full build, pinned to its
  playwright-core: `tools/checks/test/browser-pin.test.ts`) in `/opt/capybara-browsers`, root-owned and read only; services get it
  as `PLAYWRIGHT_BROWSERS_PATH`, so no service runs a browser it or an agent command could replace (an image pinned to another
  revision still serves its own, read only; without one the browser refuses to start). About 412 MB unpacked
  (linux arm64), +0.43 GB on the image; the first launch in a device takes about 0.2 s (nothing is downloaded).

- **Process**: the provider runs its service manager (`src/services.ts`, `python3 -I`, standard library, shared byte for byte with
  device-e2b) in the container as `capybara-svc`. `ensure` takes the service's lock, keeps a running service as it is (an
  `ifRunning` ensure never starts anything and leaves a stopped container stopped), writes the spec's files into the state
  directory, then forks `node <stateDir>/<entry> <args>` (`/usr/local/bin/node`) into its own session with the state directory as
  its working directory, and answers once the service listens on its socket (or reports its exit with the tail of its log). The
  process outlives the exec that started it (Docker reparents it to the container's init) and is not one of the exec commands:
  `killAll` / `killTagged` leave it alone. Nothing restarts a service that exited: the kernel's next ensure does, reviewed again.
- **State directory**: `/var/lib/capybara/svc/<id>` on the device's own volume `<name>-services` (the pre-isolation
  `<name>-svc`, the sandbox user's, is removed at the next `create` and with the file system), created and removed with the
  workspace volume (so a files reset or device deletion removes it; a `<name>-svc` volume left from a lost file system of the
  same name is removed when `createFileSystem` has to make the workspace volume anew) and **outside the workspace**: no project root, Glob / Grep,
  share or delivery reaches a service's state (a browser profile's cookies). The image makes `/var/lib/capybara/svc` `capybara-svc`'s
  (0700) and Docker copies that owner onto the empty volume at its first mount. An instance of an image from before isolated
  device services has no `capybara-svc` user: `ensureService` refuses ("This device's image predates isolated device services
  …"; a status or stop answers stopped): the device page has no action that recreates only
  the instance, so the answer names the ways it happens (the instance recreated after a period without use, or the device deleted
  and created again). A recreate on the current image over the same files restores it: the volume is still empty, so Docker
  copies the image directory's owner onto it. Files are written without following links and only into regular files: every directory
  is opened `O_NOFOLLOW` below the state root and every file `O_NOFOLLOW | O_NONBLOCK` relative to its directory, then checked to be
  a regular file, so a link or a FIFO planted there (by the service itself) fails the ensure at
  once instead of redirecting or blocking the write. The service's code stays in its state directory (no separate `codeDir`; agent commands cannot
  reach it, and a start re-hashes the files against their digest, so a service that changed its own code gets the files again); files a newer version no longer ships stay
  there until the service removes them or the device's files are reset.
- **Disk**: with `volumeDriver` set, `<name>-services` is made with the same driver and `DriverOpts.size` of `min(diskMb, 2048)` MB,
  so a service (a browser's profile, cache and downloaded Chromium) cannot fill the host's disk; a file system made before it
  gets the sized volume at its next `create`. Without `volumeDriver` the volume is a local one with no size limit, like the
  workspace's.
- **Operation roots**: `/var/lib/capybara/svc` and `/run/capybara-svc` are refused as read and write roots of an operation
  (`protectedRoot`), so no reviewed command scope names a service's state or socket.
- **Runtime files**: `/run/capybara-svc/<id>/` (0700): `pid` (pid, process start time, boot id, `startedAt`), `sock` (the
  socket, `CAPYBARA_SERVICE_SOCKET`), `lock`, `log`, `tmp/` (`TMPDIR`). `/run/capybara-svc` is a tmpfs owned by `capybara-svc`, so a stop, a suspension, a restart fallback or a recreate
  wipes them; a pid record also counts only while its process runs with the recorded start time, so it never claims a dead or
  reused pid.
- **Environment**: the instance's (with its egress proxy variables `HTTP_PROXY` / `HTTPS_PROXY` = `http://<proxy>:3128`, so a
  browser's `--proxy-server` goes through the proxy), `PATH=/usr/local/bin:/usr/bin:/bin`, the spec's `env`,
  `CAPYBARA_SERVICE_SOCKET` and `CAPYBARA_SERVICE_STATE`.
- **Files, digest first**: a start sends the files' digest (sha256 over the files in path order: path, NUL, byte length, NUL,
  bytes) and their paths, never the files; the manager starts from the files in the state directory when its `.files-digest`
  record matches and the files there still hash to it, and otherwise answers "files needed", after which the provider sends the
  files (checked against the digest, written, the record replaced by a temp file and rename). A restart of an unchanged service
  therefore moves no file bytes. The service's environment also names the device's workspace root
  (`CAPYBARA_SERVICE_WORKSPACE=/workspace`).
- **Network changes**: the egress proxy enforces the device's allowlist live (an in-place apply swaps the list and closes every
  connection the new list does not cover; a change of kind recreates the container, and the service with it), so an `ifRunning`
  ensure after an allowlist change has nothing to re-apply.
- **Suspend / destroy**: `docker stop` and the container's removal end the service with every process.
- **Requests and streams**: an exec of the socket relay, run inline (`node --input-type=module -e <SOCKET_RELAY_SOURCE> <socket>`,
  so every instance has it whatever image it was made from), with stdin attached: the relay connects to the socket, says `ready`
  on stderr, then copies bytes both ways; the framed service protocol (`encodeServiceMessage`) rides the exec's stdin and its
  demultiplexed stdout. A failed connect is "not running". The relay exits when either side closes (closing the stream closes the
  exec's connection, which ends the relay's stdin). A request opens one relay per call. Unread messages are bounded: above 8 MiB
  queued the exec's connection is paused (resumed at half); `stopService` also kills any relay left connected to the service.
- **Residual**: the service runs as the sandbox user, like every command in the device, so a command can stop it, read its state
  directory or replace its socket; the device is one trust domain.
- **Residual (relay)**: a relay lives as long as its exec's connection. A kernel replica that dies mid-stream closes that
  connection with its process, Docker ends the relay's stdin and the relay exits; there is no idle timeout of its own (a
  keepalive would have to pass through the service protocol), so a connection held open by a hung, still-living replica keeps
  its relay until `stopService` or a suspension.

## Permission profiles (operation contract)

The provider implements the optional operation half of `device-provider@1` (core spec
`2026-11-16-permission-operation-contract.md`): `permissionSupport`, `operation`, `browse`,
`prepare`, `revokeOperation` and `background`. Every call carries an immutable scope the kernel
resolved; the provider copies and freezes it (`parseSandboxOperationScope`) and decides nothing
itself.

**The instance is the sandbox** (core `2026-11-19-approval-only-profiles-design.md`, decision 1):
the container, with its unchanged hardening (`CapDrop: ALL`, `no-new-privileges`, read-only root,
uid 1000, Docker's default seccomp), is the boundary; its whole filesystem is every operation's
scope and its egress proxy is the sandbox network. All three profiles are offered and differ only
in who approves sensitive commands; nothing about the instance changes per profile. There are no
directory crossings, no running outside the sandbox and no per-call host grants.

- **Support report** (version 2): `permissionSupport` answers `{ version: 2, boundary:
  "instance", restricted: null, network: { openPublic, allowlist: true, perOperationHosts: false },
  outsideSandbox: false, background: true }`, with `openPublic: false` where `refuseOpenNetwork` is
  set. It checks the staged runtime (owner, mode, digest) in the running instance (it never starts
  or resumes one); an image without the runtime, or with different bytes, offers nothing
  (`background: false`, both network kinds false) and names the reason in `unavailableReason`.
- **Runtime** (`image/runtime`, staged root-owned at `/opt/capybara-runtime`, `0755` / `0644`; the
  image build runs `sha256sum -c SHA256SUMS`): the SDK's `SANDBOX_RUNTIME_SOURCE` v2 files
  `native-files.py` and `linux-sandbox.py`, byte for byte, plus this provider's consumer
  `capybara-operation.py` (admission records, the native helper on `/`, background supervision).
  The digests live in `src/runtime-source.ts`; `test/permission-scopes.test.ts` fails when the
  staged bytes, the SDK bundle or `SHA256SUMS` drift. After an SDK upgrade, copy the bundle files
  into `image/runtime`, update `OPERATION_AGENT_SHA256` and regenerate `SHA256SUMS`
  (`runtimeChecksums()`); the agent re-checks the SDK digests and root ownership before native work
  and background starts. The launcher is staged with its bundle but never run: the agent carries no
  restricted launch path (`exec`, `native` and `probe` are unknown commands, and `direct` refuses a
  writable or restricted scoped request with `UNAVAILABLE`).
- **Whole-instance operations**: the kernel's scope on an instance-boundary device is
  `filesystem: scoped` with `/` (and the working root) readable and writable; it runs the ordinary
  exec wrapper and environment after the agent's admission check, and native calls use the helper
  on `/`, under every profile. A refusal by that check is accepted only with the per-call nonce the
  agent removes from its environment before exec, so a command cannot report itself as "not
  executed". The egress proxy applies to the whole container, so an operation must allow at least
  what the instance applies (its container labels): an open-public operation runs on any instance,
  an allowlist one only where the instance's hosts are all in its list (or the instance has no
  network), a `none` one only on an instance without network. A narrower operation is refused with
  `SandboxScopeDeniedError` before any effect, never silently widened.
- **Refused before any effect** (`SandboxPermissionUnsupportedError`, never widened): the escalated
  pair (`filesystem: device` with the `environment` network: an instance has no outside) and any
  filesystem grant narrower than the whole instance (it would need restricted filters).
- **Records** live in `/skills/.capybara-ops` on the device's persistent skills volume, written only
  by root through the root-only writable mount (`/opt/capybara/skills`, `0711` directories, `0600`
  records): the sandbox user cannot create, list or change them, and they survive instance restarts.
  Admission: before any effect, a root step records `(instance generation, operation ID)` with the
  method and input digest. A retry of a consumed foreground operation with the same input is
  `SandboxOperationOutcomeUnknownError` (also after an instance restart), another method or input
  under the same ID `SandboxScopeValidationError`; a passed `admitBeforeMs` admits nothing. `revokeOperation` writes a
  root-owned tombstone the agent checks right before launching, ends the running foreground and
  background work, then rewrites the tombstone; if the instance restarted meanwhile (a new
  generation, for example the kill's restart fallback) it reports an error so the kernel retries.
- **Background**: per execution a detached **root** recorder owns the record, the output spool and
  the stop claim; the sandbox-user supervisor reaches it only through a root-owned UNIX socket whose
  random name it receives on stdin. The recorder accepts frames only on the one connection whose
  `SO_PEERCRED` pid is the supervisor that identified itself (pid, start time and argv checked) and
  whose identity frame carries a second random token and the digest of the request it runs; root
  recorded the digest of the canonical start request the provider admitted (command, scope, cwd,
  env, limits, output path), and only a match binds the record. The token protects against
  discovery of the channel through `/proc/net/unix`, which lists the socket name; it is not
  unreadable: during `bg-start`'s interpreter start-up, before it turns undumpable, a process of
  the same uid can read the request (token included) from its stdin through `/proc`. With it, the
  real agent binds only a supervisor running exactly the granted request. A start the agent
  refuses (its own supervisor was never accepted, so whatever is bound is not the provider's) is
  aborted: the provider writes the root cancellation marker, stops whatever the record names by its
  recorded identity and marks the reference aborted, so `status` reports it `lost` and no output is
  served under it. The same happens when the `bg-start` exec does not exit 0 with exactly one
  result frame (it was killed, stopped and ended on the provider's signal, failed, or its stdout
  holds anything else): the genuine agent exits 0 only after its own supervisor was accepted. A
  start whose exec exited 0 but whose reply was lost stays running, and the same-ID retry returns
  its reference (one launch), unless the recorder marked it contested: a second supervisor
  presented the token and the admitted digest after the bind, so one of them is not genuine; then
  the start, or the retry, aborts it the same way. The supervisor blocks cancellation, reports its
  pid and start time before `start` acknowledges, re-checks the tombstone after that and before
  launching, installs its handlers, then launches (children additionally run under
  `timeout -s KILL`). It keeps the starting grant, appends merged output to the spool (for `tail`
  and `readOutput`, at most 65,536 bytes per read) and to `outputPath` (opened inside the scope
  through the pinned roots). A retried `start` returns the same reference without launching again.
  `status` / `tail` / `readOutput` / `stop` never start a stopped instance (its work is `lost`);
  `stop` signals exactly the recorded supervisor (pidfd and start time) and claims its outcome once
  (`stopped` or `already-exited`). A stop that finds an execution still `starting` (no supervisor
  reported) claims `lost` and writes a root cancellation marker, so a late supervisor never launches.
  Residual trust (M5, closed only by a separate uid or ptrace-scoped operations, Task 14): the work
  of every conversation shares the device uid, so it can signal (stop, freeze) the sandbox user's
  processes, including supervisors, and intercept a `bg-start`'s request during its start-up. A
  process of that uid can run its own code under the agent's exact argv (it can rewrite its own argv
  in place, no ptrace needed) and bind the record with the stolen token and a matching digest. When
  it kills or stops the genuine `bg-start`, or the real supervisor is refused, the start is aborted
  and the reference reports `lost`. Two cases stay open: a worker crash after such a bind followed by
  the kernel's same-ID retry (the provider never saw the exec end, and the retry returns the
  reference, which then reports the forged process and its output as the task), and a forger that
  ptraces the genuine `bg-start` during start-up (it controls the genuine process, so it can make it
  exit 0). It cannot change the records.
- **Spool storage (operational change)**: retained background output now lives on the device's
  persistent skills volume (not the instance's tmpfs `/tmp`) until `retainUntilMs` plus one hour.
  Each execution's spool is capped at 64 MiB (later output still reaches `outputPath`; the record
  notes `outputTruncated`). Expired records and spools, and records of a previous instance
  generation past their retention, are pruned at every instance start (create, resume, restart
  fallback) and on each operation; plan disk space for the skills volume accordingly.
- **Preparation**: skills only under `/skills`, written by root through the writable skills mount
  on pinned descriptors (files `0644`); attachments only under `/workspace/attachments/<conversation>`,
  as the sandbox user. **Browsing**: `stat` / `list` / `scan` on pinned read roots only.

## Test-only options

The second parameter of `createDockerSandbox(config, testOptions)` can be passed only by code that calls it directly; the plugin config cannot set it:

- `labels`: adds extra labels to all resources (tests clean up by label);
- `egressTestHosts`: the egress proxy pins these host names to the given IPs and exempts them from the private-address check (in `allowlist` mode they must also be on the list),
  so that a local HTTP service in a test can serve as an allowed target. It is passed in through the proxy container's environment variable `CAPYBARA_EGRESS_TEST_HOSTS`.
- `egressTestResolve`: the egress proxy's resolver answers these host names with the given IPs, with no exemption (the answer is
  judged like any resolved address), so a test can allowlist a name that resolves into a closed class. Passed in through
  `CAPYBARA_EGRESS_TEST_RESOLVE`.
- `backgroundLaunchBarrier` (a file a background supervisor waits for after it recorded itself and before its final admission
  check) and `afterRevokeKill` (runs inside `revokeOperation` between the kill and the final tombstone): readiness hooks for the
  start/revoke, start/stop and restart race tests.

## Tests

`test/egress-proxy.test.ts`, `test/egress-proxy-modes.test.ts` (including `168.63.129.16` and `deniedCidrs` / `DENIED_CIDRS`),
`test/manifest.test.ts` (including `refuseOpenNetwork` on resume and auto-start against a stub Docker API) and `test/network.test.ts`
(what each network builds, and when `update` may keep the container) do not need Docker; `test/device-docker.test.ts` and `test/concurrent.test.ts` need Docker (the whole group is skipped without it),
builds the test images once (tagged by the content of their build context, shared by the test files and kept for later runs; remove old `capybara-sandbox*:test-*` tags with `docker rmi`), starts the socket proxy, and cleans up by label at the end; the runsc cases run only when the daemon has runsc registered.
`test/permission-scopes.test.ts` runs `runSandboxPermissionConformance` (from `@capybara-hq/testing`) against the actual provider, image and socket proxy, plus the provider's own cases: support v2, the escalated pair and narrower grants refused, every profile on the whole instance, the egress proxy as every operation's network (allowlist and open-public with the closed classes), admission, revocation, background, preparation, browsing and fail-closed images; it logs the kernel, Docker version and image it ran on. `test/instance-boundary.test.ts` (no Docker) checks the support report and the scope rules against a fake transport, and `test/egress-proxy-classes.test.ts` (no Docker) the closed classes against the SDK and the fake-IP DNS-over-HTTPS path (a local HTTPS endpoint with an IP certificate in `test/fixtures`).
Through a real kernel: `test/sandbox-tools.smoke.test.ts` (the kernel's sandbox tools in one process) and `test/sandbox-artifacts.dual.test.ts` (the M5 segment 2 flow across two replicas: attachments, delivery, takeover after a killed replica, idle suspend and resume). The socket proxy starts from `test/sandbox-proxy/haproxy.cfg`, an exact copy of capybara-hq/core's [`docker/sandbox-proxy/haproxy.cfg`](https://github.com/capybara-hq/core/tree/main/docker/sandbox-proxy/haproxy.cfg). Nothing in this repository compares them; core's `check:bootstrap --network` (rule `bootstrap-haproxy`) will check the copy against the commit core pins.

## Icon

`icon.svg`: the Docker mark (owner: Docker, Inc.), downloaded on 2026-11-08 from Docker media resources,
https://www.docker.com/company/newsroom/media-resources/ (Docker-Logos-1.zip,
docker-mark-ocean-blue.svg). It is a trademark of its owner, used only to identify the service this
plugin connects to; the plugin is not affiliated with or endorsed by the owner. The artwork is
unchanged except for removing editor metadata and setting a square viewBox.
