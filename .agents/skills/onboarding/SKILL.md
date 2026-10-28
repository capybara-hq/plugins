---
name: onboarding
description: "Gets a person ready to contribute to a capybara-hq repository: runs pnpm doctor:env, explains and fixes what fails (only with the user's agreement), sets up the upstream remote or a fork, then gives a short tour of the repository, its rules and skills, the daily flow and open good first issues. Use on first contact with the repository, or when the user says things like 'set up', 'get me set up', 'getting started', 'onboard me', 'I'm new here', 'how do I contribute', 'check my environment' or 'why doesn't my setup work'."
# Synced from capybara-hq/.github. Edit the source there, then run sync.
metadata:
  source: capybara-hq/.github
  version: v1.0.0
  sha256: 5f7e1d51eaa1059ed83a6dfc4229d237a325c0fa16e0a9018b6ce8626c699543
---

# Onboarding

Goal: the person's checkout passes every required item of `pnpm doctor:env`, and they know how work
is done in this repository. Works the same for core developers (write access) and community
contributors (working from a fork).

## Rules

- **Run the repository's commands; do not re-implement them.** `pnpm doctor:env` decides what is
  checked. Do not invent your own checks or replace a failing check with a workaround.
- **Outward actions only after the user agrees**: creating a fork, adding or renaming remotes,
  changing git config, logging in to `gh`. Say exactly what you are about to run and why, then
  wait for a yes (unless the user already told you to go ahead).
- **Never print secrets.** Do not read, print or ask the user to paste tokens, keys, passwords or
  the contents of env files. Report only whether a variable or file exists. Never run
  `gh auth token` or `gh auth status --show-token`. Interactive logins (`gh auth login`) are typed
  by the user, not by you.
- If something needs a decision only the user can make, stop and ask.

## 1. Run doctor

1. Run `pnpm -s doctor:env --json` from the repository root. Keep the `-s`: without it the script
   banner on stdout breaks JSON parsing, and `-s` leaves only the JSON.
2. If it cannot run at all (no Node, no pnpm, "command not found", missing script), read the
   prerequisites in `README.md` / `AGENTS.md`, tell the user what to install, and stop until they
   have done it. Do not install system tools without their agreement.
3. Parse the JSON: `{ "ok": boolean, "checks": [{ "id", "title", "status", "detail", "fix"? }] }`.
   `status` is `pass`, `fail`, `warn` or `skip`. The command exits 0 exactly when nothing is `fail`.

## 2. Explain and fix

Show the user a short list: every `fail` first, then every `warn`, each with its `title`, the
`detail` in plain words, and the `fix` if there is one. Skip the `pass` items unless asked.

Then, for each `fail`:

- If the fix needs no decision (for example installing dependencies), offer `pnpm doctor:env --fix`,
  which performs only such fixes. Run it after the user agrees.
- Otherwise show the `fix` command and either run it after the user agrees or let them run it.
  Typical cases:
  - **Git identity missing**: ask for the name and email they want to use; do not guess.
  - **`gh` not logged in** (usually a `warn`): ask the user to run `gh auth login` themselves.
  - **Remotes**: see section 3.

`warn` items are optional. Explain what they affect (for example "needed only for the dev stack")
and let the user decide.

Re-run `pnpm -s doctor:env --json` after the fixes. Repeat until no item is `fail`, or until what is left
needs the user (then say what is left and stop).

## 3. Remotes and the kind of contributor

The **upstream** is the remote whose URL points to `capybara-hq/<repo>` (HTTPS
`https://github.com/capybara-hq/<repo>` or SSH `git@github.com:capybara-hq/<repo>.git`). Find it
with `git remote -v`; `<repo>` is the repository name in that URL.

- **Upstream is `origin`**: the person works in the main repository. Check their access with
  `gh repo view capybara-hq/<repo> --json viewerPermission`. `ADMIN`, `MAINTAIN` or `WRITE` means
  core developer: they push branches to `origin`. Anything else means they cloned without a fork
  and cannot push; offer `gh repo fork --remote`, which creates their fork, renames the current
  `origin` to `upstream` and adds the fork as `origin`. This creates a repository on their account,
  so run it only after they agree.
- **Upstream is another remote** (normally `upstream`): community contributor working from a fork.
  `origin` is their fork; they push there.
- **No remote points to `capybara-hq`**: show the `fix` from doctor (adding the remote) and run it
  after the user agrees.

Tell the user which kind they are; the `contributing` skill relies on the same detection.

## 4. Short tour

Keep it short: a few lines per item, links rather than copies.

1. **What this repository is**: summarize the opening of `AGENTS.md` (purpose, layout, the main
   rules) in a few sentences. `AGENTS.md` is the authority on this repository's rules; point to it.
2. **Which skill for which change**: list the skills in `.agents/skills/` and any others that
   `AGENTS.md` points to, with one line each on when to read them. Say that before changing an area, the agent
   reads `AGENTS.md` and the skill for that area.
3. **The daily flow** (details in the `contributing` skill):
   - Find or open an issue. Community contributors need one that a maintainer labeled `accepted`
     (or `good first issue` / `help wanted`), and claim it by commenting `/claim`. No exemptions,
     not even for typo fixes. Core developers may start without an issue.
   - Start a branch in a worktree from upstream `main` (say "start on issue #N").
   - For larger changes, write the design doc first if `AGENTS.md` requires it.
   - Run `pnpm verify` before pushing.
   - Open the PR with `Closes #N` (say "open a PR"); answer review (say "address review").
   - Only a maintainer approves and merges.
4. **Something to work on**: list open, unassigned issues for newcomers, for example
   `gh issue list --repo capybara-hq/<repo> --label "good first issue" --search "no:assignee" --state open`
   and the same with `--label "help wanted"`. Show number, title and labels. If `gh` is not logged
   in, give the web link `https://github.com/capybara-hq/<repo>/contribute` instead.

End by asking what they want to do next.
