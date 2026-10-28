# AGENTS.md

The official plugins of [Capybara](https://github.com/capybara-hq/core), an open-source enterprise
agent platform (TypeScript, pnpm monorepo, Apache-2.0). The kernel, the plugin SDK, the test kit and
the plugin toolchain live in [capybara-hq/core](https://github.com/capybara-hq/core) and reach this
repository only as published npm packages. This repository publishes every plugin under `plugins/`
to npm (with provenance) and keeps the official marketplace manifest
`.capybara-plugin/marketplace.json`, which deployments import.

Terms (core's `AGENTS.md` has the full list): a **plugin** is the install and distribution unit (a
bundle of at most one extension, connector templates, agent templates and skills; npm
`@capybara-hq/plugin-*`); an **extension** is the in-process code inside a plugin
(`defineExtension`, `ctx`, the permission manifest); an **extension point** is a versioned contract
an extension provides or consumes (`channel@1`); a **marketplace** is a manifest listing importable
plugins. Data locations keep their old names (`plugin_<name>` schemas, `/plugin-ui`).

## Repository map

| Path | What it is |
|---|---|
| `plugins/<name>` | One plugin each: `package.json`, `.capybara-plugin/plugin.json`, the extension in `src/index.ts` (optional), `skills/`, `connectors/`, `agents/`, `migrations/`, `ui/`, and its tests in `test/` (unit, kernel-level and dual-replica tests, live tests under `test/live`) |
| `plugins/example-counter`, `plugins/example-board` | Reference implementations (private, never published): the smallest extension and an embed UI |
| `.capybara-plugin/marketplace.json` | The official marketplace (`capybara-official`): one npm entry per published `(plugin, version)` with its sha512; written only by `capybara-plugin marketplace --write` in the Version Packages PR, append-only |
| `tools/ci` | The CI plan for a diff (`tools/ci/src/affected.ts`, run by the `changes` job) |
| `tools/dev` | `pnpm doctor:env` and `pnpm verify` (same JSON contract as core's) |
| `tools/worktree` | `pnpm wt:new` / `wt:rm` / `wt:ls`, paired with `.claude/hooks/branch-safety.sh` |
| `tools/checks` | `check:synced-skills`, `check:skills-frontmatter`, and the workflow layout tests |
| `.agents/skills/` | Agent-facing skills (`.claude/skills` symlinks here): the author half of core's writing skills, plus `onboarding`, `contributing`, `reviewing-prs`, synced from `capybara-hq/.github` (edit them there and run the sync; `check:synced-skills` rejects in-place edits) |

`tools/ci`, `tools/dev`, `tools/worktree` and the two skill checks are copies of core's, adapted to
this repository; they move to `capybara-hq/.github` once a third repository needs them.

## Dependencies

- A plugin depends only on `@capybara-hq/plugin-sdk` and third-party npm packages; **never** on
  `@capybara-hq/kernel` (`capybara-plugin check`, rule set "Dependency boundary").
- A plugin's tests (`plugins/<name>/test`) import only `@capybara-hq/plugin-sdk`,
  `@capybara-hq/testing`, `@capybara-hq/plugin-model-fake` (the scripted model provider that drives
  agent runs in kernel-level tests) and the plugin itself, and no path outside the plugin
  (`plugin-test-imports`). A missing kernel facility is exported by `@capybara-hq/testing`: that is
  a PR in core.
- The core packages (`@capybara-hq/plugin-sdk`, `testing`, `plugin-tools`, `plugin-model-fake`)
  come from npm, at `^0.1.0-rc.0` while the release is a candidate (a plain `^0.1.0` does not match
  a prerelease). There is never a `workspace:`, `file:` or `link:` reference to core, or a path into
  a core checkout. Upgrading them is a lockfile change, which runs every test.
- Dependencies between plugins are `plugin.json` `dependencies` (name + semver range); a package.json
  dependency on another plugin only for tests.
- **Contract changes need a PR in core first.** A change to the SDK, the kernel, an extension point
  or the test kit lands in `capybara-hq/core`, is released, and then reaches this repository through
  a dependency upgrade. The SDK's public API snapshot and its changeset check in core make such a
  change visible.

Package names are always `@capybara-hq/plugin-<name>`; `repository.url` is
`git+https://github.com/capybara-hq/plugins.git` with `directory: plugins/<name>`
(`plugin-release-metadata`; npm provenance rejects a mismatch).

## Rules at a glance

- Multi-replica discipline (production runs several replicas): `ctx` has no timers or in-process
  shared objects; periodic and delayed work goes through queues; every `ctx.kv` write has a TTL;
  state shared between requests or processes lives in Redis / PG, never in module-level variables
  (`capybara-plugin check`, "Extension state").
- Extensions, permissions, hooks, config, lifecycle and publishing:
  [writing-extensions](.agents/skills/writing-extensions/SKILL.md); reference `plugins/example-counter`.
- Plugins (`plugin.json`, skills, connector templates, agent templates, dependencies, packing,
  the marketplace): [writing-plugins](.agents/skills/writing-plugins/SKILL.md).
- Tools (`ctx.tools`, descriptions and error text, policies, output size, display fields):
  [writing-tools](.agents/skills/writing-tools/SKILL.md); reference `plugins/todo`.
- Extension UI (`ctx.ui`, panels, sections, inline cards, pages, embeds, file previewers):
  [writing-extension-ui](.agents/skills/writing-extension-ui/SKILL.md); references `plugins/todo`,
  `plugins/example-board`.
- Model providers (`model-provider@2`):
  [writing-model-providers](.agents/skills/writing-model-providers/SKILL.md).
- Channels, third-party login, directory sync (`channel@1`, `identity-source@1`, `directory@1`):
  [writing-channels](.agents/skills/writing-channels/SKILL.md); references `plugins/slack`, `plugins/lark`.
- Connectors (`connector@1`; no stdio MCP):
  [writing-connectors](.agents/skills/writing-connectors/SKILL.md); references `plugins/connector-mcp`,
  `plugins/connector-openapi`.
- Sandboxes (`sandbox@1`): [writing-sandbox-providers](.agents/skills/writing-sandbox-providers/SKILL.md);
  references `plugins/sandbox-docker`, `plugins/sandbox-e2b`. `plugins/sandbox-docker/test/sandbox-proxy/haproxy.cfg`
  must stay byte-identical to core's `docker/sandbox-proxy/haproxy.cfg` (core checks it against the
  commit it pins).
- Object storage (`object-store@1`):
  [writing-object-store-providers](.agents/skills/writing-object-store-providers/SKILL.md); reference
  `plugins/object-store-s3`.
- Migrations (`plugins/<name>/migrations/NNNN_<snake_desc>.sql`, schema `plugin_<name>`,
  `IF [NOT] EXISTS`, expand-only, applied files immutable):
  [writing-migrations](.agents/skills/writing-migrations/SKILL.md).
- Language: English for docs, code comments, identifiers and commit messages. Older comments and
  test titles are partly Chinese; when you touch a file, write new comments in English and translate
  the comments and test titles you edit. Model-facing text (tool descriptions, model-visible errors)
  is always English.
- **When a rule can be checked automatically, the check is the authority.** Every check has a test
  where a violating fixture makes it fail; a new check is proven red first.

## Common commands

```bash
pnpm install
pnpm lint        # biome check
pnpm typecheck   # tsc -b, plus the tests' tsconfig
pnpm check       # capybara-plugin check (every plugin check) + the skill checks
pnpm check:marketplace   # capybara-plugin marketplace --check
pnpm test        # vitest run (needs Docker: Testcontainers PostgreSQL / Valkey, sandbox-docker)
pnpm exec vitest run plugins/<name>   # one plugin's tests, from the repo root
pnpm pack-plugins        # every plugin into artifacts/plugins
pnpm wt:new <branch>     # start a task worktree
pnpm doctor:env          # check your environment (--json; use pnpm -s for clean JSON)
pnpm verify              # the required checks locally for the current branch (--json, pnpm -s)
```

Kernel-level tests load the plugin under test from `src` into a kernel installed from npm.
`vitest.config.ts` inlines the core packages (`server.deps.inline`, so Vite transforms the kernel's
`import()` of a TypeScript plugin). Its setup file `vitest.setup.ts` adds tsx (an absolute loader
URL) to `NODE_OPTIONS` inside `*.dual.test.ts` files only, so the kernel replicas those tests start
as child processes can load the plugin and the TypeScript fake extensions of `@capybara-hq/testing`;
workers and other tests' child processes run plain Node. This is temporary, until core's
`@capybara-hq/testing` makes dual-replica children load TypeScript plugins themselves.

## How work is done

- **Design before code for larger changes.** A new plugin, a cross-plugin change or a behavior change
  starts with a design (an issue, or a doc reviewed by a maintainer), then the implementation. Small
  fixes skip this. A change that needs a new contract is designed in core.
- Changes reach `main` only through pull requests; a maintainer merges.
- The contribution workflow (issues, claiming, PRs, review) is in the `contributing` skill
  (`.agents/skills/contributing/SKILL.md`) and the
  [org guide](https://github.com/capybara-hq/.github/blob/main/CONTRIBUTING.md).

## Branches and worktrees

- The main checkout's HEAD stays on `main`. All task work happens in a worktree:
  `pnpm wt:new <branch> [--from origin/main] [--no-install]` creates `.claude/worktrees/<dir>`
  (gitignored) from the upstream `main`; after merge, `pnpm wt:rm <branch>`.
- `.claude/hooks/branch-safety.sh` (PreToolUse, wired in `.claude/settings.json`) enforces this: no
  pushes to `main`; no switching the main checkout to `feat/` `fix/` `docs/` `chore/` `test/`
  `refactor/` branches.

## CI and checks

- The required statuses are `ci-ok` and `issue-linked`. `ci-ok` aggregates every job in
  `.github/workflows/ci.yml`, which must all feed into it. `issue-linked` is set by
  `.github/workflows/community.yml` (the shared gate `gate.yml@v1` from `capybara-hq/.github`).
- **PRs run what the diff affects; pushes to `main` run everything.** The plan is computed by
  `tools/ci/src/affected.ts` (rules unit-tested in `tools/ci/test`); keep this table, that file and
  the comments in `ci.yml` in sync:

  | Job / check | On PRs | Why |
  |---|---|---|
  | `ci`: `pnpm lint`, `pnpm typecheck` | full | cheap |
  | `capybara-plugin check` (dependency boundary, extension state, permissions incl. `perm-hooks` / `perm-ui`, plugin pack, tool design, migrations, `plugin-test-imports`, `plugin-release-metadata`); on PRs with `--base "$(git rev-parse HEAD^1)"`, which also fails when the diff edits, deletes or renames an applied migration | full | reads every plugin, seconds |
  | `check:synced-skills`, `check:skills-frontmatter` | full | reads a few small files |
  | `capybara-plugin marketplace --check`; on PRs with `--base "$(git rev-parse HEAD^1)"`: entries at the base stay unchanged and first (append-only), added ones match their packs | full | packs every public plugin, seconds; the release gate depends on it |
  | `pnpm pack-plugins` (artifact `plugin-packages`), commitlint (PRs) | full | cheap |
  | `test` (vitest; Docker on the runner; live tests skip without their env vars) | by diff | the changed plugins plus every plugin that depends on them (by `plugin.json` dependencies or package.json dependencies, transitively); `.claude/hooks/**` and `.claude/settings.json` run `tools/worktree`, `.agents/**` runs `tools/checks`; 2 shards on a full run, else 1 |

  - **Run everything** when the diff touches root `package.json`, `pnpm-lock.yaml` (core package
    upgrades), `pnpm-workspace.yaml`, `vitest.config.*`, `tsconfig*.json`, `biome.json`,
    `.github/**`, `tools/**`, any file that is neither a doc nor inside a plugin (e.g.
    `commitlint.config.ts`, `LICENSE`), or when the diff can't be computed.
  - **No tests** for docs-only diffs (`docs/**`, `*.md` outside plugins, `.gitignore`, `.claude/**`
    except hooks and `settings.json`), `.capybara-plugin/marketplace.json` and `.changeset/*`.
- **Every new check must state whether it runs in full or by diff on PRs**, with the reasoning in the
  PR description, and update this section and the comments in `ci.yml`; on `main` everything runs.
- **Flaky tests get fixed, not hidden behind retries.**

## Releasing

`.github/workflows/release.yml` (never on PRs; `tools/checks/test/workflows.test.ts` pins its layout):

- `version-pr` (push only, changesets/action, `RELEASE_PR_TOKEN` so the PR's CI runs) opens the
  "Version Packages" PR; `pnpm version-packages` = `changeset version && capybara-plugin
  sync-versions && capybara-plugin marketplace --write`, so the PR carries the new versions, the
  synced `plugin.json` / manifest versions and the new `marketplace.json` entries with their sha512.
- `publish` (fresh checkout of `github.sha`, `contents: read` + `id-token`): `capybara-plugin release
  --auto --provenance` publishes every public plugin version not on npm yet, as its plugin tgz, after
  checking every pack against its `marketplace.json` entry (a mismatch publishes nothing). It refuses
  while nothing is on npm (the first release is a manual dispatch) and refuses to promote an rc to a
  stable version on push (promotion is a manual dispatch). Prereleases go to the dist-tag `next`.
- **Changesets are in pre mode** with the tag `rc` (`.changeset/pre.json`) while the release is a
  candidate: a changeset versions `0.1.0-rc.N` to `0.1.0-rc.N+1`. Promotion to `0.1.0` is a reviewed
  PR running `pnpm changeset pre exit` and `pnpm version-packages`, then a manual release.
- Every change to a published plugin adds a changeset (`pnpm changeset`). Releases follow core's
  order (core libraries, then these plugins, then core's bootstrap pins and images); core's runbook
  is `docs/deploy/release.md` in core.

## Live API tests

- Tests that hit real services run only when their `CAPYBARA_TEST_*` variables are set (each skill
  lists them: model providers, E2B, Slack, Lark, MCP / OpenAPI connectors with
  `CAPYBARA_TEST_LIVE_TOOLS`).
- Keep keys in a local env file outside the repository (`~/.capybara-test.env`), load it only inside
  the test command, and never print it, paste it into a chat or commit it.
- Run the live tests after changing request mapping, protocol handling or upgrading a vendor SDK. A
  transient network error is rerun once before it is treated as a bug.

## Commits

Conventional Commits (checked by commitlint), body lines ≤ 100 characters; changes that affect a
published plugin include a changeset (`pnpm changeset`).
