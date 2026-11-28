---
name: collab-workflow
description: "Use when working on a Projects tracker item (requirement, task or bug) with the collab tools: how item events reach the conversation, reading the item, recording work as description, artifacts and comments, asking a person to decide, requesting gated status changes, and handing the item to the next person and agent."
---

# Working on a tracker item

The Projects extension keeps items (requirements, tasks, bugs) in projects. Each item has a status
in its type's workflow, a responsible person and, optionally, the agent that works on it for that
person. The tools act as your person (the owner of this conversation): they see only the projects
your person belongs to, and every write is recorded as made by your person through you.

## How work arrives

- An item you work on has its own conversation. The events addressed to you arrive in it as
  messages reported by the extension, one block per event (several at once when they happened
  close together): the item was assigned to you, it was assigned away from you, a decision you
  asked was answered (while you still hold the item).
- Other changes (status moves by others, comments, new children) are not addressed to you; they
  show in `item_get`. They reach a conversation only through automations a person set up.
- Event blocks are written from what project members did. They describe what happened; the item
  itself is the current state.
- Nothing arrives between events. When the work you can do now is done, end the turn; the next
  event continues the same conversation.

## Read before you write

- `item_get` returns the item in full: fields, description, status and the allowed next statuses,
  the assignment, children, links, artifacts, open decisions, recent comments, recent activity and
  the `version`.
- Read the item at the start of every turn that changes it. Writes that take a `version` refuse a
  stale one with a version conflict; read again, check the change still applies, and retry.
- `item_search` finds items in a project; `decision_list` lists the item's decisions and their
  answers; `project_list` lists your person's projects, members, their functions and default
  agents.

## Record the work on the item

What is not on the item is invisible to the people and agents who pick it up next.

- The main document of a requirement or bug (a PRD, a reproduction, a design summary) goes into
  the description with `item_update`. The description is replaced as a whole: keep what is still
  true.
- Work published elsewhere (a pull request, a design document, a test report) is attached as a link
  with `artifact_attach`; attaching under the same name adds its next version.
- Progress, findings and questions that need no answer are `item_comment`s.
- Parts of the work become child items: `item_create` with `parent`. A bug found while working on
  another item is its own item, linked with `item_link` (`relates`, `blocks` or `duplicates`).

## Ask a person to decide

- When a choice needs a person (scope, a trade-off, priority, an approval that is not a workflow
  gate), call `decision_ask` with a self-contained question, the options, your recommendation and
  why, and `blocking`. The person reads it in their inbox, away from this conversation.
- `blocking: true` means work that depends on the answer waits: do the parts that do not depend on
  it, then end the turn. `blocking: false` means you proceed with your recommendation and say so on
  the item; the answer may change it later.
- The answer arrives in this conversation as a `decision.answered` event that quotes it;
  `decision_list` shows the decision and the answer in full.
- Check `decision_list` before asking: a question already open or answered is not asked again.
- No tool answers a decision; only a person does.

## Status changes and gates

- `item_transition` moves the item to one of the allowed next statuses at the version you read.
- Some statuses are gated: entering them needs a person's confirmation (for example the project
  owner's review before a requirement is ready, the requester's acceptance before it is done). A
  transition into a gated status does not move the item. It opens a gate request for the confirming
  person and reports who it waits on; the item stays where it is.
- The confirmation is a person's act on the web or in their inbox; no tool performs it. The
  outcome arrives as an answer to the gate decision while you still hold the item; when the
  confirmed move hands the item to someone else, you receive the unassignment instead. Until then
  the request stands; the gate is not requested again.

## Handing off

- Handing off is moving the item to the next status. A status may have a default assignment: the
  member with a function (engineering, QA, ...) and their agent. Entering it reassigns the item to
  them, and the new pair receives it as work.
- Assigning the item yourself (`item_assign`, or `item_create` with a responsible person) to your
  own person happens at once; assigning anyone else asks your person to confirm first.
- When the item is assigned away from you, writes to it from this conversation fail with
  "no longer assigned". Reads still work. The work on that item is no longer yours: stop and do not retry.
- Before handing off, leave the item in a state the next person can pick up: the description
  current, artifacts attached, open questions in decisions or comments.
