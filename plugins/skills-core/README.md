# @capybara-hq/plugin-skills-core

Core skills for Capybara agents (a declarative plugin: skills only, no extension).

| Skill | What it does |
|---|---|
| `skill-guide` | Teaches an agent to create or upgrade a skill of its own: the Agent Skills layout, writing `SKILL.md`, zipping the package in the sandbox, registering it with the `Platform` tool (`agents.register-skill`), testing it with `Skill`, and sharing it with the org (`agents.share-skill`). |

Requires a core release with `agents.register-skill` and `agents.share-skill`.
