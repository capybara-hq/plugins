---
name: skill-guide
description: "Use when creating or upgrading a skill for this agent: the Agent Skills layout, writing SKILL.md, packaging a zip in the sandbox and registering it with the Platform tool (agents.register-skill), testing it with Skill, and sharing it with the org."
---

# Writing a skill for this agent

A skill is a folder of instructions (and optional scripts and reference files) that you load on demand
with the `Skill` tool. Write one when the person asks for it, or when a task keeps recurring and you
keep re-deriving the same procedure, conventions or pitfalls. Do not write one for a one-off task or
for facts that fit in a single sentence of the agent's instructions.

Only the agent's owner can register a skill. If the person talking to you is not the owner, say so
instead of trying.

## Layout

```
<name>/
  SKILL.md          required: frontmatter, then the instructions
  references/       optional: longer documents, read only when needed
  scripts/          optional: helpers you run with Bash
  assets/           optional: templates and static files
```

The folder name equals the skill `name`.

## SKILL.md

```markdown
---
name: weekly-report
description: "Use when the person asks for the weekly report: collects the week's tickets and writes the summary in the team format."
---

# Weekly report

1. ...
```

Frontmatter rules:

- `name`: 1-64 characters, lowercase letters, digits and single hyphens (no leading, trailing or
  doubled hyphen), equal to the folder name.
- `description`: 1-1024 characters. Say what the skill does and when to use it. It is the only text
  the model sees before loading the skill, so put the trigger words people will actually use in it.

Optional fields (license, compatibility, tool allow-lists, manual-only and sub-agent invocation):
read [references/format.md](references/format.md) when you need one of them.

## Keep it short

- Keep `SKILL.md` under 500 lines: the procedure, the decisions, the pitfalls. Write for a capable
  reader; leave out what you would already know.
- Move detail to `references/<topic>.md`, one level deep (a reference does not link to another
  reference). In `SKILL.md`, link each file with a line saying when to read it, for example "Read
  references/api.md when you need the endpoint list."
- Prefer a script in `scripts/` over prose for steps that must be exact, and say in `SKILL.md` how to
  run it.
- Do not put secrets, tokens or personal data in a skill: every conversation with the agent (and the
  org, once shared) can read it.

## Steps

1. Write the directory in your sandbox, for example `/workspace/skills/<name>/`.
2. Zip it from its parent so the folder is the top level:
   `cd /workspace/skills && zip -r <name>.zip <name>`
   (a zip with `SKILL.md` at its root also works).
3. Register it: call the `Platform` tool, operation `agents.register-skill`, input
   `{ "filePath": "/workspace/skills/<name>.zip" }`. Use the absolute path of the zip in the sandbox.
   On a private agent the first registration shows the person a confirmation card (they may choose to
   remember it); on a shared agent they confirm every time. Wait for the answer; if it is refused or
   fails, read the error, fix the package and register again.
4. Test it: load it with the `Skill` tool (skill `<name>`); it is available in the same run. Follow it
   on a small realistic task, and fix what is unclear. A skill that is manual-only (see
   references/format.md) is not loadable by you: a person runs it with `/<name>`.
5. Upgrade: change the files and register again with the same name. Every registration is a complete
   new version: files you leave out are not part of it, so zip the whole directory, not just the
   changed files.

Limits: 10 MB per file, 50 MB in total, 1000 files.

## Sharing with the org

A skill you register belongs to this agent. To make it available to the whole org, the owner asks
you to share it (or does it on the agent page): call `Platform` `agents.share-skill` with the skill id
(read it from `agents.skills`). An org admin has to confirm it in the inbox; when the owner is an org
admin it is immediate. Read [references/sharing.md](references/sharing.md) before sharing or when you
upgrade an org skill: it covers versions, the maintainer role and name conflicts.
