# @capybara-hq/plugin-sandbox-docker

The Docker implementation of the conversation sandbox (`sandbox@1`): one container per conversation (`cap-<conversation id>`), with a runtime of either runc or gVisor's runsc.
The plugin **reaches Docker only through the endpoint** (the socket proxy in `docker/sandbox-proxy`) and does not mount `docker.sock` itself.

## Deployment config

| Key | Default | Description |
|---|---|---|
| `endpoint` | (required) | Socket proxy address: `tcp://sandbox-proxy:2375` or `unix:///path` |
| `runtime` | `runc` | `runc` or `runsc` (runsc must be registered in the Docker daemon first) |
| `network` | `capybara-sandbox` | Name of the shared sandbox network; it must start with `cap` (the socket proxy only allows such networks); if it does not exist the plugin creates it as a bridge with `enable_icc=false` (containers cannot reach each other) |
| `egressProxyImage` | `capybara-sandbox-egress:latest` | Egress proxy image (`egress-proxy/Dockerfile`) |
| `volumeDriver` | (unset, uses local) | Driver for the workspace volume; when set, `DriverOpts.size=<diskMb>M` is passed |
| `allowOpenEgress` | `false` | Allow `sandbox.limits.egress = "open"`; when false, `create` fails immediately on open (an English error naming `extensionConfig."sandbox-docker".allowOpenEgress`), and the kernel also logs a warn at startup |

```bash
export CAPYBARA_EXTENSION_CONFIG='{"sandbox-docker":{"endpoint":"tcp://127.0.0.1:2375"}}'
```

The deployment config schema is strict: extra keys are errors.

## Images

- The sandbox image `image/Dockerfile` (shared by the Docker plugin and the E2B template). The tag matches the default of the kernel config `sandbox.image`:
  `docker build -t capybara-sandbox:latest plugins/sandbox-docker/image`.
  Debian trixie-slim (pinned by digest), with bash, coreutils, GNU find / grep (the kernel's `sandbox_glob` / `sandbox_grep`
  depend on them), procps, util-linux (`setsid`), curl, git, jq, python3 (with pip / venv) and so on; it runs as the non-root user `sandbox`
  (uid 1000), with HOME and the working directory at `/workspace`.
- The egress proxy image `egress-proxy/Dockerfile`: `docker build -t capybara-sandbox-egress:latest plugins/sandbox-docker/egress-proxy`.
- Multi-arch (amd64 + arm64): `docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/<name>:<tag> --push <directory>`.
- Local development: `docker compose -f docker/compose.dev.yaml --profile sandbox up -d` builds both images and starts the socket proxy
  (`127.0.0.1:2375`, **for local development only**, see the deployment requirements below). If an image is not local the plugin tries to pull it once.
- **In a deployment, pre-pull `sandbox.image` and `egressProxyImage` on every Docker node** (`docker pull …`): if an image is not local
  the plugin pulls it only when a conversation first uses the sandbox, and a pull of several hundred MB eats into the time limit of that tool call (`tools.timeoutMs` plus the lock wait and a 3-minute margin);
  when it is slow that call fails, and the next one tries again.

## Socket proxy (`docker/sandbox-proxy/haproxy.cfg`)

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
| `create` | First deletes any old instance of the same name (the kernel may have exited before recording the handle), then creates the volumes, (for allowlist) the internal network and egress proxy, and the sandbox container, and starts it; the handle id is the name |
| `suspend` | Stops the sandbox container and the egress proxy (files stay on the volumes). **Processes are not preserved**: all background processes in the sandbox end and `/tmp` (tmpfs) is cleared; E2B's pause, in contrast, keeps memory too |
| `resume` | Starts (or unpauses one that was `docker pause`d); if the container does not exist it returns `gone`. If the allowlist's egress proxy or internal network is gone, it is rebuilt from the allowlist recorded in the container labels |
| Auto-start | When `exec` / `readFile` / `writeFile` / `stat` / `killAll` find the container still exists but is not running (Docker returns 409: the host or daemon restarted, the idle sweep stopped the container before it could record `suspended`, someone ran `docker pause` on it…), they recover it the way `resume` does (egress proxy and network in place; unpause a paused one, start a stopped one) and retry once (the `sandbox@1` contract: the kernel trusts only the `running` it recorded itself) |
| `killAll` | Kills every command started through `exec` that is still running (finds the wrapper by command line and sends SIGKILL by process group and session); called when the kernel takes over from a crashed previous lock holder. A process that a command puts in the background in a session of its own (`setsid`) is not guaranteed to be killed |
| `destroy` / `destroyByName` | Deletes the container, egress proxy, internal network and both volumes; a missing one also counts as success |
| `exec` | `docker exec` (sandbox user, bash); on timeout or abort it SIGKILLs the command and all processes it spawned by session. Commands run through `timeout -s KILL <timeout + 5 seconds>`: when a kernel replica crashes (the timer on the plugin side is gone, and a dropped connection does not end the command) the time limit inside the sandbox is the backstop. When the exec used to kill processes cannot itself start (for example the process count has hit its limit), it falls back to restarting the whole container (`restart?t=0`): files are all on the volumes, `/tmp` is cleared, and the remaining processes in the sandbox all end. When output is truncated it backs up to a full UTF-8 character boundary |
| `readFile` / `writeFile` / `stat` | Run small `head` / `stat` scripts in the container as the sandbox user (permissions and symlinks are resolved as the sandbox user, and the volume is not written as root through the daemon) |

Resources for each conversation: the container `<name>`, the egress proxy `<name>-egress`, the internal network `<name>-net`, and the volumes `<name>-workspace`
(`/workspace`) and `<name>-skills` (`/skills`). All carry the labels `dev.capybara.sandbox=1` and `dev.capybara.sandbox.name=<name>`.

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

**Limits take effect only at creation**: the `cpu` / `memoryMb` / `diskMb` / `egress` / `allowHosts` of `sandbox.limits` are written into the container,
volumes and egress proxy (the allowlist is recorded in the container labels); changing the config affects only sandboxes created afterwards; existing sandboxes (including ones resumed after hibernation) keep the
limits from creation until they are destroyed and rebuilt (destroyed for inactivity, or by deleting the `cap-<conversation>` family of resources).

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

`test/egress-proxy.test.ts` does not need Docker; `test/sandbox-docker.test.ts` needs Docker (the whole group is skipped without it),
builds a uniquely tagged test image, starts the socket proxy, and cleans up by label at the end; the runsc cases run only when the daemon has runsc registered.
The kernel's smoke test is at `packages/kernel/test/tools/sandbox/sandbox-docker.smoke.test.ts`.
