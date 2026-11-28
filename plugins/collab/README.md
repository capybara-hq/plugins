# @capybara-hq/plugin-collab

A project tracker for people and agents (项目协作 / Projects). Projects hold **items**
(requirements, tasks and bugs), each moving through its type's **workflow**. An item has a
**responsible person** and, optionally, the **agent** that works on it for that person. Statuses
can carry a **gate** (entering them needs a person's confirmation) and a **default assignment**
(entering them hands the item to the next person and their agent). Agents and people ask each other
**decisions**, attach **artifacts** (links such as pull requests or documents) and comment.

What the plugin does:

- **Pages** (an org page in the primary navigation): the project list, a project's board and table,
  the item page (description, activity, decisions, artifacts, children, links, conversations) and
  the project settings (members, function labels, default agents, gates and default assignments).
- **A panel and a properties section** in an item's conversation, and an item list on the agent page.
- **Tools** an agent uses to read and work on items as its person.
- **Events** (`trigger-source@1`) that automations react to. Assignment is a **directed** event:
  it reaches the assigned person's agent through that person's acceptance rule (`auto`, `confirm` or
  `off`, set in the person's settings; the org default is `auto`), which opens the item's own
  conversation for the pair and keeps using it.
- **Inbox items**: assignment notices (with a "Stop agent" button), decisions and gate
  confirmations (with answer buttons), reminders and escalations, and "pick who gets it" requests
  to the project owner when a default assignment matches nobody or several people.
- **Agent run state** on items (working, waiting, idle, declined) from the kernel's `run.lifecycle`
  hook.
- **Agent templates and skills** (see below).

## How an item moves

New projects start with three item types (editable per status afterwards):

| Type | Workflow | Gates | Default assignments |
|---|---|---|---|
| Requirement | backlog → drafting → review → ready → in progress → acceptance → done (canceled) | ready (project owner), done (the requester, owner fallback) | ready → an `engineering` member and their default agent |
| Task | to do → in progress → testing → done (canceled) | none | testing → a `qa` member and their default agent |
| Bug | open → fixing → verifying → closed (won't fix) | none | open → an `engineering` member, verifying → a `qa` member, each with their default agent |

- **Gates.** Moving an item into a gated status as its confirmer moves it. Anyone else (an agent,
  or a person dragging a card) creates a gate decision addressed to the confirmer: it waits in their
  inbox and on the item page, and the item stays where it is until they approve. An approval
  applies only to the move it was asked for: once the item moved on, the request is canceled.
  A gate on a function label asks every member with that label; the first answer settles it.
- **Default assignments** hand the item to the member the rule names (or the member with the
  function label) and, with `memberAgent`, their default agent in the project. An agent the person
  may no longer use is dropped and the activity says so.
- **Parents.** When every child of a requirement is closed, the requirement moves to acceptance on
  its own and the done gate is asked of its requester at once.
- **Removing a member** (or making them a guest) hands their open items back to the project owner
  and re-addresses their open decisions.
- Assigning someone else through a tool always asks the conversation's person first; the person
  clicking in the pages is the consent. Taking an item away from an agent tells it to stop
  (writes from its old conversation are refused).

## Permissions it asks for, and why

| Permission | Why |
|---|---|
| `tools` (13, below) | The agent tools. |
| `triggers.emit` (9 event types) | Emitting item and decision events for automations and acceptance. |
| `inbox` | Assignment notices, decisions, gate confirmations, reminders and escalations. |
| `agents.read` | Checking that an agent is one the responsible person may use (`usableBy`), and agent names. |
| `conversations.subjects` | Finding the conversations that serve an item (`bySubject`): the item's panel, the old agent's refusal, run state. |
| `people.read` | Names and avatars, active org membership when adding project members, the people picker. |
| `hooks: run.lifecycle` | Recording the executing agent's run state on the item (observe only, never denies). |
| `client` + `ui.components` | The project pages, the conversation panel and properties section, the agent page section. |

It asks for no storage, network, sandbox, model or secret access, and has no configuration.

## Tools (`plugin__collab__<key>`)

| Key | What it does | Default policy |
|---|---|---|
| `project_list` | Projects the person belongs to, their role, members with function and default agent | allow |
| `project_create` | Creates a project with the default types (the person becomes owner) | ask |
| `item_search` | Searches items by project, title words or key, status, type, "assigned to me" | allow |
| `item_get` | One item in full, with the allowed next statuses and the `version` | allow |
| `item_create` | Creates an item (another responsible person asks first) | allow |
| `item_update` | Changes title, description, priority, labels, parent, custom fields | allow |
| `item_transition` | Moves the item to another status (a gate asks its confirmer) | allow |
| `item_assign` | Assigns a person and agent (anyone but the person asks first) | allow |
| `item_comment` | Comments in Markdown | allow |
| `item_link` | Links two items (blocks, relates, duplicates) | allow |
| `artifact_attach` | Attaches an http(s) link as a versioned artifact | allow |
| `decision_ask` | Asks a person to decide, with options and a recommendation | allow |
| `decision_list` | Decisions of an item, by state, or addressed to the person | allow |

The tools act as the **conversation's owner**; a run started by another member is refused. Every
write takes the `version` the agent last read and returns the new one.

## Events

`item.created`, `item.updated`, `item.status_changed`, `item.assigned` (directed),
`item.unassigned` (directed), `item.commented`, `item.closed`, `decision.answered` (directed, to the
asking pair while it holds the item), `gate.requested`.

Every event carries the filterable facts `projectKey`, `itemType`, `status`, `statusCategory`,
`priority`, `labels`, `responsibleAccountId`, `executingAgentId`, `mentions`, `changedFields`.
Events are written to an outbox in the same transaction as the change and emitted after the
commit; a per-org drain job (queued before the write) re-emits anything a crash or an outage left
behind, retrying on a ladder up to an hour. The kernel dedupes on the event's key, so a row emitted
twice is one event. Only people the project shows the item to see its events.

## Agent templates and skills

- Agents: **product** (turns a requirement into a PRD, asks decisions, requests review and
  readiness), **engineer** (designs, splits into tasks, implements in the person's device, attaches
  pull requests, hands tasks to testing, fixes bugs) and **qa** (plans and runs tests, files bugs,
  verifies fixes).
- Skills: `collab-workflow` (how work arrives and how to use the tools), `prd-writing`,
  `test-planning`.

## Limits

- Board: 500 cards per type (open first, then the newest closed); table pages of up to 100 rows;
  activity in pages of 50; page results stay under ~900 KB (larger lists say they were truncated).
- Decisions: question ≤ 2000 characters, ≤ 10 options, deadline ≤ 30 days; at most 5 open questions
  per item and asker, an identical open question is not asked twice; open decisions expire after
  30 days. Inbox buttons appear for up to 3 options; more are answered on the item page.
- Item descriptions ≤ 50 000 characters, titles ≤ 200, ≤ 20 labels; comments in the activity are
  clipped at 4 000 characters (the full comment opens on demand).
- Event rows not emitted within a day are given up with a warning; emitted rows are pruned after
  7 days, given-up rows after 30.
- Settings edit gates and default assignments per status, project name, description and archive;
  adding or reordering statuses and types is not available yet.
- Artifacts are links only (no file upload).

## Development

```bash
pnpm exec vitest run plugins/collab          # unit, page, client and kernel tests
pnpm exec vitest run plugins/collab/test/emit.dual.test.ts   # two replicas, about two minutes
pnpm exec capybara-plugin pack plugins/collab --out artifacts/plugins
```
