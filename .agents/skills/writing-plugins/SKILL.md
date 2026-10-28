---
name: writing-plugins
description: 'Use when writing or changing a plugin in this repository (at most one extension, skills, connector templates, agent templates: .capybara-plugin/plugin.json, skills/<name>/SKILL.md, connectors/<id>.json, agents/<name>.md, dependencies with semver ranges), packing, checking, versioning and releasing it with capybara-plugin (pack, check, sync-versions, marketplace, release), this repository''s .capybara-plugin/marketplace.json, the marketplace.json format, and what a deployment checks when it imports a plugin (sha512 integrity, content digest, npm provenance). Extension code: writing-extensions; connector extensions: writing-connectors.'
---

# Writing plugins

Terms: a **plugin** is the install and distribution unit: a bundle of at most one **extension** (in-process code, `.agents/skills/writing-extensions`), skills, connector templates and agent templates (`agents/<name>.md`, sub-agents a parent agent can dispatch), possibly depending on other plugins. A deployment's **catalog** is what it imported for its orgs to install. A **marketplace** is a `marketplace.json` listing importable plugins. Every package under `plugins/*` here is a plugin holding one extension of the same name.

This skill is the author half. How the kernel imports, reviews, installs, upgrades and uninstalls plugins (the catalog, enterprise marketplaces, Claude Code plugin translation, bootstrap plugins, org install) is core's: [writing-plugins in core](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-plugins); spec `docs/superpowers/specs/2026-10-22-package-ecosystem-design.md` in core.

## Layout

A plugin is a directory, packed into an npm-pack tgz:

```
<plugin>/
  .capybara-plugin/plugin.json   the plugin manifest (required in the source; the packer adds `extension`)
  package.json                   npm metadata; `version` equals plugin.json `version`
  skills/<name>/SKILL.md …       skills (scanned unless plugin.json lists them)
  connectors/<id>.json           connector templates (scanned unless plugin.json lists them)
  agents/<name>.md               agent templates for sub-agents (scanned unless plugin.json lists them)
  src/index.ts                   extension source (optional; bundled into dist/index.mjs)
  migrations/*.sql, ui/**        extension migrations and UI files (optional)
  README.md, LICENSE, NOTICE
```

`capybara-plugin pack <dir>` validates the source `plugin.json`, bundles `src/index.ts` when it exists (a plugin without one is **declarative**: no esbuild runs and the package has no `peerDependencies`), ships `skills/**`, `connectors/*.json`, `agents/*.md`, the listed paths and icons, writes `package.json` (no `capybara` section) and the final `.capybara-plugin/plugin.json` with `extension = { entry: "./dist/index.mjs", manifest: <static extension manifest>, migrations?: "./migrations", ui?: "./ui" }`, and produces a byte-reproducible tgz. It fails early on a missing listed path, a skill directory without `SKILL.md`, an invalid `connectors/*.json` or `agents/*.md` and an empty plugin (`a plugin must contain an extension, a skill, a connector template or an agent template`).

The format and its validation are pure functions in the SDK: `parsePluginManifest`, `parseConnectorTemplateFile`, `PLUGIN_MANIFEST_LIMITS`, `validatePluginPackageJsonFor`, `validateConnectorTemplate`, `parseMarketplaceManifest`, `marketplaceEntryVersion`, `parseSkillMd`, `parseAgentTemplate`. Kernels treat a plugin as hostile input, collect every problem and write nothing until all checks pass.

**JSON Schemas**: the SDK package ships `schemas/plugin.v1.schema.json`, `connector-template.v1.schema.json` and `marketplace.v1.schema.json`; files may set `$schema` to `https://capybarahq.com/schemas/<file>`. Rules JSON Schema cannot express (path safety and nesting, uniqueness, no self-dependency, the extension's name and version equal to the plugin's, template static rules, unique `(name, version)` in a marketplace) are decided only by the SDK parsers, which `capybara-plugin pack` / `check` run.

## Toolchain (`capybara-plugin`, `@capybara-hq/plugin-tools` from npm)

Run from the repository root; relative paths resolve against the current directory. A root is a repository with `plugins/*` or a single-plugin directory.

| Command | What it does | Here |
|---|---|---|
| `capybara-plugin pack <dir>… [--all <root>] [--out <dir>]` | the packer above; byte-reproducible, so the sha512 of a pack is known before publishing; output `artifacts/plugins` | `pnpm pack-plugins` packs all |
| `capybara-plugin check [--root <dir>] [--plugins <glob>] [--base <ref>]` | every plugin check: the dependency boundary (`plugin-imports-kernel`, `plugin-imports-outside`), extension state (`plugin-timer`, `plugin-module-state`), the permission manifest (`perm-*`), packing (`plugin-pack`, `plugin-pack-dropped`), the tool design rules (`tool-description`, `tool-error-actionable`), migrations, plugin test imports (`plugin-test-imports`), release metadata (`plugin-release-metadata`); with `--base`, an edited applied migration fails (`applied-migration-edited`) | `pnpm check` |
| `capybara-plugin sync-versions [--root <dir>] [--plugins <glob>]` | copies each plugin's `package.json` version into its `plugin.json` and extension manifest (the packer requires them equal); run after `changeset version` | part of the Version Packages PR |
| `capybara-plugin marketplace --write\|--check [--base <rev>] [--root <dir>] [--file <path>] [--plugins <glob>]` | `--write` appends one npm entry per public plugin version not listed yet to `.capybara-plugin/marketplace.json` (name, version, summary, homepage, permissions, `source.npm` with the sha512 of the reproducible pack); `--check` fails on a missing entry (`marketplace-missing`) or an unparsable file (`marketplace-invalid`); with `--base`, entries at the base stay unchanged and first (`marketplace-append-only`) and added entries match their packs (`marketplace-integrity`) | Version Packages PR (`--write`), CI (`--check`) |
| `capybara-plugin release [--dry-run] [--provenance] [--auto] [--root <dir>] [--plugins <pattern>]... [--marketplace <file>]` | publishes every non-private package whose version is not on npm yet, plugins as their plugin tgz, with dist tags (prerelease `next`, backport `release-<major>.<minor>`, else `latest`); `--marketplace` (default this repository's file) packs every planned plugin and checks its sha512 against that version's entry before the first publish, stopping with nothing published on a mismatch (`release.integrity_mismatch`) | release workflow |

**This repository is the official marketplace** (`https://github.com/capybara-hq/plugins.git`, read by kernels as a git marketplace). Its `.capybara-plugin/marketplace.json` is **never edited by hand**: `capybara-plugin marketplace --write` updates it in the Version Packages PR, it is append-only once published, and `release` refuses a pack that differs from its entry. Core's bootstrap pins (`openai-compatible`, `object-store-s3`) are checked against npm and this file, so a release of a bootstrap plugin is followed by a pin update in core.

## `plugin.json`

```json
{
  "$schema": "https://capybarahq.com/schemas/plugin.v1.schema.json",
  "schemaVersion": 1,
  "name": "crm",
  "version": "1.2.0",
  "publisher": "Acme",
  "description": "CRM tools for sales teams",
  "displayName": { "zh": "CRM", "en": "CRM" },
  "icon": "./icon.svg",
  "license": "Apache-2.0",
  "homepage": "https://acme.example/crm",
  "dependencies": [{ "name": "crm-core", "version": "^1.0.0" }],
  "skills": [{ "path": "./skills/crm-notes", "pinned": true }],
  "connectorTemplates": [{ "path": "./connectors/crm-mcp.json" }]
}
```

- Objects are strict: an unknown key is an error (`$schema` is allowed). The text is at most 256K characters; errors come back as `path: message`, at most 50.
- `name`: `^[a-z0-9][a-z0-9-]{0,63}$`. With an extension it must also be a valid extension name and equal `extension.manifest.name` (the PG schema `plugin_<name>`, storage prefix, tool keys and hook ownership are keyed by it). The plugin name is independent of the npm name, but one catalog name belongs to one npm package (`catalog.name_conflict`), and an extension name to the npm package that first installed it: renaming the npm package means renaming the plugin.
- `version`: exact semver, equal to `package.json` `version` and the extension manifest's `version` (`sync-versions`).
- `description` <= 1024 characters, `publisher` and `displayName` <= 100; `homepage` is https; `icon` is a `./…` `.svg` / `.png` (kernels check the content is really svg / png, <= 64 KB).
- Paths start with `./`, stay inside the plugin root and do not nest (no skill directory inside another).
- `skills` (<= 50): directories holding `SKILL.md`. Omitted = scan `skills/*/SKILL.md`. Each `SKILL.md` goes through `parseSkillMd` (YAML frontmatter, Agent Skills format); names are unique. `pinned` (suggested as pinned) is offered to the admin at import. A deployment refuses an org install when a skill name is already owned by the org or another plugin (`plugin.skill_conflict`), so pick distinctive names.
  - **Invocation keys** (Claude Code's names, `SKILL_INVOCATION_LIMITS`): `disable-model-invocation: true` makes the skill **manual-only** (never in the model's catalog or the pinned skills; only a person runs it with `/name args`), `user-invocable: false` hides it from the `/` menu (both together is refused), `context: fork` runs a person's invocation as a sub-agent (`agent:` picks the type: `general-purpose`, `Explore`, `Plan` or one of the plugin's `agents/*.md` as `<plugin>:<name>`; an unknown one runs as `general-purpose` with a warning), `argument-hint` is the `/` menu placeholder (a YAML list such as `[issue-number]` reads back as text) and `arguments` names positional values. The body uses `$ARGUMENTS`, `$N`, `$ARGUMENTS[N]`, `$name`, `\$` and `${CLAUDE_SKILL_DIR}` (`/skills/<name>`); nothing is executed: `` !`cmd` `` lines stay text and the model is told to run them with `sandbox_bash` when it has it. Arguments are at most 10 000 characters and the rendered skill at most 200 000. A wrong type is refused at import.
- `connectorTemplates` (<= 20): `./…/<id>.json` files; the template id is the file's base name (`^[a-z0-9][a-z0-9-]{0,63}$`), unique in the plugin. Omitted = scan `connectors/*.json`.
- `dependencies` (<= 20): a plugin name and a semver range; no self-dependency, no duplicates. No integrity lock: each dependency is verified against its own source when imported. An org install installs missing dependencies first (the highest imported version satisfying the range); a dependency whose templates need a credential must be installed on its own first. Publish dependencies before the plugins that need them.
- `agents` (<= 64): `./…/<name>.md` agent templates (`parseAgentTemplate`: frontmatter `name` (the template name rule), `description` (<= 4096), optional `tools` / `disallowedTools` (tool keys), `toolPolicies` (`ask` / `deny`), `model` (`inherit` / `fast` / `standard` / `capable`, a purpose tier, never a model id), `effort`, `maxSteps`, `skills` (<= 3 names, preloaded); the body (<= 100 000 characters) is the instructions). Omitted = scan `agents/*.md`. Names are unique in the plugin; an agent dispatches one as `<plugin>:<name>`. A plugin with only templates needs no extension or permission approval.
- Version ranges on official packages (`pluginVersion`, `dependencies`, the `sdk` range) are written `^0.1.0-rc.0` while they are release candidates: a plain `^0.1.0` does not accept `0.1.0-rc.N`.
- `extension`: **written by the packer, never by hand** (a source `plugin.json` that has it fails to pack). Its `manifest` is the static extension manifest; its `sdk` range must have an upper bound and equals `package.json` `peerDependencies["@capybara-hq/plugin-sdk"]`.
- `package.json` in the tgz: an npm name, no install scripts, no `gypfile`, no dependency fields; `peerDependencies` only the host packages (`@capybara-hq/plugin-sdk`, `zod`) and only with an extension.

## Connector templates (`connectors/<id>.json`)

```json
{
  "$schema": "https://capybarahq.com/schemas/connector-template.v1.schema.json",
  "displayName": { "zh": "Acme CRM", "en": "Acme CRM" },
  "description": "Acme CRM over MCP",
  "icon": "./icons/crm.svg",
  "template": {
    "plugin": "connector-mcp",
    "pluginVersion": "^0.1.0-rc.0",
    "connector": "mcp",
    "endpoint": { "url": "https://mcp.acme.example/mcp" },
    "editableEndpoint": ["url"],
    "auth": { "type": "bearer", "ownership": "org" },
    "defaultToolPolicies": { "search": "allow", "delete_record": "deny" }
  }
}
```

The file is strict; `template` is validated by `validateConnectorTemplate`, and values are never echoed in errors.

- `plugin` / `connector`: the connector extension's name and its `Connector.kind`. At import, when that connector is loaded on the deployment, the endpoint is validated against its `endpointSchema`, every `editableEndpoint` path must be a field of that schema, and `pluginVersion` must be satisfied by the loaded version; when the connector is this plugin's own extension or a dependency's, only the static checks run then. Any other connector that is not loaded refuses the import. At org install the template is checked again against the loaded connector.
- `endpoint`: the preset, visible to every org; **no credential-like keys at any level** (`token`, `apiKey`, `secret`, `password`, `authorization`, `cookie` and so on, ignoring case and `-` / `_`).
- `editableEndpoint`: the dotted paths an org may change at install (letters, digits, `_`, `-`, <= 50, no duplicates, not credential-like). List only fields that really differ by org (the `url` of a self-hosted service, a tenant id).
- `auth`: the shape of the connector auth methods (`none` / `bearer` / `basic` / `api_key` / `headers` / `oauth_code` / `oauth_client`), **without credentials** (extra fields are rejected). An org fills in only `credential` (static) or `client: { clientId, clientSecret? }` (OAuth). `ownership` is not allowed with `auth.type = none`.
- `defaultToolPolicies`: local tool name (without `<slug>__`) -> `allow` / `ask` / `deny`, kept like an admin's setting. When unsure, do not write `allow`.
- `icon` (file level): a safe path relative to the plugin root, `.svg` / `.png`, checked like the plugin icon.

## Marketplaces (`marketplace.json`)

```json
{
  "$schema": "https://capybarahq.com/schemas/marketplace.v1.schema.json",
  "schemaVersion": 1,
  "name": "Acme plugins",
  "owner": { "name": "Acme", "url": "https://acme.example" },
  "plugins": [
    {
      "name": "crm",
      "summary": { "en": "CRM tools" },
      "version": "1.2.0",
      "minKernel": "0.1.0",
      "permissions": { "keys": ["db"], "sensitive": [] },
      "source": { "npm": { "package": "@acme/plugin-crm", "version": "1.2.0", "integrity": "sha512-…" } }
    }
  ]
}
```

- Unknown fields are dropped (forward compatible). One entry is one version: `(name, version)` is unique, where the version is `version`, else `source.npm.version`; a marketplace offering several versions lists the plugin once per version. When both are given they must be equal.
- `source` is exactly one of `{ npm: { package, version, integrity } }` (exact version, sha512 SRI), `{ archive: { url, integrity } }` (https, sha512 or sha256 SRI), `{ path }` (read from a git marketplace's own repository) or `{ git: { url, ref?, commit?, path? } }` (read at the pinned `commit`, else the `ref`'s head at import).
- `permissions` is display only; a deployment warns when it differs from the package.
- `minKernel`: an entry needing a newer kernel is listed as incompatible.
- Tests: `startFakeMarketplace({ manifest })` from `@capybara-hq/testing` serves `/marketplace.json`.

## What a deployment checks when it imports your plugin

- **Integrity**: downloads are always verified against the marketplace entry's integrity (or npm `dist.integrity` for a direct npm import), never other npm metadata; a mismatch refuses the import. That is why packs must be byte-reproducible and the marketplace entries come from `capybara-plugin marketplace --write`.
- **Content digest**: every import records a sha256 over the plugin's files. Other content at an already imported version becomes `<version>+git.<sha12>` / `+sha256.<12>` and never overwrites the imported one, so **bump the version for every content change**.
- **Provenance**: for npm sources the registry's attestation ("built from `repository`@`commit` by `workflow`") is shown at review, display only, never a refusal. `capybara-plugin release --provenance` produces it, which needs `repository.url` and `repository.directory` to match the repository (`plugin-release-metadata`).
- **One review**: the admin sees the extension's permissions and migration warnings, every skill with its body, every connector and agent template, and the dependencies before confirming. Changes in permissions or migration warnings in a new version need re-approval (`.agents/skills/writing-extensions`).
- A tgz in the pre-0.1.0 format (a `capybara` section in `package.json`, no `.capybara-plugin/plugin.json`) is refused (`catalog.legacy_format`); repack it.

## Checklist for writing a plugin

1. Write `.capybara-plugin/plugin.json` (no `extension`), `package.json` with the same version and the release metadata (`repository` `{ type: "git", url: "git+https://github.com/capybara-hq/plugins.git", directory: "plugins/<name>" }`, `description`, `license`, https `homepage`; `example-*` plugins are private), the skills and the connector templates. For a template, check the endpoint preset and `editableEndpoint` against the connector's `endpointSchema` (in a development deployment or the connector's tests).
2. `pnpm pack-plugins` (or `capybara-plugin pack plugins/<name>`) and `pnpm check`.
3. Validate with the SDK when writing files by hand: `parsePluginManifest`, `parseConnectorTemplateFile`, `parseMarketplaceManifest` return no `errors`.
4. Tests in `plugins/<name>/test`, run from the root: `pnpm exec vitest run plugins/<name>`; `pnpm verify` runs the required checks for the branch.
5. A changeset for every change that affects a release (`pnpm changeset`); the Version Packages PR then bumps versions, runs `sync-versions` and `marketplace --write`.
6. A contract change (SDK, kernel) needs a PR in `capybara-hq/core` first.
