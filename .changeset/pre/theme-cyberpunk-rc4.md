---
"@capybara-hq/plugin-theme-cyberpunk": patch
---

Every rule now applies through `:root:has(theme token)`, so dialogs, menus, ⌘K, the properties sheet
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
