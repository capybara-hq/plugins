# @capybara-hq/plugin-sandbox-e2b

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
