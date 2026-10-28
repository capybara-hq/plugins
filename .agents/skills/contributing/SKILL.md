---
name: contributing
description: "Carries day-to-day work in a capybara-hq repository from an issue to a PR ready for a maintainer: start (check and claim the issue, create a worktree branch from upstream main), verify (run pnpm verify and explain failures), open the PR (pre-check the issue gate, commit, push, create the PR with the right body, optional self-review) and address review (read review threads, fix, verify, push, reply, re-request review). Each action reaches its target state, doing missing earlier steps first. Use when the user says things like 'start on issue #N', 'work on #N', 'pick up #N', 'verify', 'run the checks', 'am I ready to push', 'open a PR', 'create the PR', 'submit this', 'address review', 'fix the review comments' or 'respond to feedback'."
# Synced from capybara-hq/.github. Edit the source there, then run sync.
metadata:
  source: capybara-hq/.github
  version: v1.0.0
  sha256: 7715de279860a2d72e71a604eab688d71a85b90c5b0835bf8872925db3b88b8e
---

# Contributing

This skill describes how work reaches `main` in every `capybara-hq` repository and turns it into
four actions: **start**, **verify**, **open the PR**, **address review**. The repository's own
rules are in `AGENTS.md` and the skills for each area; read them before changing code.

## Rules

- **Run the repository's commands; do not re-implement them.** `pnpm doctor:env`, `pnpm verify` and
  `pnpm wt:new` decide what is checked and how; `gh` and `git` do the rest.
- **Outward actions only after the user agrees**: commenting `/claim`, pushing, opening or editing
  a PR, replying to review threads, requesting reviewers. Show what you are about to run (and the
  text you will post), then wait for a yes, unless the user already told you to go ahead.
- **Never print secrets.** Do not read, print or ask for tokens, keys or env file contents.
- **Each action is a target state.** "Open the PR" on a fresh issue does start and verify first.
  Skip steps already done (an existing worktree, an existing PR); stop only where a human must
  decide.
- Never push to `main`, never merge, never force-push a branch you did not create.

## How work reaches `main`

- **Two kinds of contributors.** Core developers have write access and push branches to
  `capybara-hq/<repo>`. Community contributors push branches to their fork. Everything else is
  the same: worktree per task, design doc first for larger changes when `AGENTS.md` asks for one,
  Conventional Commits, changesets where the repository uses them, `pnpm verify` before pushing,
  a PR, review, merge by a maintainer.
- **Remotes.** The upstream is the remote whose URL points to `capybara-hq/<repo>` (find it with
  `git remote -v`; `<repo>` comes from that URL). If it is `origin`, the user is a core developer
  (confirm with `gh repo view capybara-hq/<repo> --json viewerPermission`: `ADMIN`, `MAINTAIN` or
  `WRITE`). If the permission is lower, they have no write access: follow the fork step of the
  `onboarding` skill (`gh repo fork --remote`). Otherwise `origin` is their fork and `<fork-owner>` is the owner in its URL. Branches
  start from `<upstream>/main` and are pushed to `origin`. If no remote points to `capybara-hq`,
  or `pnpm doctor:env` fails, follow the `onboarding` skill first.
- **The issue gate.** Every PR gets the required status `issue-linked`. It passes for authors
  with write access and for the bots `github-actions[bot]`, `dependabot[bot]`, `renovate[bot]`.
  For everyone else the PR body must close an issue of the same repository with a closing keyword
  (`Closes #N`, `Fixes #N`, `Resolves #N`; also `close`, `closed`, `fix`, `fixed`, `resolve`,
  `resolved`; any case; `#N`, `capybara-hq/<repo>#N` or the issue URL), and that issue must be
  open, labeled `accepted`, `good first issue` or `help wanted`, and unassigned or assigned to
  the PR author. One such issue is enough. A contributor claims an accepted issue by commenting
  `/claim`; a workflow assigns them if nobody has it.
- **No exemptions for small PRs**: typo and docs fixes also need an accepted issue.
- **Who merges.** Only maintainers (`@capybara-hq/maintainers`) approve and merge. Merging needs
  `ci-ok` and `issue-linked`, a branch up to date with `main`, and a code owner's approval of the
  latest push; a push after approval needs a new approval. CI on a first-time contributor's PR
  waits until a maintainer approves the run.

## Start

Input: an issue number `N` (core developers may also start without one).

1. Read the issue: `gh issue view N --repo capybara-hq/<repo> --json number,title,state,labels,assignees,body`.
2. Community contributor:
   - Closed, or none of the labels `accepted`, `good first issue`, `help wanted`: stop. Say the
     issue is not ready, and suggest commenting on it or picking another accepted issue.
   - Assigned to someone else: stop and say who has it.
   - Unassigned: offer to claim it with `gh issue comment N --repo capybara-hq/<repo> --body "/claim"`.
     After the user agrees and it is posted, re-read the issue after a short wait until the user's
     login (`gh api user --jq .login`) is among the assignees, or the workflow's reply says why not.
3. Pick the branch name `<type>/<N>-<slug>`: `<type>` is the Conventional Commits type that fits
   the change (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`), `<slug>` is 2-5 lowercase words
   from the issue title joined by `-`. Example: `fix/42-empty-config-crash`. Without an issue:
   `<type>/<slug>`.
4. If a worktree for that branch already exists (`git worktree list`), use it. Otherwise:
   - When the repository provides `pnpm wt:new` (see `AGENTS.md`), run
     `pnpm wt:new <branch> --from <upstream>/main` and work in the directory it prints.
   - Otherwise `git fetch <upstream>` and
     `git worktree add -b <branch> --no-track <path> <upstream>/main`, with `<path>` where
     `AGENTS.md` says worktrees go.
5. Read `AGENTS.md` and the skills for the areas the issue touches. If the change is larger (a
   new feature, a cross-package change, a new contract, a behavior change) and `AGENTS.md` asks
   for a design doc first, say so and agree with the user how to proceed before writing code.

## Verify

1. In the worktree, run `pnpm -s verify --json`. It prints the same contract as doctor:
   `{ "ok", "checks": [{ "id", "title", "status", "detail", "fix"? }] }`, exit 0 when nothing is
   `fail`. Keep the `-s`: without it the script banner on stdout breaks JSON parsing.
2. For each `fail`, explain in plain words what broke and where, using `detail` and `fix`. Fix the
   code when the cause is clear and inside the task; ask when it is not. Do not skip, disable or
   weaken a check to make it pass.
3. Mention each `warn` (for example a missing changeset) and what CI will run in addition.
4. Re-run until `ok` is true.

## Open the PR

Do whatever of start and verify is missing first. If a PR for this branch already exists
(`gh pr list --repo capybara-hq/<repo> --head <branch> --author @me --json number,url,body`),
update it instead of creating another.

1. **Pre-check the issue gate** (community contributors only), so the PR does not go red:
   - The body you are about to write closes issue `N` with a closing keyword (see "The issue
     gate"); the reference is to this repository, not another one.
   - `gh issue view N --repo capybara-hq/<repo> --json state,labels,assignees` shows the issue
     open, with `accepted`, `good first issue` or `help wanted`, and unassigned or assigned to
     the user. If not, stop and explain what is missing (claim it, wait for a maintainer to
     accept it, or link another issue).
2. **Commits**: Conventional Commits (`<type>: <summary>`, imperative, lower case), with the body
   line limits `AGENTS.md` gives. Add a changeset when a published package changed and the
   repository uses changesets (`AGENTS.md` says how). Show the user the commit messages.
3. **Verify**: `pnpm verify` passes on the final commit.
4. **Self-review (optional, never blocks)**: if your agent can start a sub-agent with fresh
   context, give it the diff (`git diff <upstream>/main...HEAD`), `AGENTS.md` and the skills for the
   touched areas, and ask for a list of problems. Otherwise review the diff yourself against the
   same material. Show the problems to the user; they decide what to fix.
5. **Push** after the user agrees: `git push -u origin <branch>`.
6. **Create the PR** after the user agrees. Write the body to a temporary file outside the
   repository, then:
   - fork: `gh pr create --repo capybara-hq/<repo> --base main --head <fork-owner>:<branch> --title "<title>" --body-file <file>`
   - core developer: `gh pr create --repo capybara-hq/<repo> --base main --head <branch> --title "<title>" --body-file <file>`

   The title is the Conventional Commits subject of the change. Give the user the PR URL.

### PR body

Use exactly this structure (the same as the organization's PR template):

```markdown
## What and why

<What changes and why it is needed, in a few sentences. Link the design doc for larger changes.>

Closes #N

## Checklist

- [x] `pnpm verify` passes
- [ ] A changeset is included if a published package changed
- [ ] The design doc is linked here if this is a larger change
```

Tick a box only when it is true. When an item does not apply, leave it unticked and append
"(not applicable)". A core developer without an issue removes the `Closes #N` line.

## Address review

1. Find the PR (`gh pr view --repo capybara-hq/<repo> <number-or-branch> --json number,url,reviews,comments`)
   and read review summaries and PR comments from that output.
2. List the unresolved review threads:

   ```sh
   gh api graphql -F owner=capybara-hq -F name=<repo> -F number=<PR> -f query='
   query($owner: String!, $name: String!, $number: Int!) {
     repository(owner: $owner, name: $name) {
       pullRequest(number: $number) {
         reviewThreads(first: 100) {
           nodes {
             id isResolved isOutdated path line
             comments(first: 50) { nodes { databaseId author { login } body url } }
           }
         }
       }
     }
   }'
   ```

   Keep the threads with `isResolved: false`. Show the user each one: `path:line`, who asked, what.
3. Fix each point in the worktree, or, when you disagree or it is unclear, propose a reply that
   explains why instead of changing the code. The user decides.
4. Run `pnpm verify` until it passes, commit (new commits; do not rewrite history the reviewer has
   seen unless the user asks), and push after the user agrees.
5. Reply in each thread with what changed (and the commit), after the user agrees with the text:
   `gh api repos/capybara-hq/<repo>/pulls/<PR>/comments/<databaseId of the thread's first comment>/replies -f body="<reply>"`.
   Leave resolving threads to the reviewer.
6. Re-request review from the reviewers, after the user agrees:
   `gh pr edit <PR> --repo capybara-hq/<repo> --add-reviewer <login>`, or
   `gh api repos/capybara-hq/<repo>/pulls/<PR>/requested_reviewers -f "reviewers[]=<login>"`.
   If both are refused for lack of permission, post one PR comment asking the reviewer for another
   look instead.
7. If the branch fell behind `main`, say so; updating it (merge or rebase onto `<upstream>/main`,
   then verify and push) is the user's choice.
