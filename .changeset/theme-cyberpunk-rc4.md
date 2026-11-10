---
"@capybara-hq/plugin-theme-cyberpunk": patch
---

Every rule now applies through `:root:has(theme token)`, so dialogs, menus, ⌘K, the properties sheet
and the drawer (portaled out of the shell) are themed too. New run effects (equalizer HUD with a
`T+` ticker, a scan beam and write head over the reply being written, a light along the composer,
brighter scanlines; a calm cyan pulse while waiting; one red glitch on failure), all transform and
opacity, off under reduced motion. The boot screen plays once per sign-in (`useSignIn()`; plugin-client
0.1.0-rc.3 is now the dev and peer dependency), lines its statuses up and ends like a CRT
switching off. The brand lays itself out by the `panel` the host passes. The tests import
`@capybara-hq/plugin-client/testing` directly; the typed component wrapper and the module-state
annotations of browser-only modules are gone (the toolchain now handles both).
HUD: localized role, "—" for counts it has not seen. Readability: brighter `faint` and `line`,
input borders at 3:1, one yellow focus colour, neon text selection, a lighter vignette, a rarer
and lighter glitch, no uppercase on primary buttons; inputs get chamfers; the theme copy says
chamfered (切角).
