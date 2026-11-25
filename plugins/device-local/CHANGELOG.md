# @capybara-hq/plugin-device-local

## 0.1.0-rc.12

### Patch Changes

- 2c090d8: A service's status passes on the machine's `filesDigest` (the files a running service was started
  from), so a kernel with capybara-hq/core#875 restarts a service whose extension was upgraded.
  Harmless with an older kernel or capybara-device (the field is ignored or absent).

## 0.1.0-rc.11

### Patch Changes

- 978a402: `resume` answers `gone` at once, without any machine round trip, when the machine's hello did not
  attest the instance's binding: its program restarted unbound, typically after an upgrade to
  another runtime. The kernel then recreates the instance right away instead of first sending the
  machine a `create` and a `bindInstance` that can only end in `gone`.
- 8eed389: Device services run as their own user (plugins#210): device-docker and device-e2b start the service manager, every service and
  the socket relay as `capybara-svc` (uid 1100), with its state under `/var/lib/capybara/svc` and its sockets under
  `/run/capybara-svc`, both private to that user, so agent commands (the sandbox user) can neither read a browser profile nor reach a
  service's socket or process. Services are keyed by their id `<extension>.<name>` (core#817). The sandbox image ships the browser
  plugin's pinned Chromium (full build) read only in `/opt/capybara-browsers` (plugins#209); device-docker moves service state to a
  new `<name>-services` volume and removes the old `-svc` one; device-e2b prepares the user on VMs from older templates.
  device-docker recreates (answers `gone` on resume for) instances made before isolated services; device-e2b kills the old services
  on VMs from older templates; device-local answers a machine older than service ids with "update capybara-device".

## 0.1.0-rc.10

### Patch Changes

- 1b49dd8: device-local implements `update`: a widened network (the browser panel's 允许) is stored with the
  instance generation, fenced by the kernel's token, and the next service ensure sends it, so the
  machine restarts a running browser with the new network instead of the kernel recreating the
  instance and stopping every service. A narrowing still recreates.

## 0.1.0-rc.9

### Patch Changes

- e13edb3: Serve device services and streams: `ensureService`, `stopService`, `serviceStatus`, `serviceRequest` and `openStream` forward to the connected machine over the dial-in channel. A status keeps the machine's `codeDir`; an `ifRunning` ensure sends only the service name and is never retried with files; files are encoded only when the machine asks for them and refused with an actionable error when they exceed the connection's frame capacity.

## 0.1.0-rc.8

### Patch Changes

- 64d564f: Repacked with the core#720 toolchain (plugin-sdk 0.1.0-rc.64): the package's static manifest no
  longer carries the removed `config.org` list. No behaviour change.

## 0.1.0-rc.7

### Patch Changes

- ec94f5e: Device report limit values are English and Chinese text (`DeviceReportLimit.value` is
  `DeviceText` in `@capybara-hq/plugin-sdk`): device-local's limit lines read in the UI language
  and its shared directories line counts the rest as "+N more" / "；另有 N 个"; device-docker's sizes
  carry English only. device-e2b reports no limit lines and is released against the same SDK.
  
  These plugins need a kernel whose `@capybara-hq/plugin-sdk` carries `DeviceText` limit values
  (the release of core#707): an older kernel refuses their reports (string values expected), and an
  older plugin's report is refused by the newer kernel.

## 0.1.0-rc.6

### Patch Changes

- 19123cd: Device reports say how to change the device's limits (`changeHint`): device-local names the
  computer's owner and the `capybara-device ceiling set -c <device id> …` command on that computer;
  device-docker and device-e2b name the super admin's settings and the device's network setting.
  device-local's permission support names the owner (`limitedBy`) for a crossing the owner's
  ceiling keeps closed, so refusals name the owner's limit instead of the provider's, and its
  description says the owner keeps every call in the sandbox instead of "never runs outside".

## 0.1.0-rc.5

### Patch Changes

- 8bd45b9: The connect guide's step 3 names the device: `capybara-device service install -c <device id>`
  (the command `login` prints; it also starts the service) instead of a bare `service install` and
  `service start`, which fail once the computer has a second connection. The `ceiling` commands in
  the guide carry `-c <device id>` too.
  
  The guide is the terminal steps only: the desktop app no longer connects local devices, so the
  `connect-this-machine` shell action and the sentences about the app are gone.

## 0.1.0-rc.4

### Patch Changes

- 8f87fa1: Keeps the shown shared project directories when a policy event's `sharedProjectRoots` list is
  unreadable (malformed or too long) in an otherwise readable summary, as an unreadable summary
  already did. The "Also used by another connection" line now fits as many whole directories as it
  can, skipping one too long, and counts the rest as a language-neutral ` +N` instead of English
  ` +N more`.

## 0.1.0-rc.3

### Patch Changes

- 1506892: Shows the project directories shared on the machine: the device report lists "Also used by another
  connection on this computer" with the directories the machine reports as `sharedProjectRoots` in
  its policy summary (only those the owner listed for this connection, never naming the other
  connection). A change tells the kernel once and keeps the report revision, so it never moves the
  device authority epoch. Needs plugin-sdk 0.1.0-rc.58.

## 0.1.0-rc.2

### Minor Changes

- 08f8fab: Project reach machine|paths|workspace and refusals; device protocol 6: the report describes and
  lists the connection's project reach, and a machine's `project_refused` outcome becomes
  `ProjectPathRefusedError` with fixed English and Chinese text for its code, never the machine's
  message.

## 0.1.0-rc.1

### Minor Changes

- 740714e: New plugin: the local device as a `device-provider@1` over the kernel's dial-in channel
  (`permissions.dialIn` `capybara-device/5`, needs `@capybara-hq/plugin-sdk` `^0.1.0-rc.56` and kernel
  rc.71). A computer signs in with `capybara-device` and serves one device; every operation is a
  protocol 5 body relayed through `ctx.dialIn`, sized by the connection's negotiated frame capacity.
  Hello, owner report, report revision and permission support come from the plugin's own rows
  (`plugin_device_local`); the connection guide (`device-connection`) tells members how to connect.
  Local devices from before stay bound to `@local`: delete and reconnect them.
