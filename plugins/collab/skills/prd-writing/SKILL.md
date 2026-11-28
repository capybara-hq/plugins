---
name: prd-writing
description: "Use when drafting or revising a product requirements document (PRD) for a Projects requirement: the sections a PRD has, how it lives in the item description, which open choices become decisions, and when the requirement is ready for review."
---

# Writing a PRD for a requirement

A PRD states what to build and why, precisely enough that an engineer can design it and a tester
can check it, without prescribing the implementation. It lives in the requirement's description
(`item_update`), so everyone who opens the item reads the current version.

## Shape

```markdown
## Problem
Who has the problem, what they do today, what it costs them. Evidence if there is any.

## Goal
The outcome in one or two sentences, and how success is measured.

## Users and scenarios
The users concerned and the scenarios, each as a short narrative from trigger to result.

## Requirements
Numbered, each testable on its own:
1. R1 ... (must)
2. R2 ... (should)

## Out of scope
What this requirement does not cover, to stop scope from growing silently.

## Acceptance criteria
Observable checks tied to the requirements: "Given ..., when ..., then ..." (R1, R2 ...).

## Open questions
Choices not yet made, each with the decision asked for it (or "assumed: ..." for a non-blocking
one).

## Dependencies and risks
Other items, teams or systems this relies on; what could make it fail.
```

Leave out a section that has nothing to say rather than filling it.

## Working through it

1. Read the item (`item_get`): the title, any description already written, comments, linked
   items. Search related items (`item_search`) for prior requirements and known bugs.
2. Draft the PRD into the description. Mark facts you inferred as assumptions.
3. Each open choice that changes what gets built (scope, behavior visible to users, a trade-off
   between requirements) is a decision for the requirement's person: one `decision_ask` per
   choice, with the options, your recommendation and why. A choice that blocks the rest of the
   PRD is `blocking: true`; one you can draft around is `blocking: false`, written into the PRD as
   the recommended option and marked as awaiting the answer.
4. When an answer arrives, update the requirements, acceptance criteria and open questions to
   match it.
5. The PRD is ready for review when every must-requirement has acceptance criteria and no blocking
   decision is open. Then move the requirement to its review status, and from there request the
   next status: a gated one waits for the confirming person.

## Quality checks

- Each requirement is one behavior, testable without reading the others.
- Acceptance criteria name observable results (what the user sees, what the system stores), never
  "works correctly".
- Numbers have units and limits (sizes, counts, time).
- The PRD says what, not how: implementation choices belong to the engineer's design.
