---
"@capybara-hq/plugin-slack": patch
---

Draws the run's progress card natively (`features.progress`): the title and meta, the status
line and the pinned text, the latest steps as preformatted text (never links), and the pending
actions (at most 20 as buttons, the rest counted in one line) and the web link as link buttons;
the card is edited in place as the run goes on. A card kind this plugin does not know falls back
to the SDK's text form instead of failing.
