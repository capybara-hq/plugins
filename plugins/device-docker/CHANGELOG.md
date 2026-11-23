# @capybara-hq/plugin-device-docker

## 0.1.0-rc.25

### Patch Changes

- b2a71fc: Refuse a project directory outside the container's workspace (`/workspace`) with
  `ProjectPathRefusedError` and a fixed English and Chinese reason, in `list` / `scan` and in the
  owner browse the kernel adds projects through, before anything runs in the instance: the kernel
  answers `device.project_refused` and the device page explains the refusal when the project is
  added, instead of a run failing on it later.
- f775c1f: The sandbox image stages the SDK's current Linux launcher (`SANDBOX_RUNTIME_SOURCE.current`, the
  one with exact file read roots; never run in the container), and staged runtime files are checked
  against the kernel SDK's `SANDBOX_RUNTIME_SOURCE.accepted` instead of one exact digest: instances
  made from an earlier image keep working while the kernel's SDK accepts what they staged, and
  operations check only the files the agent runs (`native-files.py`). Needs a kernel whose
  `@capybara-hq/plugin-sdk` lists `accepted` (the release of core#742); on an older one the device's
  support is unavailable and says why.
- ec94f5e: Device report limit values are English and Chinese text (`DeviceReportLimit.value` is
  `DeviceText` in `@capybara-hq/plugin-sdk`): device-local's limit lines read in the UI language
  and its shared directories line counts the rest as "+N more" / "；另有 N 个"; device-docker's sizes
  carry English only. device-e2b reports no limit lines and is released against the same SDK.
  
  These plugins need a kernel whose `@capybara-hq/plugin-sdk` carries `DeviceText` limit values
  (the release of core#707): an older kernel refuses their reports (string values expected), and an
  older plugin's report is refused by the newer kernel.
- d0220bc: Docker devices change their egress allowlist in place: `update` hands the egress proxy the new host
  list (wider, narrower or both) and the current `deniedCidrs` through a control socket only the
  proxy container reaches. The proxy keeps the list on the instance's config volume
  (`<name>-egress-conf`, removed with the instance), closes every connection the new list no longer
  covers, also those still resolving or connecting, and acknowledges with the list's digest; the
  sandbox container, its background processes and the connections still allowed stay. A lost proxy
  is rebuilt only from that volume (without it the instance is recreated, never rebuilt from the wider
  create-time labels). Kind changes and the empty list still recreate; instances of earlier versions
  keep the old proxy swap until their next recreate.

## 0.1.0-rc.24

### Patch Changes

- 19123cd: Device reports say how to change the device's limits (`changeHint`): device-local names the
  computer's owner and the `capybara-device ceiling set -c <device id> …` command on that computer;
  device-docker and device-e2b name the super admin's settings and the device's network setting.
  device-local's permission support names the owner (`limitedBy`) for a crossing the owner's
  ceiling keeps closed, so refusals name the owner's limit instead of the provider's, and its
  description says the owner keeps every call in the sandbox instead of "never runs outside".

## 0.1.0-rc.23

### Patch Changes

- 01eca7e: Security: the exec wrapper no longer looks up `setsid`, `timeout` or its own tools on the image's
  PATH, whose first entry (`/workspace/.cache/npm-global/bin`) the sandbox user can write. A
  planted `timeout` there could lift the in-sandbox time limit, and planted tools could defeat the
  kill scripts or run as root during a `/skills` write. `setsid` starts by absolute path (Docker) or
  through a lookup on the system PATH (E2B), `timeout` is resolved on the system PATH
  (`/usr/sbin:/usr/bin:/sbin:/bin`, root-owned) inside the wrapper, and every other provider-run
  script gets that PATH; only the user's command keeps the image's PATH (#106).

## 0.1.0-rc.22

### Minor Changes

- a19297c: Renamed from `@capybara-hq/plugin-sandbox-docker` (no alias; the version continues, so the image tags
  never collide, and the image names stay). BREAKING: provides `device-provider@1` (needs
  `@capybara-hq/plugin-sdk` `^0.1.0-rc.51` and a kernel that knows the point) instead of `sandbox@2`.
  Adds the device report (a description of the container, the cpu / memory / disk it was created with,
  files reset), the static `networkAllowlist` declaration, operation scopes with `projectRoot` and
  `writeRoots` (no read roots), and a short `device-connection` setup guide in English and Chinese.

## 0.1.0-rc.21

### Patch Changes

- 4167ef5: The image stages the runtime bytes of `@capybara-hq/plugin-sdk` 0.1.0-rc.43 (`native-files.py` now
  accepts a single-file read root; the instance-boundary path is unchanged). Rebuild the sandbox image.

## 0.1.0-rc.20

### Patch Changes

- 194154d: Approval-only profiles (core R3): the container is the sandbox. `permissionSupport` reports support v2
  (`boundary: "instance"`, `restricted: null`, `outsideSandbox: false`, network `openPublic` (off under
  `refuseOpenNetwork`), `allowlist`, no per-operation hosts). The kernel's whole-instance scope runs every
  profile on the ordinary exec and file paths behind the durable admission (a writable `/` is the whole
  instance: writable roots are also readable); a narrower filesystem grant and the escalated pair are
  refused before any effect. Limits carry no `mode`, `list` / `scan` take no limits, and the image stages
  the R3 SDK runtime bytes. The egress proxy refuses exactly the SDK's closed address classes
  (`OPEN_PUBLIC_DENIED_CIDRS`; NAT64 is now closed whatever it embeds) and re-resolves a fake-IP answer
  (198.18.0.0/15) through DNS-over-HTTPS per `SANDBOX_FAKE_IP_DNS`, never dialling the fake address. Needs
  the R3 core release (`@capybara-hq/plugin-sdk@^0.1.0-rc.39`, kernel 0.1.0-rc.55; an earlier kernel refuses
  the manifest) and a rebuilt sandbox and egress image.
  
  Security review: the instance's internal network is created with `com.docker.network.bridge.inhibit_ipv4`
  and no IPv6, so the sandbox cannot reach the Docker host's services through a bridge gateway (Docker
  Engine 25 or newer, checked on first create; an instance on an older network answers `gone` on resume and
  is recreated). With a local Docker endpoint the host's own interface addresses join the egress proxy's
  denied ranges. An operation whose network is narrower than the instance's applied network (container
  labels) is refused instead of silently widened. The agent carries no restricted launch path any more
  (`exec`, `native` and `probe` are unknown commands; `direct` refuses writable scoped roots).

## 0.1.0-rc.19

### Patch Changes

- f19313f: Moves to core R1 (`@capybara-hq/plugin-sdk` 0.1.0-rc.31, `@capybara-hq/testing` 0.1.0-rc.24). The
  image restages the SDK's restricted runtime: `linux-sandbox.py`
  (b17b714a445912508d5082598af42960df550387c4a73b379561af19b0b45c87) now mediates every write-capable
  syscall in its seccomp broker against the SDK's mandatory write denies (shell startup files,
  git-global, `.envrc`, `.npmrc`, editor and agent files, hook managers, only git's ordinary internals
  inside `.git`) and is non-dumpable; `native-files.py`
  (09a78c9bb7264ad6a1fe3b1aadd4c0f489192dc47c903c7fcc42fdf405590b42) refuses that set on roots marked
  `denyWrites: true`. The provider's agent `capybara-operation.py`
  (eb7217da155ff07842ad58333b88e5b8beecc209943e7987ef3b3c6e1fd74af3) marks its direct native roots of
  a restricted scope and a restricted background output file `denyWrites: true`. The permission
  conformance now also runs the mandatory-deny cases, the ordinary-git control and the same-uid
  supervisor check (`inspect.outside`).

## 0.1.0-rc.18

No changes in this release.

## 0.1.0-rc.17

### Minor Changes

- 6f2e3e3: Implements the permission operation contract of `sandbox@2` (plugin SDK 0.1.0-rc.28): runtime
  capabilities (`permissionSupport`), a fresh immutable operation per invocation (`operation`), owner
  browsing, trusted skill and attachment preparation, `revokeOperation` tombstones and exact
  background supervision (`start`, `status`, `tail`, `readOutput`, `stop`). Restricted work runs
  through the SDK's Linux launcher (Landlock and a seccomp notification broker on the same pinned root
  descriptors as the native helper), staged root-owned and digest-checked in the sandbox image, inside
  the existing container with unchanged hardening; Full access keeps the existing environment without
  restricted filters. A restricted allowlist reaches its hosts only through a per-operation forwarder
  in front of the instance's egress proxy. Restricted support is reported only when the launcher's
  own probe passes (validated architecture, Landlock ABI 6+, seccomp listener); otherwise restricted
  operations are refused. Requires `@capybara-hq/plugin-sdk@^0.1.0-rc.28` and the matching sandbox
  image.

### Patch Changes

- acf43de: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.27, @capybara-hq/testing 0.1.0-rc.21,
  @capybara-hq/plugin-tools 0.1.0-rc.16 and @capybara-hq/plugin-model-fake 0.1.0-rc.28 (kernel
  0.1.0-rc.37: `model-provider@2` only, model providers opt-in per org, `FetchAttachment`).

## 0.1.0-rc.16

### Minor Changes

- b48e38e: Implements the optional `list` and `scan` calls of `sandbox@2` (plugin SDK 0.1.0-rc.24), so cloud
  devices on Docker offer projects: a `python3 -I` script run in the container as the sandbox user
  lists one directory or finds project-like directories (`.git` or `AGENTS.md`), with the
  container's `/workspace` as the whole reachable area in either mode. Requires
  `@capybara-hq/plugin-sdk@^0.1.0-rc.24`.

### Patch Changes

- a6ffe5c: File calls (`readFile`, `writeFile`, `stat`) check only the path's shape; which roots they may reach
  is the kernel's, by mode. In auto mode the file tools reach any clean absolute path in the
  instance (`Read /etc/passwd` failed with "invalid sandbox path" before), as the auto mode design
  says; sandbox mode stays held to the workspace, skills and temporary roots by the kernel.

## 0.1.0-rc.15

### Patch Changes

- c516f78: The egress proxy also refuses the Azure WireServer address `168.63.129.16`, and a new deployment
  setting `deniedCidrs` (IPv4 / IPv6 CIDRs, validated) adds the deployment's own ranges to what every
  proxy refuses (`DENIED_CIDRS`). With `refuseOpenNetwork` on, an open-public instance made before the
  setting answers `gone` on resume and auto-start, so the kernel recreates it under the rule; an
  update from an allowlist to `open-public` now recreates the instance, so its labels stay truthful.
  The README states what the proxy enforces instead of "neither mode can reach the host".

## 0.1.0-rc.14

### Patch Changes

- 39ab73d: The composed Capybara icon with the plugin's function mark.
- 6c39051: The open public network is the default: `create` / `update` map `limits.network` to the egress proxy
  (`open-public`: any public host and port, with loopback, private, link-local and metadata addresses
  still refused by resolved IP; `allowlist`: the given hosts, any port). The sandbox tiers and
  `openEgress` are gone (no compatibility); the new `refuseOpenNetwork` setting refuses `open-public`
  for locked-down deployments. Needs `@capybara-hq/plugin-sdk` `^0.1.0-rc.22` and the core release that
  sends `limits.mode` / `limits.network`.

## 0.1.0-rc.13

### Patch Changes

- 2526db2: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.19 (context providers, conversation sources,
  lifecycle hooks), @capybara-hq/plugin-model-fake 0.1.0-rc.19 and @capybara-hq/testing 0.1.0-rc.17
  (pgvector test containers). No behaviour change.

## 0.1.0-rc.12

### Patch Changes

- 4210a66: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.17 (the SDK with sandbox tiers) and
  @capybara-hq/plugin-model-fake 0.1.0-rc.17. sandbox-docker and sandbox-e2b drop their local tier
  types (`SandboxTier`, `TierLimits`, `TieredSandboxLimits`, `TieredSandboxProvider`) for the SDK's
  `SandboxLimits.tier`, `update` and `limitsApplyAt`. lark and slack label the approval state
  `skipped` (the person sent a message instead of deciding).

## 0.1.0-rc.11

### Patch Changes

- 6f5eff7: Sandbox tiers (capybara-hq/core#190): `limits.tier` picks the egress proxy mode (`strict`: allowlist on
  443 / 80; `dev`: allowlist on any port plus SOCKS5, with `ALL_PROXY`, `GRPC_PROXY` and an ssh
  `GIT_SSH_COMMAND` in the container; `open`: any public host through the proxy), `dev` and `open` get
  `/dev/shm` of `min(1 GiB, memoryMb / 4)`, and the new `update` changes an instance's egress proxy in
  place or asks for a recreate (`limitsApplyAt: "instance"`). The deployment setting `allowOpenEgress`
  is replaced by `openEgress: "off" | "proxy" | "direct"` (default `proxy`; `direct` is the old shared
  bridge); an `allowOpenEgress` key now fails the config with a pointer to `openEgress`.

## 0.1.0-rc.10

### Patch Changes

- 202e2c0: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.14 and @capybara-hq/plugin-model-fake
  0.1.0-rc.14 (the new UI parts).

## 0.1.0-rc.9

### Patch Changes

- bd696b4: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.11, @capybara-hq/testing 0.1.0-rc.14,
  @capybara-hq/plugin-tools 0.1.0-rc.12 and @capybara-hq/plugin-model-fake 0.1.0-rc.11 (client
  extensions).

## 0.1.0-rc.8

### Patch Changes

- f1b7696: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.10, @capybara-hq/testing 0.1.0-rc.13 and
  @capybara-hq/plugin-tools 0.1.0-rc.11 (setup guides v2).
- fb5d4cd: Follow core's rename of environments to devices: sandbox resource names are now `cap-device-<id>` (Docker egress proxy and volumes derive from it), and the docs, error text and tests use device vocabulary.

## 0.1.0-rc.7

### Patch Changes

- 7dec2f6: Run on core plugin-sdk 0.1.0-rc.7 (testing rc.10, plugin-tools rc.8).

## 0.1.0-rc.6

### Patch Changes

- ce8d729: The plugin ships an icon (`icon.svg`): the Docker mark from Docker's media resources (source and date in the README).

## 0.1.0-rc.5

No changes in this release.

## 0.1.0-rc.4

### Minor Changes

- 62606bf: Provide `sandbox@2`. BREAKING: needs a kernel with environments and `@capybara-hq/plugin-sdk` `^0.1.0-rc.3`.
  Files now outlive instances: the workspace and skills volumes are created by `createFileSystem` (idempotent by
  name) and kept by `destroy`; `create` on missing volumes throws `FileSystemGoneError` instead of mounting empty
  ones, and `destroyFileSystem` / `destroyFileSystemByName` remove them (legacy `cap-<conversationId>` names
  too). `exec` takes a required `tag` and an `actor`. The default sandbox and egress proxy images are now the
  published `ghcr.io/capybara-hq/capybara-sandbox[-egress]:<plugin version>`; `egressProxyImage` has no schema
  default and `sandbox.image` stays optional. Both sandbox plugins now release with one version.

## 0.1.0-rc.2

### Patch Changes

- 52b3698: Kill a command's leftover processes at the in-sandbox deadline also where `timeout` is uutils
  (Ubuntu 26.04's default coreutils), which kills only its direct child.

## 0.1.0-rc.1

### Patch Changes

- 726eacb: Run on core 0.1.0-rc.4: bilingual config field labels and a display name.
