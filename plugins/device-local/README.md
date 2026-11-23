# @capybara-hq/plugin-device-local

Devices on people's own computers (`device-provider@1` over the kernel's dial-in channel). A machine
signs in with [`capybara-device`](https://www.npmjs.com/package/@capybara-hq/device) (protocol
`capybara-device/6`, declared as `permissions.dialIn`) and serves one device; every operation of the
device is relayed to it through `ctx.dialIn`. The kernel holds the machine's socket and relays the
frames without reading them; this plugin checks every request before it is sent and parses every
answer strictly (the machine is not trusted).

## How the provider maps the device lifecycle

| Kernel call | On the machine |
|---|---|
| `createFileSystem` / `destroyFileSystem` | Nothing on the machine: the device directory (`~/capybara-device/<device id>`) belongs to the machine's owner and stays when the device is deleted; `destroyFileSystem` forgets the device's rows |
| `create` | `create` (ends the previous generation's background work, answers the directory's roots), then `bindInstance` of a new instance generation; the handle is handed out only once the machine attested the binding |
| `resume` | Needs the machine online. `create` again (ends any background work a suspension could not reach), then the identical `bindInstance`; `gone` when the roots changed (a new login into another directory or mode) or the machine can no longer hold the generation (its runtime changed) |
| `suspend` / `destroy` | `create` when the machine is online: the generation's tracked background work ends, files are kept. Never fails while the machine is offline |
| `operation` / `prepare` / `browse` / `background` / `revokeOperation` | The scoped protocol 6 operations, each with its admitted scope |
| raw `exec` / `readFile` / … , `killAll` / `killTagged` | Refused or nothing: a protocol 6 machine runs work only under an admitted operation scope |

A command carries the instance's resources and, as its outer network, the network the kernel
admitted for the operation (its scope); the machine intersects it with its owner's ceiling. The
machine's report of refused hosts is passed on as given, except that a host it calls its own that
is a wildcard or no valid host name is reported as an address; whether a refused host can be
granted for a call, and by whom, is the kernel's decision.

Reads, output reads and tails are sized by the connection's negotiated frame capacity
(`ctx.dialIn.capacity`: the smaller of the machine's and the deployment's
`CAPYBARA_DEVICES__DIAL_IN__MAX_FRAME_BYTES`), read before each request; a write that cannot fit
one frame is refused with a hint to write smaller parts. No capacity (no machine holds the device)
is the device being offline.

## Hello, owner report and device report

The machine is not trusted. Every hello and event body is parsed strictly (`parseDeviceFrame`);
a hello that does not parse, names a generation this provider never bound, or names the installed
generation under another runtime identity is refused (`local.invalid_hello`,
`local.identity_mismatch`) and nothing is stored. The plugin keeps one row per device in its schema
`plugin_device_local`: `connections` (the last accepted hello and the owner report) and `bindings`
(the current instance generation and what the machine attested when it installed it).

- **Owner report.** The owner's ceiling arrives with the hello, a `policy` event and each binding
  answer, under one rule: a higher sequence is recorded, the same report again changes nothing, a
  stale one is ignored, a conflicting one blocks the facts (run as narrowly as possible) until a
  valid one arrives. The same machine's hello whose report is stale or conflicting is refused
  (`local.stale_owner_report`, `local.owner_report_conflict`) and nothing is recorded.
- **Machine.** Every hello, event and close names the kernel's machine id (the signed-in
  credential) and connection id. A hello from another machine than the recorded one (another
  `capybara-device login`, on this computer or another) gets a fresh record: its owner report is
  recorded as is, the machine epoch moves on and it never attests the installed binding. A
  `replaced` close changes nothing by itself (it names the old machine both for a takeover by the
  same machine and for another machine's sign-in): the next hello tells them apart. A `revoked`
  close of the recorded machine moves the epoch. Events of any connection other than the recorded
  one are dropped.
- **Attestation.** An unbound hello (the program restarted, typically under a new runtime after an
  upgrade) marks the installed binding unattested: the instance is gone and the kernel recreates
  it, which binds a new generation.
- **`report()`** answers from the rows only: a description of the owner's ceiling (project reach
  `machine` / `paths` / `workspace`, always `workspace` in Docker mode; outside the sandbox;
  network) in English and Chinese, the owner's home (OS mode), the machine's own
  narrowing as read-only limits, `reset: false` and `changeHint`: only the computer's owner changes
  the limits, on that computer, with `capybara-device ceiling set -c <device id> …` (the
  connection's real id). Its revision is a hash of everything it is made
  of plus the machine epoch (moved when the machine is revoked or replaced), the instance
  generation, its runtime identity and its stored support; times and connection ids are left out,
  so a reconnect with the same facts keeps it. After a hello or event moved the revision the
  provider calls `ctx.devices.reportChanged`; after a create or resume the kernel reads the report
  again itself.
- **Shared project directories.** The machine's policy summary (hello and `policy` event) may carry
  `sharedProjectRoots`: this connection's project directories another connection on the same
  computer also uses, only those the owner listed in this connection's `projectPaths`, never naming
  the other connection. The report lists them as "Also used by another connection on this
  computer" (no line when none, or from an older device). They are left out of the revision: the
  kernel moves the device authority epoch on every new revision and they change nothing the device
  may do, so a change calls `ctx.devices.reportChanged` once with the revision kept and the kernel
  stores the new text without invalidating approvals. A stale or conflicting `policy` event never
  changes them; an unreadable summary, or an unreadable list in a readable one, keeps them. The
  line fits as many whole directories as it can, skipping one too long, then ` +N` for the rest.
- **Refused project paths.** A machine's `project_refused` outcome becomes
  `ProjectPathRefusedError` with the fixed English and Chinese text of its refusal code
  (`other-connection`, `outside-reach`, `denied`; `PROJECT_REFUSAL_TEXT`): the machine is not
  trusted, so its message text never reaches the person.
- **`permissionSupport()`** answers from the rows only, never a machine round trip: the support the
  machine attested for the installed binding, with outside-the-sandbox and the open public
  internet narrowed to what the owner allows now (no open public internet while the owner's
  network is an allowlist or the owner facts are blocked or missing), and `limitedBy` naming the
  owner for each crossing the machine attested but the owner keeps closed (so the kernel names the
  owner's limit, not the provider's); closed when no binding is installed or no hello is stored.

A handle the machine will never serve again (the device's binding is a newer generation, or the
machine's last hello did not attest it) still reads its installed support, because the kernel
records support as evidence before a use and never treats a failed read as gone; its operations
answer `SandboxGoneError` before anything reaches the machine. That check runs in the calls that
start work (`operation`, `prepare`, `browse`, `background.start`); the calls about existing work
(`background` status, output reads, tails, stops, `revokeOperation`) go to the machine, which
refuses a generation it does not hold. A binding answer is installed only while the stored
connection record still names the machine and connection the request was sent through, so a late
answer of a replaced machine never re-attests the old generation or records its owner report. The kernel keeps such a dispatched
call's outcome unknown and rebuilds the instance, which binds a new generation; the next call runs
on it.

## Connecting a computer

The member guide `guides/connect.md` (place `device-connection`): `npm install -g @capybara-hq/device@next`,
`capybara-device login --url <deployment>`, then `capybara-device service install -c <device id>`
(it also starts the service; or `capybara-device start -c <device id>` in the foreground). Dial-in limits are the kernel's
`CAPYBARA_DEVICES__DIAL_IN__*` settings.

## Existing local devices

Local devices made before this plugin stay bound to the kernel's old `@local` provider and read as
unavailable. Their owners delete them and connect the computer again with `capybara-device login`,
choosing this provider.

## Tests

`test/e2e.test.ts` runs the published `capybara-device` (installed from npm into a temporary
directory: rc.28 unless `CAPYBARA_TEST_DEVICE_LOCAL_E2E_VERSION` names another) against a kernel
with this plugin, only with `CAPYBARA_TEST_DEVICE_LOCAL_E2E=1` (Docker for the test containers):
sign-in through the code flow, a `Bash` call, a restart that keeps the binding and one under a
changed runtime that is rebound, another machine replacing the first, revocation and a new login,
and deletion. Each program runs under a temporary `HOME` and `XDG_CONFIG_HOME`.
