# @capybara-hq/plugin-file-preview

## 0.1.0-rc.5

### Patch Changes

- a7a93b4: The browser panel and the file previewer paint no ground of their own before the host's `init`:
  it was the light `Canvas` colour whatever the host's theme, so the embed flashed white in the
  dark theme before its tokens arrived. Transparent, the host's pane shows through until then.

## 0.1.0-rc.4

### Patch Changes

- 64d564f: Repacked with the core#720 toolchain (plugin-sdk 0.1.0-rc.64): the package's static manifest no
  longer carries the removed `config.org` list. No behaviour change.

## 0.1.0-rc.3

### Patch Changes

- 5aa3c09: Drop the `html` previewer: the kernel's built-in previewer renders HTML (full rendering, CDN
  allowlist) since capybara 0.1.0-rc.52 (kernel 0.1.0-rc.46).

## 0.1.0-rc.2

### Patch Changes

- c709672: The preview shell draws scrollbars as the host theme's thumb (`--cb-scroll-thumb`) on a transparent
  track, as the host does, so a dark theme no longer shows a light scrollbar track.

## 0.1.0-rc.1

### Patch Changes

- c0c15ff: THIRD-PARTY-LICENSES.txt now covers the whole production dependency closure of the prebuilt
  bundles (exceljs, JSZip), not only their direct dependencies.
