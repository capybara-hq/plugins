# @capybara-hq/plugin-sandbox-e2b

The E2B implementation of environments (`sandbox@2`): one E2B sandbox per environment (E2B cloud or self-hosted E2B). E2B has no volume
separate from a micro-VM, so the environment's file system **is** the E2B sandbox kept paused without memory, and an instance is the same sandbox
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
| `domainAllowlist` | `true` | Whether E2B supports a per-domain egress allowlist; set `false` for self-hosted versions that do not, and `allowlist` degrades to `none` with a warning |
| `allowOpenEgress` | `false` | Allow `sandbox.limits.egress = "open"`; when false, `createFileSystem` fails immediately on open (an English error) |

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
| `createFileSystem` | Lists by the metadata `capybara-sandbox-name=<name>` (`GET /v2/sandboxes?metadata=…&state=running,paused`, paginated) and returns an existing sandbox of that name (the kernel may have stopped before recording the handle); otherwise ensures the template (above), `POST /v2/sandboxes` (`templateID`, `metadata`, `timeout`, `autoPause: true`, `autoPauseMemory: false`, `secure: true`, egress settings), then pauses it without memory (`POST /sandboxes/{id}/pause` `{memory: false}`); the file system handle is E2B's sandbox id |
| `create` (instance) | `POST /v2/sandboxes/{id}/connect` `{timeout}` on the file system's sandbox (resumed; a 409 while another resume is in flight is retried); the instance handle carries the same id. E2B's 404 → `FileSystemGoneError` (the files are lost, never replaced by an empty sandbox); other failures, a bare 404 included, are ordinary errors. `image` and `limits` are ignored: they were fixed at `createFileSystem` |
| `resume` | `POST /v2/sandboxes/{id}/connect` (a paused one is resumed, and a running one gets its timeout pushed back); 404 → `gone` |
| `suspend`, `destroy` (instance) | `POST /sandboxes/{id}/pause` `{memory: false}` (the SDK's `mode: "filesystem"`): every process ends, the files stay, like the Docker plugin stopping or removing its container; a missing one (404) or an already paused one (409) also counts as success |
| `destroyByName` | Lists running sandboxes by the metadata name and pauses each without memory (files kept) |
| `destroyFileSystem` / `destroyFileSystemByName` | `DELETE /sandboxes/{id}` (a missing one also counts as success); by name it first lists by metadata (running and paused), which also removes a `sandbox@1` sandbox under a `cap-<conversationId>` name |
| Inactivity destruction | Nothing to do on E2B's side (the sandbox is already paused) |
| `killAll` | After connect (a paused one is resumed first; paused without memory, no process comes back), runs a script as the sandbox user that kills every command started through `exec` that is still running (SIGKILL by process group and session); called when the kernel takes over from a crashed previous lock holder |
| Concurrent use (`concurrentExec`, `killTagged`) | Declares `concurrentExec: true`: envd runs each `process.Start` independently, so the sessions of one environment (and their sub-agents) run commands and file operations in its sandbox at the same time. Each exec's control file carries the holder's tag (`/tmp/.capybara-exec-<tag>-<uuid>`, tags checked against `SANDBOX_TAG_RE`); `killTagged` runs a script as the sandbox user that kills only the commands of the given tags. Concurrent `connect` calls are idempotent (a running sandbox only gets its timeout extended); a 409 answered while another call's resume is in flight is retried briefly (5 × 500 ms; to be confirmed on real E2B, see `test/live`). Uploads use UUID names in the staging directory. When a kill cannot run, the reboot fallback (pause + cold `connect`) also ends live siblings' commands (a last resort) |
| `exec` / file operations | First connect (a paused one is resumed, which is the contract's "auto-start"; the envd access token is fetched. **If no token can be obtained it does not connect and sends no request without a token; it reports `SandboxGoneError` (`resume` returns `gone`), and the kernel tries a new instance once, but `create` reconnects the same E2B sandbox and fails the same way, so the environment stays unusable until its files are reset
or the environment is recreated**; the timeout is pushed to at least "command timeout + 120 seconds", and not beyond 24 hours), then calls envd; a connect that returns an E2B-format 404 (`{code: 404, …}`) → `SandboxGoneError`; a bare 404 (a proxy, a misconfigured `apiUrl`), 401 / 5xx / network errors → ordinary errors. pause / delete also treat only an E2B-format 404 as "does not exist" |

- **Timeout**: an E2B sandbox is handled when its timeout (`timeoutSeconds`) expires; this plugin sets `autoPause: true` and `autoPauseMemory: false` when creating a sandbox,
  so on expiry it is **paused** (without memory, like `suspend`) instead of deleted, and files are not lost even when the kernel has no chance to `suspend` (for example the whole kernel is down). Every use pushes it back through connect (it only extends, never shortens).
  Idle hibernation and expiry destruction are handled by the kernel's maintenance tasks. E2B's continuous run limit (24 hours on Pro, 1 hour on Hobby) is recounted after pause / resume.
- **Hobby plan**: the `timeout` of connect / create is at most 1 hour, so the deployment config `timeoutSeconds` must be ≤ 3600, and a single command can actually run at most
  about 1 hour minus 2 minutes; however large the `Bash` `timeout` (in milliseconds) is (capped by `sandbox.limits.maxCommandSeconds`, default 7200 seconds), it will be interrupted by the pause when the sandbox expires.
  On Hobby, set `sandbox.limits.maxCommandSeconds` to below 3480.
- **Retention**: E2B's current documentation says paused sandboxes have no time to live and are never removed by E2B
  ([persistence](https://e2b.dev/docs/sandbox/persistence)); an older beta page said 30 days. Not yet confirmed against the live API (a
  sandbox paused for more than 30 days, see `test/live`). The files live until the environment is deleted (`destroyFileSystem`); a paused sandbox
  that is gone nevertheless surfaces as `FileSystemGoneError` from `create` (`gone` from `resume`), and the kernel shows the environment's files as
  lost, never a silent empty workspace. Phase 1 has no export to object storage.

## exec and files

- **exec**: envd's `process.Process/Start` (a server stream of the Connect protocol), run as the `sandbox` user:
  `setsid -w /bin/sh -c <wrapper> … timeout -s KILL <timeout + 5 seconds> /bin/bash -c <command>`; the wrapper first writes the session id to
  `/tmp/.capybara-exec-<uuid>.pid`. The `timeout` inside the sandbox is the backstop: when a kernel replica crashes the timer on the plugin side is gone, disconnecting envd's stream does not end
  the process, and pause then resume would bring the process back; on expiry it kills the process group the command is in.
  On timeout or abort: a kill-processes script runs as the sandbox user, SIGKILLing all processes the command spawned by process group and session (the same as the Docker plugin),
  then envd's `SendSignal` by pid serves as a backstop (it only ends the session's first process); it returns only after the kill finishes, and disconnects after a 3-second grace period (disconnecting itself does not
  end the processes in the sandbox).
  **Last resort: reboot the sandbox.** When the kill-processes script did not finish (could not start, for example process count exhausted, timeout, or unreachable), or the output stream still has not ended 3 seconds after the kill
  (a process escaped the session and still holds the output): first pause, then `POST /v2/sandboxes/{id}/connect` `{timeout, memory: false}`
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
- **writeFile**: envd's upload endpoint opens the target as root and follows symlinks, so writing to the target directly could bypass permissions with something like `/workspace/l -> /etc`.
  So the plugin only transfers the bytes to a root-only staging directory `/opt/capybara/upload/<uuid>` (`/opt/capybara` owned by root, 0700), then runs as root
  `runuser -u sandbox -- sh -c 'mkdir -p …; cat > target' < staging file`: root only opens the staging file, while creating the directory and writing the target are both resolved as the
  sandbox user; the staging file is deleted whether it succeeds or not (when aborted it may remain in the root-only directory and is removed with the sandbox).
- **/skills is read-only**: `/skills` is owned by root (0755) and the sandbox user can only read it. `writeFile("/skills/…")` writes directly as root (`umask 022`,
  file mode 0644); the sandbox user cannot place symlinks in `/skills`, so root's writes cannot be redirected elsewhere.

## Egress (`limits.egress`)

E2B's egress control ([docs](https://docs.e2b.dev/sandbox/internet-access), verified 2026-10-21):

| `egress` | Setting when creating the sandbox |
|---|---|
| `none` | `allow_internet_access: false` (equivalent to `denyOut: ["0.0.0.0/0"]`) |
| `allowlist` | `network: { allowOut: allowHosts, denyOut: ["0.0.0.0/0"] }`; when `allowHosts` is empty it is the same as `none` |
| `open` | `allow_internet_access: true`; `allowOpenEgress` must be turned on explicitly |

Limitations of `allowlist` (decided by E2B's implementation, written here for assessment):

- Per-domain filtering applies only to **HTTP on port 80 (by the Host header) and TLS on port 443 (by SNI)**; other ports are filtered only by IP / CIDR,
  and with only domains in the allowlist they are always blocked. UDP (QUIC / HTTP3) does not support per-domain filtering.
- When a domain allowlist is used, E2B automatically allows DNS to `8.8.8.8` (port 53), and the DNS queries themselves can be used to exfiltrate small amounts of data.
- **E2B looks only at the Host header / SNI, and the docs do not say it checks the destination IP**: a sandbox can connect to ports 80 / 443 of any IP and write the Host / SNI as a domain on the allowlist
  (such as `curl --resolve pypi.org:443:<any IP> https://pypi.org`), and so **may reach any address outside the allowlist** (including the intranet and cloud
  metadata addresses, depending on whether E2B's own network allows them). The Docker plugin's egress proxy resolves the domain and checks every destination IP; the E2B version cannot do this.
- Other sites on the same CDN / object storage may also be allowed along with it (the E2B docs say this too).
- **For self-hosted E2B, network isolation is the operator's responsibility**: intranet services and cloud metadata addresses (169.254.169.254 and so on) that the sandbox node can reach must be blocked at E2B's node /
  network layer; this plugin cannot do it for you.
- If egress that "checks the destination IP after resolving" is wanted later, E2B's `network.egressProxy` can be used (SOCKS5, see SDK 2.58 `buildEgressProxyBody`):
  it sends all sandbox egress to our own proxy (for example the same checks as the Docker plugin's egress proxy); this plugin does not use it yet.
- A rejected TCP connection may look "connected" inside the sandbox; you only know it was rejected from the application layer (HTTP status, TLS handshake).
- `*.example.com` matches subdomains (same as the Docker plugin, not including `example.com` itself).
- For self-hosted E2B that does not support per-domain filtering, set `domainAllowlist: false`: `allowlist` degrades to `none` with a warning (it never silently opens up).
- **The allowlist cannot stop data sent to allowlisted hosts** (the same as the Docker version): `git push` to github.com and publishing to npm / PyPI are within the allowlist,
  and attachments in a conversation and data the agent has read can leak this way. Orgs that handle sensitive data should set `sandboxToolPolicy` to
  `ask` in the org settings, and / or set the sandbox network `sandboxEgress` to `none` (org-level egress, Ruling M19: an org can replace the allowlist or cut the network, and cannot set `open`).

**Limits are fixed when the file system is created** (`createFileSystem`, the create-sandbox request): an instance is the same E2B sandbox
resumed, so a later change of `sandbox.limits.egress` / `allowHosts` or of the org's egress setting reaches an existing E2B environment only when
the environment is recreated (the Docker plugin applies them per instance). The `e2b@2.58.0` SDK has `Sandbox.updateNetwork`
(`PUT /sandboxes/{id}/network`), documented for **running** sandboxes; this plugin does not use it in phase 1. **Whether a paused sandbox's network
rules can be changed is not yet verified**: the live test records it (`[e2b-live] paused network update: …`); it has not been run with an E2B key
for this release.

**Command time limit**: a single command runs at most `sandbox.limits.maxCommandSeconds`, and no more than the time left in the run it belongs to (`runtime.maxRunSeconds`,
default 900 seconds, Ruling M20); to run long commands, raise `runtime.maxRunSeconds` to at least `maxCommandSeconds`.

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
- It uses only 9 control plane endpoints (4 of them for the template build) and 3 envd endpoints, with the protocol following the SDK `e2b@2.58.0` implementation (listed in the header comment of `src/e2b-api.ts`).

Protocol sources (verified 2026-10-21): `dist/index.mjs` of `e2b@2.58.0`; the E2B docs
[internet-access](https://docs.e2b.dev/sandbox/internet-access), [persistence](https://docs.e2b.dev/sandbox/persistence),
[sandbox lifecycle](https://docs.e2b.dev/sandbox), [template quickstart](https://docs.e2b.dev/template/quickstart),
[template migration (fromDockerfile)](https://docs.e2b.dev/template/migration-v2); the envd source
[upload.go](https://github.com/e2b-dev/infra/blob/main/packages/envd/internal/api/upload.go).

## Test-only options

The third parameter of `createE2BSandbox(config, { log }, testOptions)` can be passed only by code that calls it directly; the plugin config cannot set it:

- `envdUrl`: the envd address is changed to this (routed by the `E2b-Sandbox-Id` request header), instead of being assembled from the sandbox id and domain.

## Tests

- `test/sandbox-e2b.test.ts`: against `startFakeE2B` from `@capybara-hq/testing` (control plane API + envd, Connect stream protocol,
  commands really run in a local temp directory), covering each method, error mapping (404 → gone, 401 / 5xx → ordinary errors), abort, kill on timeout,
  file reads and writes and the way `/skills` is written, egress mapping, and the reboot backstop when killing fails / the output stream does not end (the fake server's `memory: false` connect ends all processes);
  file systems and instances (files survive destroy and recreate, connect 404 → `FileSystemGoneError`, pause drops memory, cleanup by name), and the template
  auto-build (built once from the image, polled until ready, an existing alias reused, a not-ready alias rebuilt, a failed build not memoised).
- `test/live`: real E2B, run only when `CAPYBARA_TEST_E2B_API_KEY` is set (optionally `CAPYBARA_TEST_E2B_TEMPLATE`, unset to exercise the auto-build,
  and `CAPYBARA_TEST_E2B_API_URL` / `CAPYBARA_TEST_E2B_DOMAIN`), otherwise skipped: the template, the file system created paused, the sandbox user, files, `/skills` read-only (including a write through a symlink being
  rejected), the egress allowlist, output truncation, kill on timeout (including nohup child processes), abort, long periods with no output, a child process that escaped the session triggering the reboot backstop,
  files surviving instance destroy, whether a paused sandbox's network rules can change, `destroyFileSystem` → `FileSystemGoneError`. The file header lists the "assumptions that can only be confirmed on real E2B"; check them one by one on the first run.
