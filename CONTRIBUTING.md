# Contributing

## How contributions work

Capybara uses one contribution workflow across the `capybara-hq` organization: issue, `accepted`,
`/claim`, a pull request that closes the issue, review, and merge by a maintainer. Read the
[organization guide](https://github.com/capybara-hq/.github/blob/main/CONTRIBUTING.md) first; this
file only adds what is specific to this repository. If you use a coding agent, it can follow the
same workflow from [.agents/skills/contributing/SKILL.md](.agents/skills/contributing/SKILL.md) (and
start with the `onboarding` skill).

Two commands help at every step:

- `pnpm doctor:env` checks your environment (Node, pnpm, dependencies, Docker, remotes, git
  identity); `--fix` performs only fixes that need no decision.
- `pnpm verify` runs the required checks locally for your branch. Run it before pushing.

Both accept `--json`; run them as `pnpm -s doctor:env --json` so pnpm's banner does not precede the
JSON. Start a task in a worktree with `pnpm wt:new <branch>`; it branches from the upstream `main`.

## Development environment

- Node 24, pnpm 10, Docker.
- After `pnpm install`, run `pnpm lint && pnpm typecheck && pnpm check && pnpm test`.

Project conventions for people and coding agents alike are in [AGENTS.md](AGENTS.md). Guides for
writing plugins live in [.agents/skills/](.agents/skills/) (`onboarding`, `contributing` and
`reviewing-prs` are synced from `capybara-hq/.github` and must be edited there; `.claude/skills` is a
symlink to `.agents/skills`). On Windows, enable symlinks before cloning
(`git config --global core.symlinks true`, plus Developer Mode).

## Changes to the SDK, the kernel or the test kit

They live in [capybara-hq/core](https://github.com/capybara-hq/core): open the pull request there
first. This repository picks the change up once core releases it.

## Pull requests

- All changes reach `main` through pull requests; a maintainer reviews and merges.
- The required statuses are `ci-ok` and `issue-linked` (see the organization guide and "CI and
  checks" in AGENTS.md).
- The PR description is filled from the organization's default template.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), e.g. `fix(slack): retry the socket`;
body lines ≤ 100 characters. commitlint checks this on PRs.

## Changesets

If you change a published plugin, run `pnpm changeset` and commit the generated file. Never edit
`.capybara-plugin/marketplace.json` by hand: the Version Packages PR appends its entries.

## Live API tests

Tests against real services (model providers, E2B, Slack, Lark, MCP / OpenAPI servers) run only when
their `CAPYBARA_TEST_*` variables are set. Keep keys in a local env file outside the repository and
never commit or paste them.

## CLA

Contributions need the Capybara CLA ([CLA.md in core](https://github.com/capybara-hq/core/blob/main/CLA.md));
the CLA bot asks on your first pull request.
