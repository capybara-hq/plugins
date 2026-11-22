# @capybara-hq/plugin-device-local

Devices on people's own computers (`device-provider@1` over the kernel's dial-in channel). A machine
signs in with [`capybara-device`](https://www.npmjs.com/package/@capybara-hq/device) (protocol
`capybara-device/5`, declared as `permissions.dialIn`) and serves one device; every operation of the
device is relayed to it through `ctx.dialIn`. The kernel holds the machine's socket and relays the
frames without reading them; this plugin checks every request before it is sent and parses every
answer strictly (the machine is not trusted).

## How the provider maps the device lifecycle

| Kernel call | On the machine |
|---|---|
| `createFileSystem` / `destroyFileSystem` | Nothing: the device directory (`~/capybara-device/<device id>`) belongs to the machine's owner and stays when the device is deleted |
| `create` | `create` (ends the previous generation's background work, answers the directory's roots), then `bindInstance` of a new instance generation; the handle is handed out only once the machine attested the binding |
| `resume` | Needs the machine online. `create` again (ends any background work a suspension could not reach), then the identical `bindInstance`; `gone` when the roots changed (a new login into another directory or mode) or the machine can no longer hold the generation (its runtime changed) |
| `suspend` / `destroy` | `create` when the machine is online: the generation's tracked background work ends, files are kept. Never fails while the machine is offline |
| `operation` / `prepare` / `browse` / `background` / `revokeOperation` | The scoped protocol 5 operations, each with its admitted scope |
| raw `exec` / `readFile` / … , `killAll` / `killTagged` | Refused or nothing: a protocol 5 machine runs work only under an admitted operation scope |

A command carries the instance's resources and, as its outer network, the network the kernel
admitted for the operation (its scope); the machine intersects it with its owner's ceiling. A host
the machine reports as refused by its own policy that the carried network does not allow is
reported as refused by the org (only an admin can lift it).

Reads are sized for the kernel's default frame limit (16 MiB,
`CAPYBARA_DEVICES__DIAL_IN__MAX_FRAME_BYTES`); a deployment that lowers it gets the machine's
"exceeds negotiated capacity" refusal for larger reads.

## Existing local devices

Local devices made before this plugin stay bound to the kernel's old `@local` provider and read as
unavailable. Their owners delete them and connect the computer again with `capybara-device login`,
choosing this provider.
