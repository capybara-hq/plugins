---
"@capybara-hq/plugin-theme-cyberpunk": patch
---

Polish: every chamfered part (buttons of every variant, cards, sections, dialogs, the composer, the
boot screen) is bevelled with `corner-shape: bevel`, so borders and focus rings follow the diagonal
instead of stopping at a clipped corner. The run-state edges are soft: the title bar's bottom edge
fades out toward both ends with a slow bright segment sweeping along it during a run (static under
reduced motion), the properties panel edge matches, and the waiting composer gets a soft line and
glow. The favicon / plugin icon has a transparent ground and the logo's cyan offset.
