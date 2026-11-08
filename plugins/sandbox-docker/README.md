# @capybara-hq/plugin-sandbox-docker

The Docker implementation of the environment sandbox (`sandbox@2`), with a runtime of either runc or gVisor's runsc. Each environment
(`cap-env-<environment id>`) has a **file system**, its two Docker volumes, which lives until the environment is deleted, and an **instance**, the container
(with its egress proxy and internal network), which is suspended when idle, destroyed after long disuse and recreated on the next use with the same files.
The plugin **reaches Docker only through the endpoint** (the socket proxy in capybara-hq/core's [`docker/sandbox-proxy`](https://github.com/capybara-hq/core/tree/main/docker/sandbox-proxy)) and does not mount `docker.sock` itself.

## Deployment config

| Key | Default | Description |
|---|---|---|
| `endpoint` | (required) | Socket proxy address: `tcp://sandbox-proxy:2375` or `unix:///path` |
| `runtime` | `runc` | `runc` or `runsc` (runsc must be registered in the Docker daemon first) |
| `network` | `capybara-sandbox` | Name of the shared sandbox network; it must start with `cap` (the socket proxy only allows such networks); if it does not exist the plugin creates it as a bridge with `enable_icc=false` (containers cannot reach each other) |
| `egressProxyImage` | `ghcr.io/capybara-hq/capybara-sandbox-egress:<plugin version>` | Egress proxy image (`egress-proxy/Dockerfile`); set it to use your own build (the offline route below) |
| `volumeDriver` | (unset, uses local) | Driver for the workspace volume; when set, `DriverOpts.size=<diskMb>M` is passed (at `createFileSystem`) |
| `allowOpenEgress` | `false` | Allow `sandbox.limits.egress = "open"`; when false, `create` fails immediately on open (an English error naming `extensionConfig."sandbox-docker".allowOpenEgress`), and the kernel also logs a warn at startup |

```bash
export CAPYBARA_EXTENSION_CONFIG='{"sandbox-docker":{"endpoint":"tcp://127.0.0.1:2375"}}'
```

The deployment config schema is strict: extra keys are errors.

## Images

Both images are published by this repository's image workflow, multi-arch (amd64 + arm64), tagged with this plugin's version:

| Image | Used for |
|---|---|
| `ghcr.io/capybara-hq/capybara-sandbox:<plugin version>` | `create` without `image` (the kernel passes an `image` only when the kernel config `sandbox.image` or the environment pins one) |
| `ghcr.io/capybara-hq/capybara-sandbox-egress:<plugin version>` | the egress proxy, unless `egressProxyImage` is set |

The version is the extension manifest's `version` (`src/index.ts`, kept equal to `package.json` by `capybara-plugin sync-versions`), so a
plugin upgrade moves both images with it and the kernel never needs to know the plugin's version.

- The sandbox image `image/Dockerfile` (shared by the Docker plugin and the E2B template).
  Debian trixie-slim (pinned by digest), with bash, coreutils, GNU find / grep (the kernel's `Glob` / `Grep`
  depend on them), procps, util-linux (`setsid`), curl, git, jq, python3 (with pip / venv) and so on; it runs as the non-root user `sandbox`
  (uid 1000), with HOME and the working directory at `/workspace`.
- The egress proxy image `egress-proxy/Dockerfile`.
- **Offline route** (a deployment without access to ghcr.io): build both images yourself
  (`docker build -t capybara-sandbox:local plugins/sandbox-docker/image`,
  `docker build -t capybara-sandbox-egress:local plugins/sandbox-docker/egress-proxy`, or
  `docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/<name>:<tag> --push <directory>` for a private registry), then set the kernel config
  `sandbox.image` to the sandbox image and this plugin's `egressProxyImage` to the egress image.
- Local development: in a [capybara-hq/core](https://github.com/capybara-hq/core) checkout, `docker compose -f docker/compose.dev.yaml --profile sandbox up -d` ([`docker/compose.dev.yaml`](https://github.com/capybara-hq/core/blob/main/docker/compose.dev.yaml)) builds both images and starts the socket proxy
  (`127.0.0.1:2375`, **for local development only**, see the deployment requirements below). If an image is not local the plugin tries to pull it once.
- **In a deployment, pre-pull both images on every Docker node** (`docker pull …`): if an image is not local
  the plugin pulls it only when an environment's instance is first created, and a pull of several hundred MB eats into the time limit of that tool call (`tools.timeoutMs` plus the lock wait and a 3-minute margin);
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
To let the local kernel connect, the dev compose publishes it on `127.0.0.1:2375`: use that for local development only, and do not turn on `allowOpenEgress`.

## Lifecycle

| Operation | What it does |
|---|---|
| `createFileSystem` | Creates the volumes `<name>-workspace` (with the `volumeDriver` size option) and `<name>-skills`, labelled `dev.capybara.sandbox.role=workspace` / `skills`; a volume that already exists is kept as it is (idempotent by name, never replaced); the handle id is the name |
| `destroyFileSystem` / `destroyFileSystemByName` | Force-removes the instance of the same name first (Docker refuses to remove a volume a container still uses, even a stopped one), then removes both volumes; a missing one counts as success. The kernel's one-off cleanup calls `destroyFileSystemByName("cap-<conversation id>")` for `sandbox@1` sandboxes, whose volumes `cap-<conversation id>-workspace` / `-skills` follow the same naming |
| `create` | Checks that both volumes of the file system exist and carry their role label (`GET /volumes/<name>`); otherwise it throws `FileSystemGoneError`, because Docker would silently create empty volumes for a missing mount source. Then deletes any old instance of the same name (the kernel may have exited before recording the handle; its volumes are kept), creates (for allowlist) the internal network and egress proxy and the sandbox container, checks the volumes again (if they were removed in between, Docker made empty unlabelled ones for the mounts: the container and those volumes are removed and `create` throws `FileSystemGoneError`) and starts it; the handle id is the name. Without `image` it uses the published sandbox image |
| `suspend` | Stops the sandbox container and the egress proxy (files stay on the volumes). **Processes are not preserved**: all background processes in the sandbox end and `/tmp` (tmpfs) is cleared; E2B's pause, in contrast, keeps memory too |
| `resume` | Starts (or unpauses one that was `docker pause`d); if the container does not exist it returns `gone`. If the allowlist's egress proxy or internal network is gone, it is rebuilt from the allowlist recorded in the container labels |
| Auto-start | When `exec` / `readFile` / `writeFile` / `stat` / `killAll` find the container still exists but is not running (Docker returns 409: the host or daemon restarted, the idle sweep stopped the container before it could record `suspended`, someone ran `docker pause` on it…), they recover it the way `resume` does (egress proxy and network in place; unpause a paused one, start a stopped one) and retry once (the `sandbox@2` contract: the kernel trusts only the `running` it recorded itself) |
| `killAll` | Kills every command started through `exec` that is still running (finds the wrapper by command line and sends SIGKILL by process group and session); called when the kernel takes over from a crashed previous lock holder. A process that a command puts in the background in a session of its own (`setsid`) is not guaranteed to be killed |
| Concurrent use (`concurrentExec`, `killTagged`) | Declares `concurrentExec: true`: the sessions of one environment (and their sub-agents) run commands and file operations in its sandbox at the same time (independent `docker exec` instances; the socket proxy rules are unchanged). Each exec's control file carries the holder's tag (`/tmp/.capybara-exec-<tag>-<uuid>`, tags checked against `SANDBOX_TAG_RE`); `killTagged` kills only the commands of the given tags (a variant of the `killAll` script), used when the kernel takes over from a crashed holder while others keep running. Concurrent auto-starts of a stopped container are idempotent (`start` answers 304; a concurrent egress proxy create answers 409, tolerated). Concurrent commands share the container's `PidsLimit` (1024) and memory. When the kill exec itself cannot start, the container restarts, which also ends live siblings' commands (a last resort) |
| `destroy` / `destroyByName` | Deletes the instance: the container, egress proxy and internal network, **never the volumes**; a missing one also counts as success |
| `exec` | `docker exec` (sandbox user, bash); the `actor` argument is not used (phase 1); on timeout or abort it SIGKILLs the command and all processes it spawned by session. Commands run through `timeout -s KILL <timeout + 5 seconds>`: when a kernel replica crashes (the timer on the plugin side is gone, and a dropped connection does not end the command) the time limit inside the sandbox is the backstop. When the exec used to kill processes cannot itself start (for example the process count has hit its limit), it falls back to restarting the whole container (`restart?t=0`): files are all on the volumes, `/tmp` is cleared, and the remaining processes in the sandbox all end. When output is truncated it backs up to a full UTF-8 character boundary |
| `readFile` / `writeFile` / `stat` | Run small `head` / `stat` scripts in the container as the sandbox user (permissions and symlinks are resolved as the sandbox user, and the volume is not written as root through the daemon) |

Resources for each environment (`<name>` = `cap-env-<environment id>`): the instance is the container `<name>`, the egress proxy `<name>-egress` and the
internal network `<name>-net`; the file system is the volumes `<name>-workspace` (`/workspace`) and `<name>-skills` (`/skills`). All carry the labels
`dev.capybara.sandbox=1`, `dev.capybara.sandbox.name=<name>` and `dev.capybara.sandbox.role=<role>`.

## Isolation and limits

- Commands and file operations run as non-root (uid 1000); the container's main processes (`Init`'s tini and `sleep infinity`) run as root
  (`User: 0:0`, with all capabilities dropped too): the sandbox user cannot signal them, and `kill 1`, `pkill sleep` and `kill -9 -1` cannot stop
  the container. Every exec specifies the user explicitly; a manual `docker exec` without `-u` runs as root (with no capabilities).
- `CapDrop: ALL`, `no-new-privileges`, a read-only root filesystem, `Init` (reaps zombie processes), `PidsLimit` 1024, private IPC.
- cpu → `NanoCpus`; memory → `Memory` (`MemorySwap` the same value, so no swap is used).
- `/tmp` is tmpfs (`nosuid,nodev`), sized at half the memory and no more than `diskMb`, and counts against the memory quota; it is cleared after suspension.
- `/skills` is **mounted read-only**; the same volume is also mounted writable at `/opt/capybara/skills` (`/opt/capybara` is owned by root, 0700,
  so the sandbox user cannot enter it, nor get in through a symlink), and the plugin's `writeFile("/skills/…")` writes through it as root inside the container.
- **Disk**: the root filesystem is read-only, and all writes land on the workspace volume and `/tmp`. `--storage-opt size` limits only the container's writable layer,
  which is meaningless for a read-only root filesystem, so it is not used. The workspace volume size takes effect only when `volumeDriver` is set and that driver supports the `size` option;
  **the default local driver does not limit volume size** (`diskMb` has no effect). When you need a hard limit, use a volume driver that supports quotas, or configure an XFS project quota and the like
  on the Docker volume directory on the host.

**Command time limit**: a single command runs at most `sandbox.limits.maxCommandSeconds`, and no more than the time left in the run it belongs to (`runtime.maxRunSeconds`,
default 900 seconds, Ruling M20). To run long commands, raise `runtime.maxRunSeconds` to at least `maxCommandSeconds`.

**Limits take effect only at creation**: `cpu` / `memoryMb` / `egress` / `allowHosts` are written into the container and egress proxy at `create`
(the allowlist is recorded in the container labels), `diskMb` into the workspace volume at `createFileSystem`. Changing the config affects only instances created
afterwards; an existing instance (including one resumed after hibernation) keeps its limits until it is destroyed and recreated (destroyed for inactivity, then
recreated on the next use with the same files); the volume size stays for the life of the environment. Likewise an existing file system keeps the volume driver and size it was
created with: a workspace volume made before `volumeDriver` was configured stays on the local driver with no size limit, and changing `volumeDriver` or `diskMb`
reaches only file systems created afterwards (a new environment, or resetting the environment's files).

## Egress (`limits.egress`)

- `none`: `NetworkMode: none`, loopback only.
- `open`: attached to the shared network `network` (an ordinary bridge), and **can reach everything the host network can reach**: services listening on the host (on Docker
  Desktop it reaches the host loopback through `host.docker.internal`, so a socket proxy published on 127.0.0.1 can also be reached by it), the intranet, and
  the cloud metadata address. The deployment config `allowOpenEgress` must be turned on explicitly (off by default); use it only in trusted environments.
- `allowlist` (default): the sandbox joins only an `Internal` internal network, on which there is only its egress proxy; the proxy's other leg joins the shared network.
  `HTTP_PROXY` / `HTTPS_PROXY` (and the lowercase ones) are already set, and `NO_PROXY` is loopback. The proxy (`egress-proxy/proxy.mjs`, dependency-free Node):
  - A host name matches `allowHosts` exactly, or `*.example.com` matches any subdomain (**not** `example.com` itself); IP literals are never allowed;
  - It resolves first, and **every resolved IP** must not be a private, loopback, link-local (including 169.254.169.254), CGNAT (100.64/10), ULA
    (fc00::/7), unspecified, multicast, reserved or documentation address (IPv4-mapped / NAT64 / 6to4 are judged by the embedded IPv4), otherwise 403; this blocks
    DNS rebinding (such as `10.0.0.1.nip.io`); it then connects directly to the IP it checked, without resolving a second time;
  - HTTPS goes through CONNECT (only ports 443 and 80 are allowed; the proxy container's environment variable `ALLOW_CONNECT_PORTS` can change this), and HTTP is forwarded by absolute URL;
    when the first address cannot be reached it tries the other checked addresses in turn; a direct connection that bypasses the proxy does not work (the internal network has no exit).
  - The internal network has no default route, and Docker's built-in DNS does not resolve external domains for it either (verified on Docker 29); protocols that do not go through the HTTP proxy
    (ssh, git://) are unavailable.
  - Known limitation: on Linux hosts with older Docker, a container in the internal network may be able to reach services the host listens on at that bridge address;
    do not have host services listen on 0.0.0.0, or use a firewall to block inbound traffic from the sandbox subnet.

**What the allowlist guards against and what it does not**: it blocks the intranet, the host and the cloud metadata address, and also hosts outside the allowlist; but it **cannot stop data being sent to a host
on the allowlist**: `git push` to github.com, publishing to npm / PyPI, and uploading to GitHub APIs other than the raw / release addresses
are all within the allowlist. The proxy sees only the host name and destination IP, not the request content. Attachments in a conversation and data the agent has read can all leak this way.
For orgs that handle sensitive data: in the org settings set `sandboxToolPolicy` to `ask` (execute, write and deliver need approval), and / or set the sandbox network
`sandboxEgress` to `none`; at the deployment level you can also narrow `sandbox.limits.allowHosts`.

**Org-level egress** (org setting `sandboxEgress`, Ruling M19): an org can swap in its own allowlist (replacing the deployment's list) or cut the network; at
`create` the kernel passes the org's effective `egress` / `allowHosts` to the plugin; an org cannot set `open`, and when the deployment is `none` the org can only be `none` too.

## Test-only options

The second parameter of `createDockerSandbox(config, testOptions)` can be passed only by code that calls it directly; the plugin config cannot set it:

- `labels`: adds extra labels to all resources (tests clean up by label);
- `egressTestHosts`: the egress proxy pins these host names to the given IPs and exempts them from the private-address check (they still must be on the allowlist),
  so that a local HTTP service in a test can serve as an allowed target. It is passed in through the proxy container's environment variable `CAPYBARA_EGRESS_TEST_HOSTS`.

## Tests

`test/egress-proxy.test.ts` and `test/manifest.test.ts` do not need Docker; `test/sandbox-docker.test.ts` and `test/concurrent.test.ts` need Docker (the whole group is skipped without it),
builds a uniquely tagged test image, starts the socket proxy, and cleans up by label at the end; the runsc cases run only when the daemon has runsc registered.
Through a real kernel: `test/sandbox-tools.smoke.test.ts` (the kernel's sandbox tools in one process) and `test/sandbox-artifacts.dual.test.ts` (the M5 segment 2 flow across two replicas: attachments, delivery, takeover after a killed replica, idle suspend and resume). The socket proxy starts from `test/sandbox-proxy/haproxy.cfg`, an exact copy of capybara-hq/core's [`docker/sandbox-proxy/haproxy.cfg`](https://github.com/capybara-hq/core/tree/main/docker/sandbox-proxy/haproxy.cfg). Nothing in this repository compares them; core's `check:bootstrap --network` (rule `bootstrap-haproxy`) will check the copy against the commit core pins.

## Icon

`icon.svg`: the Docker mark (owner: Docker, Inc.), downloaded on 2026-11-08 from Docker media resources,
https://www.docker.com/company/newsroom/media-resources/ (Docker-Logos-1.zip,
docker-mark-ocean-blue.svg). It is a trademark of its owner, used only to identify the service this
plugin connects to; the plugin is not affiliated with or endorsed by the owner. The artwork is
unchanged except for removing editor metadata and setting a square viewBox.
