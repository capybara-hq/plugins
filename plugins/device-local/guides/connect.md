# Connect this machine

A device on your own computer: the computer connects to the platform with the `capybara-device`
program and serves the device, and you limit what it may do there. Run these steps in a terminal on the
computer you want to connect (macOS or Linux, Node 22.12 or newer; on Windows use WSL).

## 1. Install the program

```bash title="Install capybara-device"
npm install -g @capybara-hq/device@next
```

## 2. Sign in

```bash title="Sign in to this platform"
capybara-device login --url {{publicUrl}}
```

The command opens a page in your browser (with `--no-browser` it prints the address and a code to
enter on any signed-in browser). There, pick the organization, choose **This machine** and a new
device, or one of your connected devices to move it to this computer. Signing in again from
another computer into the same device replaces the first one.

## 3. Keep it online

```bash title="Connect at login (recommended)"
capybara-device service install -c <device id>
```

This is the command `login` printed at its end, with your device id: it installs the service,
starts it right away and connects again at every login. Or run
`capybara-device start -c <device id>` to connect in the foreground until you stop it. The device
shows as online once the program is connected; while it is offline, agents cannot use it.

**If this computer is already connected elsewhere.** Each device this computer serves is one
connection, kept under its device id, with its own service. Choosing a new device in the browser, or
moving a device here from another computer, adds a connection; signing in again to a device this
computer already serves keeps its connection (only the sign-in is renewed; then run
`capybara-device service restart -c <device id>` if its service is installed). With more than one
connection every command needs `-c <device id>` (or the device name or host, when it is unique);
with only one, `-c` may be left out. `capybara-device status` lists the connections with their ids,
and `login` prints the exact next command, id included, at its end.

## What it may do

Commands run in a sandbox on your computer, inside the device's directory
(`~/capybara-device/<device id>`). You set the owner ceiling on the computer:
`capybara-device ceiling show -c <device id>` shows it, `capybara-device ceiling set -c <device id>`
changes it (running outside the sandbox, the network, project reach); each connection has its own. The organization's and the platform's settings apply as
well; the narrowest wins. In OS mode commands run as your user with no CPU or memory limits.

Deleting the device revokes the computer's sign-in and stops the program; the files stay on your
computer.

## Devices from before this provider

Local devices created before this provider stay bound to the old built-in `@local` provider and are
unavailable. Delete such a device and connect the computer again with the steps above.
