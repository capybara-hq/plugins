# @capybara-hq/plugin-sandbox-e2b

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
