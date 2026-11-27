---
"@capybara-hq/plugin-todo": patch
---

The pinned todo card records its badge (`card.badge`, done/total such as "3/5", the same badge the
views show), so a finished run's process head shows "Todos 3/5" after a page reload (core#928).
Needs plugin-sdk ^0.1.0-rc.82.
