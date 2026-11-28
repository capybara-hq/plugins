---
name: test-planning
description: "Use when testing a Projects task or verifying a bug fix: deriving a test plan from the parent requirement's acceptance criteria, running it, recording the results on the item, filing bugs linked to the task, and moving the item on or back."
---

# Testing a task or verifying a fix

Testing checks the work against what was asked for, not against what was built. The source of
truth is the acceptance criteria of the requirement above the task (its parent) and the task's own
description.

## Test plan

Read the task (`item_get`), its parent requirement and linked items, and the artifacts the
engineer attached (pull requests, design). Then write the plan as a comment (`item_comment`), or
attach it with `artifact_attach` when it is published elsewhere:

```markdown
## Test plan for KEY
Scope: what is tested and what is not.
Environment: where it runs (branch, build, device, data).

| # | Case | Criterion | Steps | Expected |
|---|------|-----------|-------|----------|
| 1 | ...  | R1        | ...   | ...      |

Edge cases: empty input, limits, permissions, concurrent use, errors from dependencies.
Regression: existing behavior next to the change that must still hold.
```

Every acceptance criterion maps to at least one case. A criterion that cannot be tested as
written is a question for the requirement's person (`decision_ask`), not a guess.

## Running it

- Run the cases in the environment the plan names, and keep the evidence: commands and their
  output, logs, screenshots.
- Record the result as a comment: each case passed or failed, with the evidence for a failure.

## Bugs

- Each failure is its own bug: `item_create` with type `bug`, a title naming the wrong behavior,
  and a description with the steps to reproduce, expected and actual results, the environment
  and the evidence.
- Link it to the task: `item_link` with `relates` (or `blocks` when the task cannot be accepted
  until it is fixed). Without a responsible person, a new bug follows its workflow's default
  assignment.
- Search first (`item_search`) so a known bug is linked, not filed twice.

## Moving on

- All cases pass and no blocking bug is open: move the task to its done status (or a bug from
  verifying to closed).
- Failures that block acceptance: move the item back to its in-progress status (a bug back to
  fixing), with a comment listing the failed cases and the bugs filed. A status with a default
  assignment hands the item over by itself; one without keeps it with you, and `item_assign`
  gives it back to the person who worked on it (the activity in `item_get` shows who), after
  your person confirms.
