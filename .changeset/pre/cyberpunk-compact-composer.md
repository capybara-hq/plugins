---
"@capybara-hq/plugin-theme-cyberpunk": patch
---

The composer's mobile form (below 600, or touch): the focus line wraps only the pill
(`composer.box`), not the settings chip row above it; the pill takes a text field's chamfered
corners, matching the send button's, instead of a round pill beside a square send; the chip keeps
its own button style, and the run lights and the waiting outline follow the pill. Focus above 600
lights the composer while its text box has focus, not while a picker has. Needs the
`composer.box`, `composer.send` and `composer.options` UI parts (plugin-sdk 0.1.0-rc.54 and the
core release that ships it).
