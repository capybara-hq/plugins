# @capybara-hq/plugin-sandbox-e2b

The E2B implementation of the conversation sandbox (`sandbox@1`): one E2B sandbox per conversation (E2B cloud or self-hosted E2B), using E2B's pause for hibernation
and connect for resume. It is an either-or choice with `@capybara-hq/plugin-sandbox-docker` (`sandbox@1` is a single-select capability), and uses the same image.

## Deployment config

| Key | Default | Description |
|---|---|---|
| `apiKey` | (required, secret) | E2B API key (`e2b_…`) |
| `template` | (required) | Template name or id, built from `plugins/sandbox-docker/image/Dockerfile` (see below) |
| `apiUrl` | `https://api.<domain>` | Control plane API address; for self-hosted E2B, use your own address |
| `domain` | `e2b.app` | Sandbox domain: the envd address is `https://49983-<sandbox id>.<domain>`; when the API returns the sandbox's own `domain`, the returned one wins |
| `timeoutSeconds` | `3600` | Sandbox timeout (60–86400 seconds); when it expires E2B **auto-pauses** (does not delete), see "Lifecycle" |
| `domainAllowlist` | `true` | Whether E2B supports a per-domain egress allowlist; set `false` for self-hosted versions that do not, and `allowlist` degrades to `none` with a warning |
| `allowOpenEgress` | `false` | Allow `sandbox.limits.egress = "open"`; when false, `create` fails immediately on open (an English error) |

```bash
export CAPYBARA_EXTENSIONS='["@capybara-hq/plugin-sandbox-e2b"]'
export CAPYBARA_EXTENSION_CONFIG='{"sandbox-e2b":{"apiKey":"e2b_…","template":"capybara-sandbox"}}'
```

The deployment config schema is strict: extra keys are errors. The kernel config `sandbox.image` has no effect on this plugin (the image is decided by the template).

## Template (the same image as the Docker plugin)

The template is built from `plugins/sandbox-docker/image/Dockerfile` (E2B's Template SDK parses the Dockerfile's
FROM / RUN / COPY / ADD / WORKDIR / USER / ENV / ARG / CMD / ENTRYPOINT). From the repository root:

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

| Operation | E2B call |
|---|---|
| `create` | First lists by the metadata `capybara-sandbox-name=<name>` (`GET /v2/sandboxes?metadata=…&state=running,paused`, paginated) and deletes any old instance of the same name (the kernel may have exited before recording the handle), then `POST /v2/sandboxes` (`templateID`, `metadata`, `timeout`, `autoPause: true`, `secure: true`, egress settings); the handle id is E2B's sandbox id |
| `resume` | `POST /v2/sandboxes/{id}/connect` (a paused one is resumed, and a running one gets its timeout pushed back); 404 → `gone` |
| `suspend` | `POST /sandboxes/{id}/pause` (files and memory are both kept: background processes and `/tmp` are still there after resume; the Docker plugin's hibernation instead ends processes and clears `/tmp`); a missing one (404) or an already paused one (409) also counts as success |
| `killAll` | After connect (a paused one is resumed first, and the processes in memory come back with it), runs a script as the sandbox user that kills every command started through `exec` that is still running (SIGKILL by process group and session); called when the kernel takes over from a crashed previous lock holder |
| `destroy` / `destroyByName` | `DELETE /sandboxes/{id}` (a missing one also counts as success); by name it first lists by metadata |
| `exec` / file operations | First connect (a paused one is resumed, which is the contract's "auto-start"; the envd access token is fetched. **If no token can be obtained it does not connect and sends no request without a token; it reports `SandboxGoneError` (`resume` returns `gone`), and the kernel rebuilds a sandbox with a token on that basis; a sandbox created before `secure: true` was added never has a token**; the timeout is pushed to at least "command timeout + 120 seconds", and not beyond 24 hours), then calls envd; a connect that returns an E2B-format 404 (`{code: 404, …}`) → `SandboxGoneError`; a bare 404 (a proxy, a misconfigured `apiUrl`), 401 / 5xx / network errors → ordinary errors. pause / delete also treat only an E2B-format 404 as "does not exist" |

- **Timeout**: an E2B sandbox is handled when its timeout (`timeoutSeconds`) expires; this plugin sets `autoPause: true` when creating a sandbox, so on expiry it is **paused** instead of deleted,
  and files are not lost even when the kernel has no chance to `suspend` (for example the whole kernel is down). Every use pushes it back through connect (it only extends, never shortens).
  Idle hibernation and expiry destruction are handled by the kernel's maintenance tasks. E2B's continuous run limit (24 hours on Pro, 1 hour on Hobby) is recounted after pause / resume.
- **Hobby plan**: the `timeout` of connect / create is at most 1 hour, so the deployment config `timeoutSeconds` must be ≤ 3600, and a single command can actually run at most
  about 1 hour minus 2 minutes; however large the `sandbox_bash` `timeoutSeconds` is (capped by `sandbox.limits.maxCommandSeconds`, default 7200), it will be interrupted by the pause when the sandbox expires.
  On Hobby, set `sandbox.limits.maxCommandSeconds` to below 3480.
- E2B keeps a paused sandbox indefinitely until it is deleted (the kernel deletes by `destroyAfterInactiveDays`).

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

**Limits take effect only at creation**: `sandbox.limits.egress` / `allowHosts` are written into the create-sandbox request, and changing the config affects only sandboxes created afterwards; existing
sandboxes (including ones resumed after a pause) keep the egress settings from creation until they are destroyed and rebuilt.

**Command time limit**: a single command runs at most `sandbox.limits.maxCommandSeconds`, and no more than the time left in the run it belongs to (`runtime.maxRunSeconds`,
default 900 seconds, Ruling M20); to run long commands, raise `runtime.maxRunSeconds` to at least `maxCommandSeconds`.

## Resources (`limits.cpu` / `memoryMb` / `diskMb`)

E2B's CPU and memory are fixed **when the template is built** (`cpuCount` / `memoryMB` of `Template.build`) and cannot be specified per sandbox at creation; disk size is decided by
E2B's plan / template. So for `limits` cpu / memoryMb / diskMb this plugin only validates them and **does not apply them per sandbox**: give the spec you want when
building the template (the example above matches the kernel defaults of 1 core / 2048 MB), and use different templates for different specs. The sandbox CPU / memory overrides an enterprise admin sets for an org in the admin console
(deployment setting `sandboxLimitOverrides`) likewise **have no effect on this plugin**: to give some orgs a bigger spec, the only way is to switch to a different deployment
(or template).

## Client

It does not use the official `e2b` SDK and instead has a minimal hand-written client (`src/e2b-api.ts`, the global `fetch`, no third-party dependencies):

- Every request carries the caller's AbortSignal directly, so abort semantics are controllable (the command stream is disconnected by the plugin itself: kill the process first, then disconnect);
- The official SDK reads process environment variables such as `E2B_API_KEY` / `E2B_DOMAIN` / `E2B_SANDBOX_URL` / `E2B_DEBUG` and caches a connection pool at module level
  (the multi-replica discipline does not allow module-level mutable state in a plugin), and it also brings undici, Connect, protobuf and a string of other dependencies;
- It uses only 6 control plane endpoints and 3 envd endpoints, with the protocol following the SDK `e2b@2.58.0` implementation (listed in the header comment of `src/e2b-api.ts`).

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
  file reads and writes and the way `/skills` is written, egress mapping, and the reboot backstop when killing fails / the output stream does not end (the fake server's `memory: false` connect ends all processes).
- `test/live`: real E2B, run only when `CAPYBARA_TEST_E2B_API_KEY` and `CAPYBARA_TEST_E2B_TEMPLATE` are set (optionally
  `CAPYBARA_TEST_E2B_API_URL` / `CAPYBARA_TEST_E2B_DOMAIN`), otherwise skipped: the sandbox user, files, `/skills` read-only (including a write through a symlink being
  rejected), the egress allowlist, output truncation, kill on timeout (including nohup child processes), abort, long periods with no output, a child process that escaped the session triggering the reboot backstop, same-name replacement,
  pause / resume, gone after destroy. The file header lists the "assumptions that can only be confirmed on real E2B"; check them one by one on the first run.
