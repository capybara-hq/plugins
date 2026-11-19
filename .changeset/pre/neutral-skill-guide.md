---
"@capybara-hq/plugin-skills-core": patch
---

skill-guide: packaging states the zip requirement instead of a `zip -r` command and a hard-coded
`/workspace` path (the default sandbox image has no `zip`, auto mode has no `/workspace`); a failed
registration is fixed and resubmitted, a declined confirmation is not; package limits, frontmatter
rules and sharing steps are each said once.
