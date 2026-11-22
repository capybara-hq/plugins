# Connect this machine

::shell-action connect-this-machine Connect this machine

A device on your own computer: the computer connects to the platform with the `capybara-device`
program and serves the device, and you limit what it may do there. In the desktop app, the button
above connects the computer it runs on. Anywhere else, run these steps in a terminal on the
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
capybara-device service install
capybara-device service start
```

Or run `capybara-device start` to connect in the foreground until you stop it. The device shows as
online once the program is connected; while it is offline, agents cannot use it.

## What it may do

Commands run in a sandbox on your computer, inside the device's directory
(`~/capybara-device/<device id>`). You set the owner ceiling on the computer:
`capybara-device ceiling show` shows it, `capybara-device ceiling set` changes it (running outside
the sandbox, the network, project reach). The organization's and the platform's settings apply as
well; the narrowest wins. In OS mode commands run as your user with no CPU or memory limits.

Deleting the device revokes the computer's sign-in and stops the program; the files stay on your
computer.

## Devices from before this provider

Local devices created before this provider stay bound to the old built-in `@local` provider and are
unavailable. Delete such a device and connect the computer again with the steps above.
