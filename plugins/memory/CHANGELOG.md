# @capybara-hq/plugin-memory

## 0.1.0-rc.8

### Patch Changes

- 64d564f: Repacked with the core#720 toolchain (plugin-sdk 0.1.0-rc.64): the package's static manifest no
  longer carries the removed `config.org` list. No behaviour change.

## 0.1.0-rc.7

### Patch Changes

- d8fe7ba: Re-embed memories when the org's `memory.embed` model switches back to a model used before. The
  `memory-embed` job id now carries the target model and a per-memory embedding version (new column
  `embedding_version`, migration 0002), so it never collides with a job the queue still retains.

## 0.1.0-rc.6

### Patch Changes

- 1f8ff38: Model-facing text states mechanisms only: neutral example paths
  (`feedback/code-review-style.md`, `project/billing/q3-migration.md`), no "counts as a recall"
  lines, the write tool no longer repeats the memory guidance, the description limit error says
  "at most 200", and the refusal outside a one-to-one conversation says the call was refused (no "do not call").

## 0.1.0-rc.5

### Patch Changes

- acf43de: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.27, @capybara-hq/testing 0.1.0-rc.21,
  @capybara-hq/plugin-tools 0.1.0-rc.16 and @capybara-hq/plugin-model-fake 0.1.0-rc.28 (kernel
  0.1.0-rc.37: `model-provider@2` only, model providers opt-in per org, `FetchAttachment`).

## 0.1.0-rc.4

### Patch Changes

- a53a23f: On the memory page in fullscreen, one Escape does one thing: closing the open memory panel (from
  the graph) or a dropdown no longer also leaves fullscreen; the next Escape, with nothing open,
  leaves it.

## 0.1.0-rc.3

### Patch Changes

- 40cc3be: The memory page's 全屏 button fills the browser tab as an overlay of the web page instead of taking
  the display's fullscreen: the tab and the browser stay, Escape leaves it, and the page keeps its
  toolbar and panels.

## 0.1.0-rc.2

### Patch Changes

- 39ab73d: The composed Capybara icon with the plugin's function mark.

## 0.1.0-rc.1

### Patch Changes

- 81c20dd: The memory page's choices use the design system's dropdown (the client API's `Select`) instead of
  the browser's; the search field is one box whose focus ring goes round the icon and the input; a
  全屏 button takes the page to the browser's fullscreen; and a selection with no memories shows a
  compact empty state without the search, the view toggle or the fit control. Built against
  @capybara-hq/plugin-client 0.1.0-rc.5, whose client API adds `Select`.
