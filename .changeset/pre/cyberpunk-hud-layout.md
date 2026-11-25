---
"@capybara-hq/plugin-theme-cyberpunk": patch
---

The run HUD reads cleanly under any theme: the status dot and the signal meter render only while the
cyberpunk theme is active (under another theme they were empty boxes that indented the status row
and left a gap above the list), the ticker appears once a run has been seen instead of a
`T+--:--.-` placeholder, and the sound switch moves from the crowded status row to its own row
below the list.
