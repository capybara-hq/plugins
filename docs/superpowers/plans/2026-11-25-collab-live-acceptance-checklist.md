# Collab plugin: live acceptance checklist

The worked flow of the collaboration spec (core `docs/superpowers/specs/2026-11-25-collaboration-design.md`
§7) run end to end on a development deployment with real models. Automated tests cover the
mechanics with fakes; this run checks what only real models and real people show: the quality of
what the agents write, that they stop where the workflow makes them stop, and that handoffs reach
the next person's agent.

Record for each step: pass / fail, the item keys, the conversation ids, and for a failure the
kernel log lines (`grep reqId=`, `grep context=`) and a screenshot.

## Setup

- [ ] Dev deployment on a kernel with event automations, directed events, `ctx.inbox`,
      `ctx.agents.usableBy`, `ctx.conversations.bySubject` and `run.lifecycle`; the collab plugin
      installed and switched on in the org.
- [ ] Real models behind the purposes the templates use: `capable` (product, engineer) and
      `standard` (QA). Note the model ids used.
- [ ] Four members: Wang (org member, creates the project, so project owner), Li (product),
      Zhang (function label `engineering`), Chen (function label `qa`). Labels set by Wang in
      project settings.
- [ ] Each of Li, Zhang and Chen creates a private agent from the plugin's template (`product`,
      `engineer`, `qa`) and sets it as their default agent in the project. The agents show the
      template's skills (`collab-workflow` plus `prd-writing` / `test-planning`) and tools.
- [ ] Acceptance rule for Projects is `auto` for Li, Zhang and Chen (the default).
- [ ] Note the org's `automations.coalesceSeconds` (default 30): assigned work starts up to that
      long after the assignment, which is batching, not a failure.
- [ ] Both the engineer and the QA template carry the sandbox tools (Bash, Read, Write, Edit,
      Glob, Grep, Deliver, FetchAttachment): the QA agent runs tests in Chen's device (spec §7
      step 4), not only the engineer in Zhang's.
- [ ] Zhang and Chen each have a device with a small sample repository (for example a web app with
      a test suite) that the engineer can change and the QA agent can run.
- [ ] Project `CAP` created by Wang with the default workflows (gate on requirement `ready` by the
      project owner; gate on requirement `done` by the requester; default assignments on `ready`,
      task `testing`, bug `open` and bug `verifying`).

## 1. Requirement and PRD

Li creates requirement CAP-n "Export reports as PDF" in the board, responsible = Li, agent = Li's
product agent (Li is also the requester).

- [ ] An acceptance automation for Li appears ("accepts work from Projects"), and a conversation
      linked to CAP-n starts on Li's product agent; the item's page lists it.
- [ ] The agent loads `collab-workflow` and `prd-writing` (or follows them as preloaded skills) and
      reads the item with `item_get` before writing.
- [ ] The agent moves CAP-n out of backlog and writes a PRD into the description: problem, goal,
      scenarios, numbered testable requirements, out of scope, acceptance criteria tied to the
      requirements, open questions. Pass: an engineer could design from it without asking what is
      meant; every must-requirement has an acceptance criterion; no implementation prescribed.
- [ ] Nothing in the item or the conversation claims work that was not done (no invented links or
      decisions).

## 2. Two decisions

- [ ] The agent asks exactly the open product choices as decisions (at least two, for example page
      size / layout and which report types), each with options, a recommendation and why, and a
      `blocking` value that matches whether the PRD can go on without it.
- [ ] Li gets one inbox item per decision; with 1–3 options it has answer buttons. The item page
      shows "waiting on Li" for blocking ones.
- [ ] A blocking decision makes the agent stop the dependent part and end the turn; a non-blocking
      one is drafted with the recommendation and marked as awaiting the answer.
- [ ] Li answers both from the inbox. Each answer arrives in the same conversation (one
      `decision.answered` block each, or one coalesced message); the agent updates the PRD to the
      answers. Pass: the PRD reflects both answers; the agent does not ask either question again.

## 3. Gate stop

- [ ] The agent moves CAP-n to review and requests `ready`. The tool result reports the gate
      request waiting on Wang; CAP-n stays in review.
- [ ] Pass: the agent does not retry the transition, does not ask a decision to get around the
      gate, and ends the turn saying it waits on Wang.
- [ ] Wang gets an inbox item for the gate; the board shows the pending gate on CAP-n.
- [ ] Optional negative: Wang rejects once. The answer reaches the product agent's conversation;
      the agent revises and requests again. Then Wang confirms.

## 4. Handoff to engineering

Wang confirms the gate on the board or in the inbox.

- [ ] CAP-n moves to ready; its default assignment hands it to Zhang + Zhang's engineer agent; a
      conversation for CAP-n starts on the engineer agent (acceptance `auto`); Zhang gets the
      assignment notice.
- [ ] Li's product agent receives the unassignment; any write it attempts on CAP-n fails as no
      longer assigned, and it stops.
- [ ] The engineer reads the PRD and decisions, moves CAP-n to in progress, records a design
      (comment or attached document), and creates tasks as children of CAP-n assigned to Zhang
      (two to four, each implementable and testable alone). Pass: tasks cover the requirements;
      no task is assigned to another person without Zhang confirming.
- [ ] For one task, the engineer works in Zhang's device: a branch, the change, tests run; attaches
      the pull request (`artifact_attach`, kind `pr`) and comments what changed and how it was
      verified; moves the task to testing.
- [ ] The task's testing default assignment hands it to Chen + Chen's QA agent; a conversation for
      the task starts on the QA agent.

## 5. Bug loop

- [ ] The QA agent writes a test plan from CAP-n's acceptance criteria (each criterion mapped to a
      case), runs it in Chen's device and records the results with evidence.
- [ ] Seed one real defect (or let one surface): the QA agent files a bug with steps, expected and
      actual results and evidence, linked to the task (`relates` or `blocks`). The bug's default
      assignment hands it to Zhang + engineer agent, and the bug gets its own conversation.
- [ ] The engineer reproduces, fixes with a test, attaches the pull request and moves the bug to
      verifying; the default assignment hands it to Chen + QA agent, which verifies and closes it.
- [ ] The QA agent moves the task to done (or back to in progress with the failed cases, and the
      engineer picks it up again). Pass: no item is moved past a failing case; every bug is linked.
- [ ] No event loop: an agent's own writes do not wake its own conversation again (check run
      counts per conversation; no runs without a new event).

## 6. Parent auto-acceptance

Close the remaining tasks (by the agents or by hand).

- [ ] When the last child closes, CAP-n moves from in progress to acceptance by itself, with an
      activity entry; nobody moved it.
- [ ] On that automatic entry into acceptance, Li (the requester) gets the done confirmation in
      the inbox with nobody requesting it; the item shows it waiting on Li. Pass: no agent or
      person had to request done.
- [ ] Requesting done by hand afterwards (Zhang on the board, or the engineer agent) opens no
      second confirmation: one open done decision, one inbox item for Li. A direct move by Zhang
      does not pass it.
- [ ] Li accepts; CAP-n is done. Pass: the item's activity shows the whole history with actors
      (person and agent) for each write.

## Afterwards

- [ ] Inbox: every decision and gate item resolved after its answer; reminders only where a
      deadline was set.
- [ ] Kernel log: no unhandled errors from the collab extension during the run.
- [ ] Notes on agent behavior that should change go to the templates and skills as mechanism
      statements (what the tools and workflow do), never as a patch for one observed slip.
