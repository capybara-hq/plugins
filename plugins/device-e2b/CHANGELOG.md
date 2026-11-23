# @capybara-hq/plugin-device-e2b

## 0.1.0-rc.26

No changes in this release.

## 0.1.0-rc.25

### Patch Changes

- b2a71fc: Refuse a project directory outside the container's workspace (`/workspace`) with
  `ProjectPathRefusedError` and a fixed English and Chinese reason, in `list` / `scan` and in the
  owner browse the kernel adds projects through, before anything runs in the instance: the kernel
  answers `device.project_refused` and the device page explains the refusal when the project is
  added, instead of a run failing on it later.
- ec94f5e: Device report limit values are English and Chinese text (`DeviceReportLimit.value` is
  `DeviceText` in `@capybara-hq/plugin-sdk`): device-local's limit lines read in the UI language
  and its shared directories line counts the rest as "+N more" / "；另有 N 个"; device-docker's sizes
  carry English only. device-e2b reports no limit lines and is released against the same SDK.
  
  These plugins need a kernel whose `@capybara-hq/plugin-sdk` carries `DeviceText` limit values
  (the release of core#707): an older kernel refuses their reports (string values expected), and an
  older plugin's report is refused by the newer kernel.

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

- c3dc584: Renamed from `@capybara-hq/plugin-sandbox-e2b` (no alias; the version continues with device-docker's,
  one fixed group). BREAKING: provides `device-provider@1` (needs `@capybara-hq/plugin-sdk`
  `^0.1.0-rc.51` and a kernel that knows the point) instead of `sandbox@2`. Adds the device report (a
  description of the microVM naming the metadata-service residual, files reset), the static
  `networkAllowlist` declaration (also under `domainAllowlist: false`, which degrades to no network),
  operation scopes with `projectRoot` and `writeRoots` (no read roots), and a short
  `device-connection` setup guide in English and Chinese.

## 0.1.0-rc.21

No changes in this release.

## 0.1.0-rc.20

### Patch Changes

- 194154d: Approval-only profiles (core R3): the microVM is the sandbox. `permissionSupport` reports support v2
  (`boundary: "instance"`, `restricted: null`, `outsideSandbox: false`, network `openPublic`, `allowlist`
  (off when `domainAllowlist` is), no per-operation hosts). The kernel's whole-instance scope runs every
  profile (a writable `/` is the whole instance: writable roots are also readable); a narrower filesystem
  grant and the escalated pair are refused before any effect. Limits carry no `mode` (the "limits carry no
  mode" error is gone), `list` / `scan` take no limits, `open-public` denies every closed IPv4 class of the
  SDK table (metadata, multicast, reserved and the fake-IP range too; the MMDS residual stays), and the
  runtime directory is named after every staged file, so new SDK bytes stage a fresh one. Needs the R3 core
  release (`@capybara-hq/plugin-sdk@^0.1.0-rc.39`, kernel 0.1.0-rc.55; an earlier kernel refuses the
  manifest).
  
  Security review: an operation whose network is narrower than the VM's applied policy (read from `GET
  /sandboxes/{id}`) is refused instead of silently widened; an open-public VM made with an earlier, shorter
  deny list gets the current policy re-applied on resume and on the next operation (a failed re-apply is
  retried; a failed `update` answers `recreate`), so no device is left refusing every command. The README
  records the live findings for `0.0.0.0/8` and the MMDS fields.

## 0.1.0-rc.19

### Patch Changes

- f19313f: Moves to core R1 (`@capybara-hq/plugin-sdk` 0.1.0-rc.31, `@capybara-hq/testing` 0.1.0-rc.24); the
  VM stages the new SDK runtime files on first use. The provider still ships Full access only, a known
  limitation accepted by the maintainers: the tested template's kernel has Landlock ABI 2, below the
  launcher's ABI 6, so restricted profiles are reported unavailable and refused before any effect;
  the README says so.

## 0.1.0-rc.18

### Minor Changes

- 2186c54: Implements the permission operation contract of `sandbox@2` (plugin SDK 0.1.0-rc.28):
  `permissionSupport`, a fresh immutable operation per invocation (`operation`), owner browsing,
  trusted skill and attachment preparation, `revokeOperation` tombstones and exact background
  supervision (`start`, `status`, `tail`, `readOutput`, `stop`) for Full access. The provider stages
  its operation runtime (the SDK native helper and launcher, plus its own agent) in the VM as root,
  digest-checked, and keeps root-owned records on the VM's disk. Restricted profiles are reported
  unavailable with the template's own facts: the SDK launcher needs Landlock ABI 6, and the tested E2B
  template runs Linux 6.1 with Landlock ABI 2; restricted grants are refused
  before any effect, never widened to Full access. Full access keeps the VM's OS user, environment
  and network; no conversation grant updates the VM network. Requires
  `@capybara-hq/plugin-sdk@^0.1.0-rc.28`.

## 0.1.0-rc.17

### Patch Changes

- acf43de: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.27, @capybara-hq/testing 0.1.0-rc.21,
  @capybara-hq/plugin-tools 0.1.0-rc.16 and @capybara-hq/plugin-model-fake 0.1.0-rc.28 (kernel
  0.1.0-rc.37: `model-provider@2` only, model providers opt-in per org, `FetchAttachment`).

## 0.1.0-rc.16

### Minor Changes

- b48e38e: Implements the optional `list` and `scan` calls of `sandbox@2` (plugin SDK 0.1.0-rc.24), so cloud
  devices on E2B offer projects: the same `python3 -I` script as the Docker plugin runs in the
  sandbox as the sandbox user, with `/workspace` as the whole reachable area in either mode. A
  template without python3 gets a clear error. Requires `@capybara-hq/plugin-sdk@^0.1.0-rc.24`.

### Patch Changes

- a6ffe5c: File calls (`readFile`, `writeFile`, `stat`) check only the path's shape; which roots they may reach
  is the kernel's, by mode. In auto mode the file tools reach any clean absolute path in the
  instance (`Read /etc/passwd` failed with "invalid sandbox path" before), as the auto mode design
  says; sandbox mode stays held to the workspace, skills and temporary roots by the kernel.

## 0.1.0-rc.15

### Patch Changes

- b0513d0: Map `open-public` instead of refusing it: internet access (`allow_internet_access: true`) with
  `denyOut` of the private, loopback, CGNAT and link-local ranges (`10/8`, `172.16/12`, `192.168/16`,
  `127/8`, `169.254/16`, `100.64/10`, `fc00::/7`, `fe80::/10`, `::1/128`), at create and through the
  live network update, so auto mode runs on E2B. The E2B metadata service (MMDS, `169.254.169.254`)
  stays reachable inside the sandbox whatever `denyOut` says, under an allowlist too; the README and
  the manifest now state it as a residual E2B exposure in both modes.

## 0.1.0-rc.14

### Patch Changes

- 39ab73d: The composed Capybara icon with the plugin's function mark.
- 01e0afd: Map `limits.network` to E2B's network policy (an allowlist, or no network) and refuse `open-public`:
  E2B cannot block the sandbox's metadata endpoint even with `denyOut`, so the plugin never opens the
  network. The `openEgress` / `allowOpenEgress` settings are gone, and an older kernel's `tier` /
  `egress` limits are refused instead of guessed. The allowlist's `denyOut` also carries the IPv6
  loopback, link-local and unique-local ranges.
  
  Existing E2B devices created with the open network will fail on their next create / update after
  the upgrade: the provider now refuses `open-public`, and auto mode always carries it. Move the org's
  cloud network to an allowlist, or run the device on the Docker provider.

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

- 0702689: Sandbox tiers: the setting `openEgress: "off" | "proxy" | "direct"` (default `"proxy"`) replaces
  `allowOpenEgress` (the old key fails with a pointer to it); on E2B `"proxy"` and `"direct"` both mean
  plain internet access. `limitsApplyAt: "fileSystem"` and `update`, which resumes the sandbox and
  replaces its egress through `PUT /sandboxes/{id}/network`, so a tier change no longer needs a file
  reset.

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

- ce8d729: The plugin ships an icon (`icon.svg`): the E2B symbol from the E2B brand page (source and date in the README).

## 0.1.0-rc.5

### Patch Changes

- 835f3e8: Kill a command's children that left its session. Every exec carries `CAPYBARA_EXEC=<control file>`, and the kill
  scripts (timeout, abort, `killTagged`, `killAll`, the in-sandbox deadline) also SIGKILL the processes whose
  environment has it; when some are still there, the sandbox reboots. Real envd ends the output stream when the
  command exits, so before this a `setsid` child kept running and the reboot fallback never fired. README: a paused
  sandbox's network rules cannot be changed (verified on E2B).

## 0.1.0-rc.4

### Minor Changes

- 62606bf: Provide `sandbox@2`. BREAKING: needs a kernel with environments and `@capybara-hq/plugin-sdk` `^0.1.0-rc.3`.
  Files now outlive instances: `createFileSystem` makes a sandbox that is paused without memory and is the file
  system, `destroy` / `suspend` only pause it, `create` reconnects it and throws `FileSystemGoneError` when E2B
  reports it gone, and `destroyFileSystem*` delete it (legacy names too). The `template` setting is now
  optional: when empty, a template is built from the published image
  `ghcr.io/capybara-hq/capybara-sandbox:<plugin version>` under the non-public alias `capybara-sandbox-<tag>`
  and the build status is polled until ready. Both sandbox plugins now release with one version.

## 0.1.0-rc.3

### Patch Changes

- 77392eb: A stopped or timed-out command's process stream now ends at once. An abort of the request alone sometimes left a body that was already being read untouched under load, so a command that had to be recovered by a reboot waited until its last process closed the output.

## 0.1.0-rc.2

### Patch Changes

- 52b3698: Kill a command's leftover processes at the in-sandbox deadline also where `timeout` is uutils
  (Ubuntu 26.04's default coreutils), which kills only its direct child.

## 0.1.0-rc.1

### Patch Changes

- 726eacb: Run on core 0.1.0-rc.4: bilingual config field labels and a display name.
