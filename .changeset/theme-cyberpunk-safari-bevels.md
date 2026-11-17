---
"@capybara-hq/plugin-theme-cyberpunk": patch
---

Cut the chamfered corners in Safari too: without `corner-shape` (off in Safari through 27.x) the
parts are cut with a clip-path that keeps glows and focus rings along the straight edges, and the
cut border is drawn back on the diagonal.
