# @capybara-hq/plugin-theme-cyberpunk

## 0.1.0-rc.10

### Patch Changes

- 2526db2: Build and test against @capybara-hq/plugin-sdk 0.1.0-rc.19 (context providers, conversation sources,
  lifecycle hooks), @capybara-hq/plugin-model-fake 0.1.0-rc.19 and @capybara-hq/testing 0.1.0-rc.17
  (pgvector test containers). No behaviour change.

## 0.1.0-rc.9

### Patch Changes

- f5beaba: The page no longer shows before the boot screen: on the first workspace document of a sign-in
  (`sign-in=new`) the boot backdrop covers the shell from the first paint until the boot component is
  in.

## 0.1.0-rc.8

### Patch Changes

- f147822: No glowing write head under the reply being written; the scan beam over it stays.

## 0.1.0-rc.7

### Patch Changes

- e4ebe8d: Drop the run-colour line on the properties panel's edge: the cards' chamfered corners showed it as
  stray ticks between the sections. The run HUD keeps its own status bar.

## 0.1.0-rc.6

### Patch Changes

- a30c005: Drop the line under the sidebar brand row: it sat tight under the logo and did not line up with the
  title bar's bottom edge.
- b9d1a4c: Calmer runs: the band of light that swept down the whole screen while a run goes is gone, and so
  is the brightening of the scanlines; the scanlines and the vignette stay static. The title bar
  light, the HUD equalizer and `T+` timer, the beam and write head on the reply being written and
  the composer light stay. Focus rings next to the reply or in the composer are no longer clipped
  while those effects run (`overflow-clip-margin`). The README states the requirement: core
  0.1.0-rc.19 or later (`@capybara-hq/plugin-client` ^0.1.0-rc.4).

## 0.1.0-rc.5

### Patch Changes

- 8f940a3: Every rule now applies through `:root:has(theme token)`, so dialogs, menus, ⌘K, the properties sheet
  and the drawer (portaled out of the shell) are themed too. New run effects, all transform and
  opacity and off under reduced motion: an equalizer HUD with a `T+` ticker, a light along the title
  bar edge, brighter scanlines, and on the parts themselves a scan beam and write head over the
  reply being written (`message.assistant` with `aria-busy`) and a light along the composer; a calm
  cyan pulse while waiting; one red glitch on failure. Nothing is measured from script, and modals
  cover the effects. The boot screen plays once per sign-in (`useSignIn()`; plugin-client 0.1.0-rc.3
  is the dev and peer dependency, so it needs a host with core #156), lines its statuses up and ends
  like a CRT switching off. The brand lays itself out by the `panel` the host passes. New parts get
  the look: chamfered user bubbles, code blocks, menus, stat cards, segmented controls, agent chips,
  switches (square knob that reads when off) and the org initial (a neon tag); the selected agent
  chip has a neon edge. HUD: localized role, "—" for counts it has not seen. Readability: brighter
  `faint` and `line`, input borders at 3:1 or more on page, panel and raised grounds, one yellow
  focus colour, neon text selection, a lighter vignette, a rarer and lighter glitch, no uppercase on
  primary buttons; the theme copy says chamfered (切角).

## 0.1.0-rc.4

### Patch Changes

- 537d89e: Polish: every chamfered part (buttons of every variant, cards, sections, dialogs, the composer, the
  boot screen) is bevelled with `corner-shape: bevel`, so borders and focus rings follow the diagonal
  instead of stopping at a clipped corner. The run-state edges are soft: the title bar's bottom edge
  fades out toward both ends with a slow bright segment sweeping along it during a run (static under
  reduced motion), the properties panel edge matches, and the waiting composer gets a soft line and
  glow. The favicon / plugin icon has a transparent ground and the logo's cyan offset.

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
