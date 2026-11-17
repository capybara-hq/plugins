# @capybara-hq/plugin-sandbox-e2b

The E2B implementation of devices (`sandbox@2`): one E2B sandbox per device (E2B cloud or self-hosted E2B). E2B has no volume
separate from a micro-VM, so the device's file system **is** the E2B sandbox kept paused without memory, and an instance is the same sandbox
resumed through connect. It is an either-or choice with `@capybara-hq/plugin-sandbox-docker` (`sandbox@2` is a single-select capability), and uses the
same image.

## Deployment config

| Key | Default | Description |
|---|---|---|
| `apiKey` | (required, secret) | E2B API key (`e2b_…`) |
| `template` | (empty) | Template name or id. Empty: the plugin builds the template `capybara-sandbox-<tag>` from the published image on first use (see "Template") |
| `apiUrl` | `https://api.<domain>` | Control plane API address; for self-hosted E2B, use your own address |
| `domain` | `e2b.app` | Sandbox domain: the envd address is `https://49983-<sandbox id>.<domain>`; when the API returns the sandbox's own `domain`, the returned one wins |
| `timeoutSeconds` | `3600` | Sandbox timeout (60–86400 seconds); when it expires E2B **auto-pauses** (does not delete), see "Lifecycle" |
| `domainAllowlist` | `true` | Whether E2B supports a per-domain network allowlist; set `false` for self-hosted versions that do not, and an allowlist degrades to no network with a warning |
| (removed) `openEgress` / `allowOpenEgress` | — | Both fail the strict schema with a pointer to the network policy: the org's cloud network (`limits.network`) decides (see "Network policy") |

```bash
export CAPYBARA_EXTENSIONS='["@capybara-hq/plugin-sandbox-e2b"]'
export CAPYBARA_EXTENSION_CONFIG='{"sandbox-e2b":{"apiKey":"e2b_…"}}'
```

The deployment config schema is strict: extra keys are errors. The kernel config `sandbox.image` has no effect on this plugin: `sandbox@2` passes
the image only to `create`, but on E2B the image is fixed when the file system (the E2B sandbox) is created, from the template.

## Template (the same image as the Docker plugin)

**Built for you (default).** With `template` empty, the first `createFileSystem` of a provider instance looks up the alias
`capybara-sandbox-<tag>` (`GET /templates/aliases/{alias}`); when it does not exist, it builds that template from the image
`ghcr.io/capybara-hq/capybara-sandbox:<tag>` with the calls `Template.build(Template().fromImage(image), alias, { cpuCount: 1, memoryMB: 2048 })`
makes in `e2b@2.58.0` (`POST /v3/templates`, `POST /v2/templates/{templateID}/builds/{buildID}` with `{fromImage, steps: [], force: false}`,
then `GET /templates/{templateID}/builds/{buildID}/status?logsOffset=` every second until `ready`, at most 30 minutes and never past the
extension's lifetime (`ctx.signal`); `error` fails with E2B's reason and tells you to set `template`). E2B credentials alone are enough.
`<tag>` is **this plugin's own version**: the images are published by this repository's images workflow tagged with sandbox-docker's version,
and sandbox-docker and sandbox-e2b are one changesets `fixed` group, so both always share one version (= the image tag). The alias replaces
each `.` with `-` (`0.1.0-rc.3` → `capybara-sandbox-0-1-0-rc-3`), so a new version builds a new template and an existing one is reused.
**Only a private template of your team is used:** the alias is a predictable name, so an alias lookup answering `public: true`, or 403 (an
alias of another team), and a build request answered 403 / 409 or creating a public template fail with "template alias … is owned by another
E2B team or is public; set the sandbox-e2b setting `template` to a template of your own"; the plugin never runs sandboxes from a template it
did not build or you did not name. The result is memoised per provider instance (a failure is not); concurrent first uses share one build, and two replicas
starting at once may both build (wasteful but correct). An alias that exists does not mean its build is ready (another replica's build in flight,
or a failed build): when creating a sandbox from it answers E2B's 404, the plugin builds the alias itself, polls until ready and retries once.
CPU and memory are the kernel's defaults (1 core, 2048 MB); E2B templates are amd64.
**Unverified: the image's `ENV`.** The image sets the package cache variables (`npm_config_cache`, `PIP_CACHE_DIR`, `XDG_CACHE_HOME`, …,
all under `/workspace/.cache`) and `NODE_USE_ENV_PROXY=1` with `ENV`. Whether a template built with `fromImage` (or your own
`fromDockerfile` template) passes them to the processes envd starts is not yet confirmed on real E2B; the live test logs it
(`[e2b-live] image env: …`). Without them caches land in the tools' defaults under `HOME` (`/workspace`), so they still persist with the
files. `NODE_USE_ENV_PROXY` has no effect on E2B (no proxy variables are set there).

**Your own template.** Set `template` to a template name or id, for example one built from `plugins/sandbox-docker/image/Dockerfile`
(E2B's Template SDK parses the Dockerfile's FROM / RUN / COPY / ADD / WORKDIR / USER / ENV / ARG / CMD / ENTRYPOINT). From the repository root:

```bash
export E2B_API_KEY=e2b_…           # for self-hosted, also set E2B_DOMAIN / E2B_API_URL
mkdir -p /tmp/e2b-build && cd /tmp/e2b-build && npm init -y >/dev/null && npm i e2b@2.58.0
cat > build.mjs <<'EOF'
import { readFileSync } from "node:fs";
import { defaultBuildLogger, Template } from "e2b";
const dockerfile = readFileSync(process.argv[2], "utf8");
await Template.build(Template().fromDockerfile(dockerfile), "capybara-sandbox", {
  cpuCount: 1,        // matches the kernel's sandbox.cpu default
  memoryMB: 2048,     // matches the kernel's sandbox.memoryMb default
  onBuildLogs: defaultBuildLogger(),
});
EOF
node build.mjs <repo path>/plugins/sandbox-docker/image/Dockerfile
```

Then set `template` to `capybara-sandbox`. Image conventions (the plugin depends on them): the user `sandbox` (uid 1000), with HOME and the working directory at
`/workspace`; `/skills` owned by root (0755); `/opt/capybara` owned by root and 0700; `runuser` / `setsid` (util-linux),
`pkill` / `pgrep` (procps) and GNU coreutils installed. Rebuild the template after changing the Dockerfile.

## Lifecycle

| `sandbox@2` | E2B call |
|---|---|
| `createFileSystem` | Lists by the metadata `capybara-sandbox-name=<name>` (`GET /v2/sandboxes?metadata=…&state=running,paused`, paginated) and returns an existing sandbox of that name (the kernel may have stopped before recording the handle); otherwise ensures the template (above), `POST /v2/sandboxes` (`templateID`, `metadata`, `timeout`, `autoPause: true`, `autoPauseMemory: false`, `secure: true`, network settings), then pauses it without memory (`POST /sandboxes/{id}/pause` `{memory: false}`); the file system handle is E2B's sandbox id. An older kernel's limits are refused before any E2B call |
| `create` (instance) | `POST /v2/sandboxes/{id}/connect` `{timeout}` on the file system's sandbox (resumed; a 409 while another resume is in flight is retried); the instance handle carries the same id. E2B's 404 → `FileSystemGoneError` (the files are lost, never replaced by an empty sandbox); other failures, a bare 404 included, are ordinary errors. `image` and `limits` are ignored: they were fixed at `createFileSystem` |
| `update` (`limitsApplyAt: "fileSystem"`) | Applies the new network policy to the running sandbox without recreating it: connect first (resumes a paused one), then `PUT /sandboxes/{id}/network` (see "Network policy"); returns `"updated"`. E2B's 404 at either step → `SandboxGoneError`; an older kernel's limits are refused before any call |
| `resume` | `POST /v2/sandboxes/{id}/connect` (a paused one is resumed, and a running one gets its timeout pushed back); 404 → `gone` |
| `suspend`, `destroy` (instance) | `POST /sandboxes/{id}/pause` `{memory: false}` (the SDK's `mode: "filesystem"`): every process ends, the files stay, like the Docker plugin stopping or removing its container; a missing one (404) or an already paused one (409) also counts as success |
| `destroyByName` | Lists running sandboxes by the metadata name and pauses each without memory (files kept) |
| `destroyFileSystem` / `destroyFileSystemByName` | `DELETE /sandboxes/{id}` (a missing one also counts as success); by name it first lists by metadata (running and paused), which also removes a `sandbox@1` sandbox under a `cap-<conversationId>` name |
| Inactivity destruction | Nothing to do on E2B's side (the sandbox is already paused) |
| `killAll` | After connect (a paused one is resumed first; paused without memory, no process comes back), runs a script as the sandbox user that kills every command started through `exec` that is still running (SIGKILL by process group and session); called when the kernel takes over from a crashed previous lock holder |
| Concurrent use (`concurrentExec`, `killTagged`) | Declares `concurrentExec: true`: envd runs each `process.Start` independently, so the sessions of one device (and their sub-agents) run commands and file operations in its sandbox at the same time. Each exec's control file carries the holder's tag (`/tmp/.capybara-exec-<tag>-<uuid>`, tags checked against `SANDBOX_TAG_RE`); `killTagged` runs a script as the sandbox user that kills only the commands of the given tags. Concurrent `connect` calls are idempotent (a running sandbox only gets its timeout extended); a 409 answered while another call's resume is in flight is retried briefly (5 × 500 ms; to be confirmed on real E2B, see `test/live`). Uploads use UUID names in the staging directory. When a kill cannot run, the reboot fallback (pause + cold `connect`) also ends live siblings' commands (a last resort) |
| `exec` / file operations | First connect (a paused one is resumed, which is the contract's "auto-start"; the envd access token is fetched. **If no token can be obtained it does not connect and sends no request without a token; it reports `SandboxGoneError` (`resume` returns `gone`), and the kernel tries a new instance once, but `create` reconnects the same E2B sandbox and fails the same way, so the device stays unusable until its files are reset
or the device is recreated**; the timeout is pushed to at least "command timeout + 120 seconds", and not beyond 24 hours), then calls envd; a connect that returns an E2B-format 404 (`{code: 404, …}`) → `SandboxGoneError`; a bare 404 (a proxy, a misconfigured `apiUrl`), 401 / 5xx / network errors → ordinary errors. pause / delete also treat only an E2B-format 404 as "does not exist" |

- **Timeout**: an E2B sandbox is handled when its timeout (`timeoutSeconds`) expires; this plugin sets `autoPause: true` and `autoPauseMemory: false` when creating a sandbox,
  so on expiry it is **paused** (without memory, like `suspend`) instead of deleted, and files are not lost even when the kernel has no chance to `suspend` (for example the whole kernel is down). Every use pushes it back through connect (it only extends, never shortens).
  Idle hibernation and expiry destruction are handled by the kernel's maintenance tasks. E2B's continuous run limit (24 hours on Pro, 1 hour on Hobby) is recounted after pause / resume.
- **Hobby plan**: the `timeout` of connect / create is at most 1 hour, so the deployment config `timeoutSeconds` must be ≤ 3600, and a single command can actually run at most
  about 1 hour minus 2 minutes; however large the `Bash` `timeout` (in milliseconds) is (capped by `sandbox.limits.maxCommandSeconds`, default 7200 seconds), it will be interrupted by the pause when the sandbox expires.
  On Hobby, set `sandbox.limits.maxCommandSeconds` to below 3480.
- **Retention**: E2B's current documentation says paused sandboxes have no time to live and are never removed by E2B
  ([persistence](https://e2b.dev/docs/sandbox/persistence)); an older beta page said 30 days. Not yet confirmed against the live API (a
  sandbox paused for more than 30 days, see `test/live`). The files live until the device is deleted (`destroyFileSystem`); a paused sandbox
  that is gone nevertheless surfaces as `FileSystemGoneError` from `create` (`gone` from `resume`), and the kernel shows the device's files as
  lost, never a silent empty workspace. Phase 1 has no export to object storage.

## exec and files

- **exec**: envd's `process.Process/Start` (a server stream of the Connect protocol), run as the `sandbox` user:
  `setsid -w /bin/sh -c <wrapper> … timeout -s KILL <timeout + 5 seconds> /bin/bash -c <command>`; the wrapper first writes the session id to
  `/tmp/.capybara-exec-<uuid>.pid`. The `timeout` inside the sandbox is the backstop: when a kernel replica crashes the timer on the plugin side is gone, disconnecting envd's stream does not end
  the process, and pause then resume would bring the process back; on expiry it kills the process group the command is in.
  On timeout or abort: a kill-processes script runs as the sandbox user, SIGKILLing all processes the command spawned by process group and session (the same as the Docker plugin),
  then every process whose environment carries the command's marker `CAPYBARA_EXEC=<control file>` (set on every exec, so a child that left the
  session with `setsid` or as a daemon is found too; only a process that clears its own environment escapes it), then envd's `SendSignal` by pid serves as a backstop (it only ends the session's first process); it returns only after the kill finishes, and disconnects after a 3-second grace period (disconnecting itself does not
  end the processes in the sandbox).
  The in-sandbox `timeout` path kills the marked processes as well. Real envd ends a command's output stream when the command itself exits, even while
  an escaped child still holds the output (verified on E2B 2026-11-08), so the stream alone cannot show that a kill missed something: the marker scan does.
  **Last resort: reboot the sandbox.** When the kill-processes script did not finish (could not start, for example process count exhausted, timeout, or unreachable),
  marked processes are still there after it, or the output stream still has not ended 3 seconds after the kill: first pause, then `POST /v2/sandboxes/{id}/connect` `{timeout, memory: false}`
  (that is, the SDK `e2b@2.58.0`'s `Sandbox.connect(id, { onResume: "reboot" })`) to cold-start from the disk state: all processes in memory end,
  files such as `/workspace` are kept, writes not flushed before the pause may be lost, and whether things in `/tmp` survive depends on whether they are on disk. A warn log is written;
  the call returns as usual with `timedOut: true` or the abort result. The SDK notes: this requires the control plane to support connect's `memory` field (E2B cloud; self-hosted must be a
  `e2b-dev/runtime` after 2026-08-20), and an older control plane will **ignore the field** and restore the memory snapshot (processes still there), and an
  environment without "restore only the filesystem" enabled will reject the request; in both cases the backstop is ineffective (only logged).
  When a command is ended by a signal we did not send (envd's end event `exited: false`, such as OOM): by shell convention it returns `128 + signal number`
  (when Go's signal name is recognized), and when it is not recognized it returns `exitCode: null, timedOut: false` (the kernel hints "the command did not finish, the result may be incomplete").
  A timeout resolves `timedOut: true, exitCode: null`; an abort after start resolves `exitCode: null, timedOut: false` (with the output collected so far);
  an already aborted call rejects immediately. stdout + stderr together are truncated by `maxOutputBytes` and set `truncated`; when truncating it backs up to a full
  UTF-8 character boundary. envd sends a keepalive event every 50 seconds, so a command with no output for a long time is not disconnected by an intermediate proxy.
- **readFile / stat**: small `head -c` / `stat` scripts run in the sandbox as the sandbox user (permissions and symlinks are resolved as the sandbox user). A missing file → null,
  and readFile on a directory also returns null.
- **list / scan** (projects): a `python3 -I` script (`src/listing.ts`, the same file as the Docker plugin's; it follows the rules of core's local device docker mode) runs in the sandbox as the
  sandbox user under `timeout -s KILL 30` with `PATH=/usr/local/bin:/usr/bin:/bin`, the normalized path passed as argv. The reachable area is `/workspace` in either mode (core spec 2026-11-14 project root §4.2): a path
  outside it, also through a link, is refused; a link whose target leaves it is not a directory. `scan` walks breadth-first, at most 500 directories, two levels below the
  base, without following links. An abort returns at once; the read-only script ends at its time limit at worst. A template without python3 or timeout gets a clear error (the
  published template has both), and so does a listing that hits the 30 s limit.
- **writeFile**: envd's upload endpoint opens the target as root and follows symlinks, so writing to the target directly could bypass permissions with something like `/workspace/l -> /etc`.
  So the plugin only transfers the bytes to a root-only staging directory `/opt/capybara/upload/<uuid>` (`/opt/capybara` owned by root, 0700), then runs as root
  `runuser -u sandbox -- sh -c 'mkdir -p …; cat > target' < staging file`: root only opens the staging file, while creating the directory and writing the target are both resolved as the
  sandbox user; the staging file is deleted whether it succeeds or not (when aborted it may remain in the root-only directory and is removed with the sandbox).
- **/skills is read-only**: `/skills` is owned by root (0755) and the sandbox user can only read it. `writeFile("/skills/…")` writes directly as root (`umask 022`,
  file mode 0644); the sandbox user cannot place symlinks in `/skills`, so root's writes cannot be redirected elsewhere.

## Network policy (`limits.mode`, `limits.network`)

The kernel sends the device's network as `limits.network` (`{ kind: "open-public" | "allowlist", hosts }`) with
`limits.mode` (`auto` | `sandbox`). This plugin enforces the network and never reads any org setting. Every mode uses **the same
template** (one image for all); the network policy changes only the network. cpu / memory / disk stay those of the template (see
"Resources").

E2B's network control ([docs](https://docs.e2b.dev/sandbox/internet-access); the allowlist mapping was verified against the live
API on 2026-11-14, the field names against the `e2b@2.58.0` SDK's `SandboxNetworkConfig` / `SandboxNetworkUpdateConfig`):

| `limits.network` | Setting when creating the sandbox | Body of `update` (`PUT /sandboxes/{id}/network`) |
|---|---|---|
| `{ kind: "allowlist", hosts: [...] }` with hosts | `network: { allowOut: hosts, denyOut: DENIED }` | `{ allowOut: hosts, denyOut: DENIED }` |
| `{ kind: "allowlist", hosts: [] }` | `allow_internet_access: false` | `{ allow_internet_access: false }` |
| `{ kind: "open-public", hosts }` | `allow_internet_access: true, network: { denyOut: OPEN_DENIED }` | `{ allow_internet_access: true, denyOut: OPEN_DENIED }` |

`DENIED` is `["0.0.0.0/0", "fc00::/7", "fe80::/10", "::1/128"]`: all IPv4, plus IPv6 unique-local,
link-local and loopback.

`OPEN_DENIED` is `["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10",
"fc00::/7", "fe80::/10", "::1/128"]`: the private, loopback, link-local and CGNAT ranges. `open-public` sends no `allowOut`
(E2B's allowed entries take precedence over denied ones) and ignores its `hosts`. `0.0.0.0/8` is not listed: E2B rejects it as
an invalid CIDR (live 2026-11-14). E2B enforces `denyOut` by resolved destination IPv4 (`curl --resolve example.com:80:10.0.0.1`
is refused, verified live 2026-11-14), so a public name that resolves to a private address is refused too.

**Residual: the E2B metadata endpoint (MMDS) is reachable in every mode.** The sandbox's own Firecracker MMDS at
`169.254.169.254` is not subject to E2B's egress filter: it answers `GET /latest/meta-data/` (401 without a token) and hands out
a token with `PUT /latest/api/token` even with `denyOut: ["169.254.169.254/32"]`, with every private range denied, under an
allowlist and with the network fully closed (`allow_internet_access: false`) — verified live on 2026-11-14. Refusing
`open-public` therefore removed no exposure, so the plugin maps it (decision D1 of core's 2026-11-15 auto mode hardening spec)
and states the residual here instead. Deployments for which the MMDS exposure is not acceptable run their devices on the Docker
plugin, whose egress proxy refuses private and metadata addresses by resolved IP.

`limits.mode` is validated but changes nothing on E2B: an E2B sandbox is always a cloud microVM (the container is the boundary), so
both modes use the same template, and both follow `limits.network` (auto mode normally gets `open-public`).
**An older kernel is refused**: one that sends `tier` / `egress` / `allowHosts` (or a `network.kind` this plugin does not know)
gets an English error instead of a guessed policy, so a plugin upgraded without its kernel never opens the network; upgrade the
kernel and the sandbox plugins together (the kernel first sends `limits.mode` / `limits.network` in 0.1.0-rc.29; the plugin needs
`@capybara-hq/plugin-sdk` 0.1.0-rc.22, which declares them).

E2B's allowlist ([docs](https://docs.e2b.dev/sandbox/internet-access), verified 2026-10-21):

- Per-domain filtering applies only to **HTTP on port 80 (by the Host header) and TLS on port 443 (by SNI)**; other ports are filtered
  only by IP / CIDR, and with only domains in the allowlist they are always blocked. UDP (QUIC / HTTP3) does not support per-domain
  filtering.
- When a domain allowlist is used, E2B automatically allows **all traffic** to `8.8.8.8`, not only DNS on port 53, and adding
  `8.8.8.8/32` to `denyOut` does not remove it (E2B documents this). The DNS queries themselves can be used to exfiltrate small
  amounts of data. E2B's `dnsServers` setting (up to 10 IPv4 addresses, or an empty list) is the only documented control; it has an
  effect only when a domain is in `allowOut`.
- **The per-domain allowlist is not a destination-IP control.** Domain matching inspects only the Host header on port 80 and the
  SNI on 443; it does not check the destination IP. A live check (2026-11-14) showed that an allowed Host / SNI aimed at a
  *private* IP is refused (the `denyOut` list wins), but the same Host / SNI aimed at any *public* IP is accepted: `curl --resolve
  example.com:80:1.1.1.1` works. So an allowed name reaches any public IP on 80 / 443, and the plugin cannot resolve-and-pin the
  destination the way the Docker egress proxy does. Only the destinations in `DENIED` are refused. The sandbox's metadata endpoint
  is reachable regardless of the policy (see above).
- **IPv6**: `DENIED` covers IPv6 loopback (`::1/128`), link-local (`fe80::/10`) and unique-local (`fc00::/7`) as well as all IPv4.
  E2B rejects `::/0` as an invalid denied CIDR (live 2026-11-14), so public IPv6 is not denied by CIDR; it is unreachable anyway
  because the microVM has no global IPv6 address or route: `ip -6 addr` shows only `::1/128` and a link-local address, and a
  control sandbox without the IPv6 deny list could not reach public IPv6 either (verified live 2026-11-14). If E2B ever gives the
  microVM public IPv6, this list does not cover it.
- Other sites on the same CDN / object storage may also be allowed along with it (the E2B docs say this too).
- **For self-hosted E2B, network isolation is the operator's responsibility**: intranet services and cloud metadata addresses
  (169.254.169.254 and so on) that the sandbox node can reach must be blocked at E2B's node / network layer; this plugin cannot do it
  for you.
- If an egress that "checks the destination IP after resolving" is wanted later, E2B's `network.egressProxy` can be used (SOCKS5, see
  SDK 2.58 `buildEgressProxyBody`): it sends all sandbox egress to our own proxy (for example the same checks as the Docker plugin's
  egress proxy); this plugin does not use it yet.
- A rejected TCP connection may look "connected" inside the sandbox; you only know it was rejected from the application layer (HTTP
  status, TLS handshake).
- `*.example.com` matches subdomains (same as the Docker plugin, not including `example.com` itself).
- For self-hosted E2B that does not support per-domain filtering, set `domainAllowlist: false`: an allowlist degrades to no network with
  a warning (it never silently opens up).
- **The allowlist cannot stop data sent to allowlisted hosts** (the same as the Docker version): `git push` to github.com and publishing
  to npm / PyPI are within the allowlist, and attachments in a conversation and data the agent has read can leak this way. Orgs that
  handle sensitive data should set `sandboxToolPolicy` to `ask` in the org settings, and / or set the org's network to an empty
  allowlist (no network at all).

**Limits apply at the file system** (`limitsApplyAt: "fileSystem"`): an instance is the same E2B sandbox resumed, so `create` cannot
change what `createFileSystem` set. A change of network policy reaches an existing device through **`update`**: the kernel calls it
under the exclusive lease, right after `resume`, when the device's `mode` or `network.kind` differs from what its instance was made
with. `update` sends `PUT /sandboxes/{id}/network` (the `e2b@2.58.0` SDK's `Sandbox.updateNetwork`), which replaces the whole network
configuration at once, with no restart: running commands keep running, new connections follow the new rules. Its limits:

- **Only a running sandbox can be updated**: a paused sandbox answers E2B's 404 (verified on E2B 2026-11-08; the live test keeps
  recording it as `[e2b-live] paused network update: …`). `update` therefore connects first (a paused sandbox is resumed), then sends
  the update; a 404 after that means the sandbox is gone (`SandboxGoneError`). Limits the plugin cannot read throw before the connect.
- **Only the network changes.** cpu / memory / disk and the template stay; a later change of only the host list is not sent by the
  kernel (it compares `mode` and `network.kind` only) and reaches the device on the next mode or kind change or a file reset.
- Connections already open when the rules narrow are E2B's business; the docs do not say whether they are cut.

**Command time limit**: a single command runs at most `sandbox.limits.maxCommandSeconds`, and no more than the time left in the run it belongs to (`runtime.maxRunSeconds`,
default 900 seconds, Ruling M20); to run long commands, raise `runtime.maxRunSeconds` to at least `maxCommandSeconds`.

## Permission profiles (operation contract)

The provider implements the permission operation contract of `sandbox@2` (plugin SDK
0.1.0-rc.28): `permissionSupport`, a fresh immutable `operation` per invocation, owner `browse`,
trusted `prepare` (skills and attachments), `revokeOperation` and exact `background` supervision
(`start`, `status`, `tail`, `readOutput`, `stop`). It changes nothing about the device: one VM, its
OS user, files, installed environment and network stay shared, no conversation grant updates the
VM's network, and no other VM is ever made from copied files.

**Restricted profiles are unavailable on the tested template.** The SDK's restricted launcher
needs Landlock ABI 6 (and per-task child lists, a seccomp listener and pidfds). The tested
template (`capybara-sandbox-0-1-0-rc-13`, E2B cloud, 2026-11-17) runs Linux `6.1.189+` x86_64
with LSMs `capability,landlock` and **Landlock ABI 2**; child lists exist, the seccomp user
notification action is available and unprivileged user namespaces are enabled, but this provider
adds no namespace launcher (no new privileges, no relaxed hardening). So:

- `permissionSupport` runs the SDK launcher's own probe inside the VM and reports
  `restricted: null` with the template's facts in `unavailableReason` (for example "Landlock ABI 2
  is below the required 6 (template kernel 6.1.189+ (x86_64))"), `fullAccess: true`,
  `background: true`. It is template-specific: another template reports its own kernel. Even a
  template whose kernel passes the probe stays restricted-unavailable in this version (there is no
  validated restricted execution path on E2B yet). It answers only for a running VM and never
  resumes one.
- `operation`, `background.start` refuse every grant other than Full access (device files plus the
  environment network) with `SandboxPermissionUnsupportedError` before any VM call: a scoped file
  grant, a read-only grant, or device-wide work with a narrowed network. Nothing falls back to Full
  access.
- Full access runs the provider's ordinary exec wrapper (the existing OS user, environment and VM
  network, no restricted syscall, socket or daemonization filter) behind an admission check, and
  native file calls through the SDK native helper on `/` as the device user.

**Runtime staging.** Templates built before the runtime existed have none, so the provider stages
it in the VM itself on first use: the SDK's `native-files.py` and `linux-sandbox.py` (unchanged
bytes) and this provider's agent `runtime/capybara-operation.py` (an adapted copy of
sandbox-docker's agent without the restricted launch path; embedded in
`src/operation-agent-source.ts`, regenerate with `node plugins/sandbox-e2b/scripts/gen-agent-source.mjs`)
are uploaded as root to the root-only `/opt/capybara/upload`, checked by root against `SHA256SUMS`
and moved with one rename into `/opt/capybara-e2b-runtime/<agent digest prefix>/` (root, 0755 /
0644). The directory is named after the agent digest, so each provider version runs only its own
agent; the agent re-checks the SDK files' digests and owners on every launch, and
`permissionSupport` checks owners, modes and digests before reporting anything.

**Records.** Consume records, tombstones, cancellation markers and background records live in
`/opt/capybara-e2b-ops` (root, 0711; records 0600) on the VM's disk, so they survive a pause
(which ends every process) and are out of the device user's reach even under Full access. Every
method consumes its operation ID before any effect: a retry with the same method and input is an
unknown outcome (never a repeat), a different one a validation error. `revokeOperation` writes the
tombstone first, kills the operation's foreground wrapper and its background execution, and
reports a retry when the VM rebooted meanwhile. On a paused VM it stays pending (it throws, the
kernel retries) even past the admission deadline: the provider pauses without memory, but a paused
VM cannot confirm that nothing of the operation survives (a control plane that restores a memory
snapshot would bring its processes back), so success waits for a running VM. A native call
(read, write, list) that passed its admission check before the tombstone was written runs to its
end: revocation stops executions, not an in-flight native call, as on Docker (the kernel aborts
the call first).

**Root runs only a verified agent.** Every root run of the agent goes through an inline
`python3 -I -c` check: `/`, `/opt`, the runtime base and directory and the agent file must be
root-owned, not group or world writable and of the right type, and the agent's bytes must match the
provider's pinned digest; only then is the agent executed in the same process. A missing or
untrusted runtime (for example a planted directory) is restaged, which replaces an untrusted
directory, and the call is retried once. An aborted or timed-out agent command is killed in the
VM (envd SIGKILL by pid, also when the abort came before envd reported the pid), never left
running; an aborted background start's detached supervisor is then stopped by its recorded
identity. A kill that cannot be confirmed (the signal fails, or the stream stays open past the
grace period) reboots the VM, as for exec; on the paths that never resume a paused VM (status,
output, stop, revocation, support) a VM that is not running is left paused and the call reports
an unknown outcome.

**Background executions** (Full access only) use the same design as sandbox-docker: a detached
supervisor per operation, a root recorder that accepts the supervisor's frames only on the root
UNIX socket connection whose `SO_PEERCRED` pid, start time, exact argv, stdin token and admitted
request digest match, an acceptance byte before any launch, and an unacknowledged start kept for
the same-ID retry only when `bg-start` exited 0 with exactly one result frame. Requests reach the
agent only on its stdin (envd `SendInput` / `CloseStdin`), never argv or the environment. Status,
tail, output reads and stop use `GET /sandboxes/{id}` (state and envd token, no connect) and never
resume a paused VM; work of a previous boot reports `lost`.

Residual trust (as on Docker, "M5"): Full access work shares the device uid, so it can signal or
ptrace sandbox-user processes such as a background supervisor (the template has no Yama
restriction); it cannot change root-owned records or runtime files. Stop and revocation end the
background supervisor and the process group it owns; descendants that escaped it (`setsid`, a
daemon) survive them, as on Docker. The foreground wrapper also finds escaped processes by their
environment marker; background work has no such marker. Only a VM pause ends them.

## Resources (`limits.cpu` / `memoryMb` / `diskMb`)

E2B's CPU and memory are fixed **when the template is built** (`cpuCount` / `memoryMB` of `Template.build`) and cannot be specified per sandbox at creation; disk size is decided by
E2B's plan / template. So for `limits` cpu / memoryMb / diskMb this plugin only validates them (at `createFileSystem`) and **does not apply them per sandbox**: the template it builds
itself has the kernel defaults of 1 core / 2048 MB; for another spec build your own template (the example above) and set `template`. The sandbox CPU / memory overrides the super admin sets for an org in the admin console
(deployment setting `sandboxLimitOverrides`) likewise **have no effect on this plugin**: to give some orgs a bigger spec, the only way is to switch to a different deployment
(or template).

## Client

It does not use the official `e2b` SDK and instead has a minimal hand-written client (`src/e2b-api.ts`, the global `fetch`, no third-party dependencies):

- Every request carries the caller's AbortSignal directly, so abort semantics are controllable (the command stream is disconnected by the plugin itself: kill the process first, then disconnect);
- The official SDK reads process environment variables such as `E2B_API_KEY` / `E2B_DOMAIN` / `E2B_SANDBOX_URL` / `E2B_DEBUG` and caches a connection pool at module level
  (the multi-replica discipline does not allow module-level mutable state in a plugin), and it also brings undici, Connect, protobuf and a string of other dependencies;
- It uses only 10 control plane endpoints (4 of them for the template build) and 3 envd endpoints, with the protocol following the SDK `e2b@2.58.0` implementation (listed in the header comment of `src/e2b-api.ts`).

Protocol sources (verified 2026-10-21): `dist/index.mjs` of `e2b@2.58.0`; the E2B docs
[internet-access](https://docs.e2b.dev/sandbox/internet-access), [persistence](https://docs.e2b.dev/sandbox/persistence),
[sandbox lifecycle](https://docs.e2b.dev/sandbox), [template quickstart](https://docs.e2b.dev/template/quickstart),
[template migration (fromDockerfile)](https://docs.e2b.dev/template/migration-v2); the envd source
[upload.go](https://github.com/e2b-dev/infra/blob/main/packages/envd/internal/api/upload.go).

## Test-only options

The third parameter of `createE2BSandbox(config, { log }, testOptions)` can be passed only by code that calls it directly; the plugin config cannot set it:

- `envdUrl`: the envd address is changed to this (routed by the `E2b-Sandbox-Id` request header), instead of being assembled from the sandbox id and domain.
- `listPath`: the PATH `list` / `scan` run with (the fake E2B runs commands on the test machine).
- `loseBackgroundAck(taskId)`: drops a background start's acknowledgement as if the transport lost
  it (the live lost-acknowledgement test).
- `backgroundStartCommand(taskId, cmd)`: replaces the real `bg-start` command of a background start.

## Tests

- `test/sandbox-e2b.test.ts`: against `startFakeE2B` from `@capybara-hq/testing` (control plane API + envd, Connect stream protocol,
  commands really run in a local temp directory), covering each method, error mapping (404 → gone, 401 / 5xx → ordinary errors), abort, kill on timeout,
  file reads and writes and the way `/skills` is written, the network policy mapping (an allowlist, an empty allowlist as no network,
  `open-public` as internet access with `OPEN_DENIED`, an older kernel's limits refused before any E2B call), `update` (against a stub of
  `PUT /sandboxes/{id}/network` in front of the fake, which has no network route: resume first, the bodies, gone and refused cases), and the reboot backstop when killing fails / the output stream does not end (the fake server's `memory: false` connect ends all processes);
  file systems and instances (files survive destroy and recreate, connect 404 → `FileSystemGoneError`, pause drops memory, cleanup by name), and the template
  auto-build (built once from the image, polled until ready, an existing alias reused, a not-ready alias rebuilt, a failed build not memoised).
- `test/permission-scopes.test.ts`: the staged runtime bytes (SDK files unchanged, the embedded
  agent equal to `runtime/capybara-operation.py` and its digest), the envd stdin calls, and every
  path that must refuse before any VM call (restricted grants, a malformed scope, foreign
  references, preparation roots, browsing inside the records, output bounds) or must never resume a
  paused VM (status, tail, output, stop, support, revocation).
- `test/live/permission-scopes.live.test.ts`: real E2B (same switches as below, plus
  `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1`, which fails unless the template reports restricted
  support): the template probe and its kernel facts, `runSandboxPermissionConformance` (its
  fail-closed branch) and `runSandboxNativeConformance` (through Full access) on the actual
  provider, Full access OS rights and VM network (positive and negative) without a network update,
  consume-once, revocation, overlap orders, background executions, records out of reach,
  preparation, browsing, and a paused VM never resumed. One VM, deleted and asserted absent at the
  end.
- `test/live`: real E2B, run only when `CAPYBARA_TEST_E2B_API_KEY` is set (optionally `CAPYBARA_TEST_E2B_TEMPLATE`, unset to exercise the auto-build,
  and `CAPYBARA_TEST_E2B_API_URL` / `CAPYBARA_TEST_E2B_DOMAIN`), otherwise skipped: the template, the file system created paused, the sandbox user, files, `/skills` read-only (including a write through a symlink being
  rejected), the network allowlist, `open-public` (a public host reachable, private / loopback / CGNAT / link-local destinations
  refused, at create and by `update`), the metadata endpoint staying reachable under every policy (the documented residual), output truncation, kill on timeout (including nohup child processes), abort, long periods with no output, a
  child process that escaped the session being killed by its environment marker,
  files surviving instance destroy, whether a paused sandbox's network rules can change, `destroyFileSystem` → `FileSystemGoneError`. The file header lists the "assumptions that can only be confirmed on real E2B"; check them one by one on the first run.

## Icon

`icon.svg`: the E2B symbol (owner: E2B), downloaded on 2026-11-08 from the E2B brand page, https://e2b.dev/brand
(e2b-symbol-fire-orange-s.svg). It is a trademark of its owner, used only to identify the service
this plugin connects to; the plugin is not affiliated with or endorsed by the owner. The artwork is
unchanged except for removing editor metadata and setting a square viewBox.
