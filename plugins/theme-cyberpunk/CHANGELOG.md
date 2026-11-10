# @capybara-hq/plugin-theme-cyberpunk

## 0.1.0-rc.3

### Patch Changes

- 56efcf9: Keep a gap between the active conversation's bar and its title, and drop the user message bar that
  sat far from the bubble.

## 0.1.0-rc.2

### Patch Changes

- 5954f9e: Client components, overlays and a suggested appearance (UI customization L1-L3): a run-state HUD in
  the conversation properties panel with an opt-in synthesized sound toggle, scanlines and a
  once-per-session boot screen over the workspace, a glitch CYBERBARA wordmark for the sidebar brand,
  a cyberpunk new-conversation hero, chamfered parts and run-state colours in plugin CSS, all scoped
  to the cyberpunk theme and honouring reduced motion. `suggestedAppearance` names the theme and the
  `shell.brand` / `conversation.empty` replacements. Built against @capybara-hq/plugin-sdk
  0.1.0-rc.11, @capybara-hq/plugin-client 0.1.0-rc.1 and @capybara-hq/plugin-tools 0.1.0-rc.12.

## 0.1.0-rc.1

### Patch Changes

- f1b7696: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.10, @capybara-hq/testing 0.1.0-rc.13 and
  @capybara-hq/plugin-tools 0.1.0-rc.11 (setup guides v2).
