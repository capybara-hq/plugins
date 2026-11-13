# @capybara-hq/plugin-memory

## 0.1.0-rc.1

### Patch Changes

- 81c20dd: The memory page's choices use the design system's dropdown (the client API's `Select`) instead of
  the browser's; the search field is one box whose focus ring goes round the icon and the input; a
  全屏 button takes the page to the browser's fullscreen; and a selection with no memories shows a
  compact empty state without the search, the view toggle or the fit control. Built against
  @capybara-hq/plugin-client 0.1.0-rc.5, whose client API adds `Select`.
