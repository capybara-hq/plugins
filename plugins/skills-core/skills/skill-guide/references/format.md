# Skill format reference

Read this when you need an optional frontmatter field, or the package limits.

## Optional frontmatter fields

| Field | Meaning |
|---|---|
| `license` | License name or a reference to a bundled license file. |
| `compatibility` | Up to 500 characters on environment requirements (tools, network, runtimes). |
| `metadata` | A map of string keys to string values for your own bookkeeping (author, version). |
| `allowed-tools` | Tools the skill expects to use, as a space-separated list. |

## Invocation fields

| Field | Meaning |
|---|---|
| `disable-model-invocation: true` | Manual-only. The skill is not in your catalog and you cannot load it; a person runs it with `/<name>`. Use it for procedures with side effects that a person should start deliberately. |
| `user-invocable: false` | Hidden from the `/` menu; only the model loads it. Cannot be combined with `disable-model-invocation: true`. |
| `context: fork` | A person's invocation runs the skill in a sub-agent. |
| `agent` | With `context: fork`: the sub-agent type (`general-purpose`, `Explore`, `Plan`). |
| `argument-hint` | Placeholder shown in the `/` menu, for example `[issue-number]`. |
| `arguments` | Names for positional arguments, usable in the body as `$name`. |

In the body of a skill, `$ARGUMENTS` is everything the person typed after `/<name>`, `$1`, `$2` ... are
positional values, and `${CLAUDE_SKILL_DIR}` is the skill's directory (`/skills/<name>`). Nothing in a
skill is executed when it loads: a line such as !`command` stays text, and you run it yourself with
`Bash` if you have it.

## Limits

- `name` 1-64 characters (lowercase letters, digits, single hyphens), equal to the folder name.
- `description` 1-1024 characters.
- `SKILL.md` under 500 lines; references one level deep.
- The package: 10 MB per file, 50 MB in total, 1000 files.
- A package is a zip with `SKILL.md` at its root or inside exactly one top-level folder.
