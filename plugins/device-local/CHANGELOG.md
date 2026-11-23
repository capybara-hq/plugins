# @capybara-hq/plugin-device-local

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
