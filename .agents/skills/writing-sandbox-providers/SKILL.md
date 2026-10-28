---
name: writing-sandbox-providers
description: 'Use when creating or changing a sandbox extension in this repository (provides sandbox@1, e.g. plugins/sandbox-docker, plugins/sandbox-e2b): contract primitives and abort semantics, SandboxGoneError versus ordinary errors, auto-starting stopped instances, in-sandbox command time limits, killAll and killTagged, concurrentExec and exec tags, same-name instance replacement and destroyByName, output limits, read-only /skills, file operations as the sandbox user, limits and org overrides taking effect only at creation, egress none / allowlist / open and allowOpenEgress, what the kernel SandboxService owns (leases, suspension, destruction), security (socket proxy placement, container hardening, the egress proxy blocking DNS rebinding), and tests with real Docker, startFakeE2B and live E2B.'
---

# Writing sandbox extensions

One sandbox per conversation, shared by its sub-agents. The kernel's sandbox tools (`sandbox_bash` / `read` / `write` / `edit` / `glob` / `grep` / `deliver`), attachment sync and `skill_load` use it through the kernel's `SandboxService`. `sandbox@1` is a **single-choice, brokered** extension point: a deployment installs only one sandbox extension, and other extensions cannot `requires` it. For general extension writing see `.agents/skills/writing-extensions`. The kernel side (the `SandboxService` lifecycle, leases, fencing, suspension and destruction, the builtin `sandbox_*` tools) is core's: [writing-sandbox-providers in core](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-sandbox-providers).

Reference implementations:

- `plugins/sandbox-docker`: one container per conversation (runc, or gVisor's runsc), reaching Docker only through a socket proxy; the egress allowlist is enforced by a proxy container each sandbox brings along.
- `plugins/sandbox-e2b`: E2B cloud or self-hosted; pause for suspension, connect for resume; a hand-written minimal client (the official SDK reads process environment variables and has a module-level connection pool).

The two READMEs spell out the platform sources, every trade-off and the known limitations; write a new implementation at that level of detail.

## Contract: `sandbox@1` (SDK `sandbox.ts`)

```ts
interface SandboxProvider {
  create({ name, image, limits, signal }): Promise<SandboxHandle>;  // name = cap-<conversationId>
  resume(h, signal): Promise<"resumed" | "gone">;
  suspend(h, signal): Promise<void>;          // files must be kept; an instance that is not there also counts as success
  destroy(h, signal): Promise<void>;          // not being there counts as success
  destroyByName?(name, signal): Promise<void>;
  killAll?(h, signal): Promise<void>;
  readonly concurrentExec?: boolean;          // exec / readFile / writeFile / stat may run concurrently on one instance
  killTagged?(h, tags, signal): Promise<void>; // kill only the exec commands labelled with one of tags
  exec(h, { command, cwd?, env?, timeoutMs, maxOutputBytes, signal, tag? }): Promise<ExecResult>;
  readFile(h, path, { maxBytes, signal }): Promise<{ data; truncated } | null>;  // missing or a directory → null
  writeFile(h, path, data, signal): Promise<void>;                               // parent directories are created automatically
  stat(h, path, signal): Promise<{ size; isDir } | null>;
}
```

`glob` / `grep` / `edit` are composed by the kernel from `exec` + `readFile` / `writeFile`; the provider does not implement them. So the image must have GNU `find` (`-print0`) and `grep` (`-rnHIE`, `--include`), `timeout`, `setsid`, `pkill` / `pgrep`.

### Semantics you must follow

- **Abort**: every method responds to `signal` promptly. Already aborted at call time → reject immediately; aborted in flight → end as soon as possible with the abort reason. The kernel relies on this to stop when a lease is lost, the run is aborted or times out; without it you may operate on the instance alongside a new lease holder. **An aborted `exec` must kill the command and its child processes**, not merely stop waiting; an `exec` aborted after the command started resolves normally with `{ exitCode: null, timedOut: false }` (with the output so far) and does not reject. A timeout resolves `timedOut: true, exitCode: null`.
- **gone versus ordinary errors**: when the instance is **definitely** gone on the provider's side (container deleted, E2B sandbox expired), `exec` / `readFile` / `writeFile` / `stat` / `killAll` throw `SandboxGoneError` and `resume` returns `"gone"`. The kernel then rebuilds an empty sandbox, retries once, and the model sees `Sandbox was recreated; previous files are gone.`. If the instance is only temporarily unreachable (401, 5xx, network errors, a bare 404 from a proxy), throw an **ordinary error**; otherwise one network blip wipes the user's files. Check with `isSandboxGoneError` (duck typing). E2B treats only E2B-format 404s (`{code: 404, …}`) as gone; failing to obtain the envd access token is also gone (better to rebuild than to send a request without the token).
- **Auto-start**: when the instance exists but is stopped / paused (host or daemon restart, a suspension that stopped it before the kernel recorded `suspended`, a manual `docker pause`), `exec` / `readFile` / `writeFile` / `stat` / `killAll` first start it the way `resume` does, then proceed without error. The kernel trusts only the `running` it recorded itself.
- **Command time limit inside the sandbox**: besides stopping the command on the provider side at `timeoutMs`, the command itself runs inside the sandbox through `timeout -s KILL <timeoutMs + a few seconds>`. When a kernel replica crashes its timer disappears and disconnecting does not end the command; this limit keeps it from running indefinitely alongside the next holder's commands.
- **killAll**: kill every command started through `exec` that is still running (SIGKILL by process group and session); background processes in a new session are not guaranteed. The kernel calls it only where no live holder can be running a command: after finding records of crashed holders under the exclusive lease, for a provider without `killTagged` while it is the one holder, and right after recovering from `suspended` (an E2B pause preserves processes). When the killing exec cannot even start (process table exhausted), Docker falls back to `restart?t=0` and E2B to pause + a `connect {memory: false}` cold start; both log a warn (Docker through the `log` passed to `createDockerSandbox`, the extension's `ctx.log`) and return normally.
- **Concurrent use (`concurrentExec`, `killTagged`, `tag`)**: parallel sub-agents share their parent conversation's sandbox, so with `concurrentExec: true` the kernel may call `exec` / `readFile` / `writeFile` / `stat` concurrently on one instance. Those methods must then be safe concurrently, and **auto-start must be idempotent under concurrent calls** (Docker's `start` on a running container answers 304, E2B `connect` on a running sandbox only extends its timeout). Every `exec` gets the holder's `tag` (`SANDBOX_TAG_RE`, `^[a-z0-9-]{1,64}$`, checked by the provider before it goes near a command line): label the command with it (the official providers name the control file `/tmp/.capybara-exec-<tag>-<uuid>`), and implement `killTagged(h, tags)` to kill only those commands' process trees, matching the whole tag: `capybara-exec /tmp/[.]capybara-exec-<tag>-<uuid>( |$)` with the UUID's exact shape, because a tag may be a prefix of another (`ab` of `ab-cd`). An aborted or timed-out `exec` still kills only its own command. `concurrentExec` requires `killTagged`: a provider that declares one without the other, or neither, gets one call at a time (with a startup warn when half-declared). Concurrent commands share the sandbox's pids and memory limits; say so in the README.
- **Same-name replacement**: `create` first deletes an old instance of the same name, then builds (the kernel may exit after the provider built it but before it recorded the handle). Implement `destroyByName` too: without a handle the kernel cleans up by `cap-<conversation>` (conversation deletion, test cleanup).
- **Output**: `maxOutputBytes` is the **combined** limit on stdout + stderr; excess is discarded and `truncated` set; truncation backs off to a full UTF-8 character boundary.
- **`/skills` is read-only**: mounted read-only for the sandbox user (or owned by root with 0755); `writeFile("/skills/…")` is written by the provider as root and must not be redirected by a symlink the sandbox user placed. The kernel's protection checks only the path string; the real defense is the provider. Skill files have no executable bit (the model runs them through an interpreter, `sh /skills/x/run.sh`).
- **File operations resolve as the sandbox user**: permissions and symlinks resolve as the non-root user (Docker runs small `head` / `stat` scripts in the container; E2B's upload endpoint opens the target as root, so upload to a root-only staging directory first and write the target with `runuser -u sandbox`). Never write volumes as root through the daemon.
- Paths have passed the kernel's `validateSandboxPath` (only `/workspace`, `/skills`, `/tmp`); the working directory is `/workspace`, attachments are in `/workspace/attachments/`.

### Limits and egress (`SandboxLimits`)

- `egress` / `allowHosts` / `cpu` / `memoryMb` are the values **in effect for the org**: the kernel applies the org's egress setting (never more open than the deployment) and an enterprise admin's per-org cpu / memory overrides before calling `create`. The provider just enforces what `create` receives and never reads org settings. A provider that cannot size each sandbox (E2B: the template decides) states in its README that org-level cpu / memory overrides do not take effect; deployers use different templates instead.
- `cpu` / `memoryMb` / `diskMb` / `egress` / `allowHosts` **take effect only at `create`**: existing sandboxes (including resumed ones) keep their creation settings until rebuilt. When an item cannot be done, say so in the README (Docker's default local volume driver does not limit `diskMb`; E2B's cpu / memory / disk come from the template).
- `egress`:
  - `none`: loopback only.
  - `allowlist` (default): only `allowHosts` (`validateAllowHost` already rejects IP literals, single-label names and `.local` / `.internal`; `*.example.com` matches subdomains, not the domain itself).
  - `open`: the provider's deployment config `allowOpenEgress` defaults to false; when false, `create` with open fails with an English error. New extensions do the same.
- **The allowlist does not prevent data exfiltration** to allowlisted hosts (`git push` to github.com, publishing packages). The README must say so and recommend `sandboxToolPolicy: ask` and / or `sandboxEgress: none` for sensitive orgs.
- A provider that cannot allow by domain name must **refuse, or degrade to `none` with a warning**, never silently open up (E2B self-hosted `domainAllowlist: false`). Where it can but more weakly, write it in the README (E2B looks only at Host / SNI and does not verify the destination IP).

## What the kernel's `SandboxService` owns

The extension implements only primitives. **No scheduling, timers or state tables in the extension.** What the kernel guarantees:

- **State and lazy creation**: the kernel records each conversation's sandbox (status, handle, provider) in PG; `create` runs on the first sandbox use.
- **Leases**: commands take shared leases (up to `sandbox.maxConcurrentCommands`, or one at a time for a provider without `concurrentExec` + `killTagged`); every lifecycle change (create, rebuild after `gone`, `resume`, `suspend`, `destroy`, `killAll` after resume) runs alone under the exclusive lease. Leases expire and are fenced, so a holder that lost its lease has its signal aborted and its state writes refused. Two replicas using a sandbox for the first time build only one; several holders hitting `gone` together rebuild once.
- **Takeover of crashed holders**: their commands are killed with `killTagged` (or `killAll` where safe) by the next holder; whatever escapes ends at the in-sandbox time limit.
- **Kernel file writes are serialized per path**; shell commands are not.
- **Suspension** after `suspendAfterIdleMinutes` (default 10) idle or `maxRunningMinutes` (default 120) running; **destruction** after `destroyAfterInactiveDays` (default 7), org or conversation deletion, or a departing member. A suspended sandbox is resumed on next use; `gone`, destroyed or a provider switch rebuilds an empty one with a notice. Switching providers leaks old instances while the old extension is unloaded.
- **Time limits**: per command `sandbox.limits.maxCommandSeconds` (default 7200; `sandbox_bash` defaults to 120 s), tightened to the owning run's remaining time.

## Security

- **Docker's socket proxy** (core's `docker/sandbox-proxy/haproxy.cfg`; the plugin's tests start it from the copy `plugins/sandbox-docker/test/sandbox-proxy/haproxy.cfg`): allows only the endpoints the extension uses, containers / volumes only by names starting with `cap-`, and rejects request bodies by regex for privileged mode, `Binds`, `CapAdd`, non-ASCII keys (Go folds key names by Unicode, `Bindſ` = `Binds`) and so on. **This is only a backstop; the main defense is network position**: anything that can reach the proxy can nearly control Docker. **Never publish the proxy on any host address (127.0.0.1 included)** in production; put it only on the kernel's internal network and never attach sandboxes to that network. The dev compose publishes it on `127.0.0.1:2375` for the local machine only; then never enable `allowOpenEgress` (an open sandbox can reach the host loopback through `host.docker.internal`). The extension reaches Docker only through `endpoint` and never mounts `docker.sock`.
- **Container hardening**: commands run as non-root (uid 1000); PID 1 runs as root with `CapDrop: ALL` (the sandbox user cannot stop the container), `no-new-privileges`, a read-only root filesystem, `PidsLimit`, private IPC, `/tmp` a tmpfs.
- **The egress proxy blocks DNS rebinding**: checking only the hostname cannot stop `10.0.0.1.nip.io`. The proxy resolves first, and **every resolved IP** must not be private, loopback, link-local (169.254.169.254 included), CGNAT, ULA, multicast or reserved (IPv4-mapped / NAT64 / 6to4 judged by the embedded IPv4), then connects to the checked IP with no second resolution. HTTPS goes through CONNECT, only ports 443 / 80. New egress implementations follow this standard.
- Logs and errors carry no secrets (E2B API key, envd token) and no other orgs' ids.

## Tests

- **Docker extension**: `buildTestImages` (unique tag), `startSocketProxy` (a real HAProxy) and `cleanupTestResources` (by label) in `plugins/sandbox-docker/test/docker-env.ts`; without Docker (or with `CAPYBARA_TEST_NO_DOCKER=1`) the group is skipped, and runsc cases run only when the daemon has runsc registered. Test-only options (extra labels, `egressTestHosts`) go through the second parameter of `createDockerSandbox`; the extension config is strict and cannot set them. A change to the socket proxy rules comes with a violating case against the real proxy (proving it is rejected), and the proxy config must stay identical to core's `docker/sandbox-proxy/haproxy.cfg`.
- **E2B extension**: `startFakeE2B` from `@capybara-hq/testing` (control plane + envd; commands really run in a local temp directory); the real-E2B `test/live` runs only when `CAPYBARA_TEST_E2B_API_KEY` / `CAPYBARA_TEST_E2B_TEMPLATE` are set (optional `CAPYBARA_TEST_E2B_API_URL` / `CAPYBARA_TEST_E2B_DOMAIN` for self-hosted), and the file header lists "assumptions that can only be confirmed in a real environment", to check one by one on the first run. Keep keys in an env file outside the repository and never print them.
- **Dual-replica through a real kernel**: `plugins/sandbox-docker/test/sandbox-artifacts.dual.test.ts` (real Docker; takeover after killing the executing replica, recovery after suspension); `@capybara-hq/testing` exports the kernel texts and keys to assert on (`SANDBOX_STARTED_NOTICE`, `SANDBOX_RECREATED_NOTICE`, `SANDBOX_LOCK_TTL_MS`, `SANDBOX_SUSPEND_JOB`). Concurrent holders: `plugins/sandbox-docker/test/concurrent.test.ts`.
- Every provider covers at least: gone versus ordinary errors, abort (before the call / in flight), a timeout killing the whole process group, auto-start, killAll, same-name replacement, a `/skills` write through a symlink being rejected, the three egress modes, and output truncation at a UTF-8 boundary.
- Run from the repository root: `pnpm exec vitest run plugins/sandbox-docker`.
