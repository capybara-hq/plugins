# Collab Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, with `wave-planned-subagent-development` on top. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@capybara-hq/plugin-collab`: projects, items (requirement / task / bug) with
workflows and gates, assignment to a responsible person plus an executing agent, decisions,
artifacts, a board and item pages, agent tools, and product / engineer / QA agent templates.

**Architecture:** One extension. Data in `plugin_collab` (migrations, Kysely store); domain
services own every write and append to `activity` and `event_outbox` in the same transaction; a
`ctx.queue` job emits outbox rows through `ctx.triggers.emit`; the extension provides
`trigger-source@1` (event declarations, visibility by project membership). Pages are L2
components (`frame: "page"`) reading through `ctx.ui.query` and writing through `ctx.ui.action`.
Agents act through 13 tools. Notifications go to the kernel inbox (`ctx.inbox`); run state comes
back through the `run.lifecycle` hook.

**Tech Stack:** TypeScript, `@capybara-hq/plugin-sdk`, `@capybara-hq/plugin-client`, Kysely,
React (client entry), vitest (+ jsdom, `@capybara-hq/testing` kernel), capybara-plugin toolchain.

**Spec:** core `docs/superpowers/specs/2026-11-25-collaboration-design.md` (§3, §5–§7) and
`2026-11-25-plugin-full-pages-design.md`; kernel contracts from core plans
`2026-11-25-collaboration-kernel.md` (B1, B3, C1–C4) and `2026-11-25-plugin-full-pages.md` (F1, F5).

## Global Constraints

- Step 0 of execution: core PR B, PR C and the full-pages PR are released; this repo's
  `pnpm-workspace.yaml` overrides bump `plugin-sdk`, `plugin-client`, `kernel`, `testing`,
  `plugin-tools`, `plugin-model-fake` to those versions (one instance each).
- Package `@capybara-hq/plugin-collab`, directory `plugins/collab`, starting version
  `0.1.0-rc.0` in `package.json`, `.capybara-plugin/plugin.json` and `src/index.ts`.
- Dependencies: `@capybara-hq/plugin-sdk`, `kysely` only (plugin-client as peer + dev); never the
  kernel; no `workspace:` links.
- Migrations: `plugin_collab`, `IF NOT EXISTS`, expand-only, kernel ids as `text`, every table has
  `org_id text not null` and every query filters it.
- Multi-replica: no timers or module state on the server; delayed work via `ctx.queue` with
  deterministic job ids without `:`; every `ctx.kv` write has a TTL.
- Tool keys `plugin__collab__<name>` ≤ 64 chars, no dots; English descriptions and actionable
  errors; declared in `permissions.tools`.
- Model-visible text English; UI copy zh + en (client `src/client/i18n.ts`), zh says 智能体.
- Default workflow per type (seeded on project create, editable):
  - requirement: `backlog` 待规划 → `drafting` 编写中 → `review` 待评审 (gate: project owner) →
    `ready` 已就绪 (default assignment: function `engineering` + its agent) → `in_progress` 开发中 →
    `acceptance` 待验收 (gate: responsible person) → `done` 已完成; `canceled` 已取消.
  - task: `todo` 待处理 → `in_progress` 进行中 → `testing` 待测试 (default assignment: function `qa`) →
    `done` 已完成; `canceled`.
  - bug: `open` 待修复 (default assignment: function `engineering`) → `fixing` 修复中 →
    `verifying` 待验证 (default assignment: function `qa`) → `closed` 已关闭; `wont_fix` 不修复.
- A parent requirement in `in_progress` moves to `acceptance` when every child is `done` /
  `canceled` (spec §7 step 5).
- Assigning an item to another person always asks the run's person through `InputRequired`
  confirmation (spec §6.4: fixed ask, never grantable); assigning yourself or your own agent does
  not ask.
- Removing the executing agent: its run finishes the turn; its next write tool call on that item
  fails with `no longer assigned` (spec §6.1).

## Review Focus

1. **Two people move the same card at once:** one wins, the other sees a conflict toast and the
   fresh board (optimistic `version`). Task C3 (`concurrent transition: second gets version_conflict`).
2. **Item keys under concurrency:** two replicas creating items in one project never share a key.
   Task C3 (`parallel creates allocate distinct keys`).
3. **A member removed from the project:** loses page access, tools refuse, `visible()` drops them,
   assignments to them are flagged. Task C4 (`removed member is not visible`) and C5.
4. **An agent tool call on an item the person cannot see** (a key guessed): `not found`, never a
   leak of the title. Task C5 (`item_get on a foreign project returns not found`).
5. **Emit fails (kernel down / plugin disabled mid-flight):** outbox row stays, the job retries,
   no duplicate event (stable `dedupeKey`). Task C4 (`emitter retries with the same dedupeKey`).

---

### Task C1: Scaffold and manifest

**Files:**
- Create: `plugins/collab/{package.json,tsconfig.json,README.md,CHANGELOG.md,icon.svg}`, `plugins/collab/.capybara-plugin/plugin.json`, `plugins/collab/src/index.ts`, `plugins/collab/test/tsconfig.json`
- Modify: root `tsconfig.json` references (`plugins/collab`, `plugins/collab/test`), `tsconfig.test.json` exclusion
- Create: `.changeset/collab-plugin.md` (`"@capybara-hq/plugin-collab": patch`)
- Test: `plugins/collab/test/manifest.test.ts`

**Interfaces:**
- Produces: `src/index.ts` default export `defineExtension({ name: "collab", version, provides: ["trigger-source@1"], migrations: "../migrations", ui: [...], permissions: {...}, setup })` with
  - `ui`: `{ id: "projects", slot: "org.page", kind: "component", frame: "page", nav: "primary", title: {zh:"项目",en:"Projects"}, icon: "kanban" }`, `{ id: "item-panel", slot: "conversation.panel", kind: "component" }`, `{ id: "item-properties", slot: "conversation.properties.section", kind: "component" }`, `{ id: "agent-items", slot: "agent.detail.section", kind: "component" }`
  - `permissions`: `tools` (13 keys, Task C5), `triggers.emit` (Task C4 list), `inbox: true`, `agents: { read: true }`, `conversations: { subjects: true }`, `people: { read: true }`, `hooks: ["run.lifecycle"]`, `client: true`, `ui.components: ["projects","item-panel","item-properties","agent-items"]`
  - `setup(ctx)` wires Tasks C3–C8 modules; each module exports `register(ctx: ExtensionContext, deps): void`.

- [ ] **Step 1:** failing `manifest.test.ts`: `validateManifest(manifest).ok`, versions equal across the three files, every declared tool key ≤ 64.
- [ ] **Step 2–4:** scaffold from `plugins/memory` → PASS; `pnpm check` (pack, release metadata, icons after `pnpm icons:generate`) PASS.
- [ ] **Step 5: Commit** `feat(collab): scaffold the collab plugin`.

### Task C2: Schema and store

**Files:**
- Create: `plugins/collab/migrations/0001_init.sql`, `plugins/collab/src/store/{db.ts,types.ts}`
- Test: `plugins/collab/test/migration.test.ts`, `test/helpers.ts` (`migrate(pgUrl)`, `pluginDb()` as in memory)

**Interfaces:**
- Produces tables (all with `org_id text not null`, `created_at timestamptz default now()`):
  `projects (id uuid pk, key text, name, description, archived bool, next_item_number int default 1, owner_account_id text)` unique `(org_id, key)`;
  `project_members (project_id, account_id, role text check in ('owner','member','guest'), function_label text null)` pk `(project_id, account_id)`;
  `workflows (id, project_id, item_type text)`; `statuses (id, workflow_id, key, name_zh, name_en, category text check in ('backlog','todo','in_progress','review','done','canceled'), position int, next_keys text[] null, gate jsonb null, default_assignment jsonb null)`;
  `item_types (project_id, key, name_zh, name_en, icon, workflow_id)`;
  `items (id uuid pk, project_id, number int, type, title, description text default '', status_key, responsible_account_id text, executing_agent_id text null, priority int default 3, labels text[] default '{}', parent_id uuid null, fields jsonb default '{}', version int default 1, closed_at null)` unique `(project_id, number)`;
  `item_watchers`, `item_links (from_id, to_id, kind check in ('blocks','relates','duplicates'))`, `comments (id, item_id, author jsonb, body)`,
  `activity (id, item_id, actor jsonb, kind text, detail jsonb)`,
  `artifacts (id, item_id, kind, name, version int, storage_key text null, url text null, author jsonb)`,
  `decisions (id, item_id, kind check in ('question','gate'), asker jsonb, addressee_account_id, question, options jsonb, recommendation jsonb, blocking bool, state check in ('open','answered','canceled','expired'), answer jsonb null, deadline_at null, gate_target text null)`,
  `event_outbox (id uuid pk, org_id, type, subject jsonb, facts jsonb, summary, dedupe_key text unique, audience jsonb null, cause jsonb null, emitted_at null, attempts int default 0)`.
- Actor JSON: `{ accountId } | { accountId, agentId, conversationId }`.

- [ ] **Step 1:** failing migration test: tables exist in `plugin_collab`; `(project_id, number)` unique; re-running the migration is a no-op.
- [ ] **Step 2–4:** write SQL + Kysely types → PASS.
- [ ] **Step 5: Commit** `feat(collab): schema`.

### Task C3: Domain services

**Files:**
- Create: `plugins/collab/src/domain/{projects.ts,items.ts,workflow.ts,assignment.ts,access.ts,errors.ts,seed.ts}`
- Test: `plugins/collab/test/domain/*.test.ts` (real PG via helpers)

**Interfaces:**
- Produces:

```ts
type Actor = { accountId: string } | { accountId: string; agentId: string; conversationId: string };
class CollabError extends Error { code: "not_found" | "forbidden" | "version_conflict" | "invalid_transition" | "gated" | "invalid_assignee" | "no_longer_assigned" }
// access.ts
canSee(db, orgId, accountId, projectId): Promise<boolean>;  roleIn(db, orgId, accountId, projectId): Promise<Role | null>;
// projects.ts
createProject(db, orgId, actor, { key, name, description? }): Promise<Project>;  // seeds types + workflows (seed.ts)
addMember / removeMember / setFunction(db, orgId, actor, projectId, accountId, …)
// items.ts
createItem(db, orgId, actor, { projectId, type, title, description?, parentId?, responsibleAccountId?, executingAgentId?, priority?, labels? }): Promise<Item>;
updateItem(db, orgId, actor, itemId, version, patch): Promise<Item>;
transition(db, orgId, actor, itemId, version, toStatus): Promise<{ item: Item } | { gate: Decision }>;
comment(db, orgId, actor, itemId, body): Promise<Comment>;  link(...); attachArtifact(...)
// assignment.ts
assign(db, orgId, actor, itemId, version, { responsibleAccountId, executingAgentId | null }): Promise<Item>;
resolveDefaultAssignment(db, orgId, projectId, status): Promise<{ accountId: string; agentId: string | null } | null>;
```

- Every write: one transaction (`db.transaction()`), appends `activity` and the matching `event_outbox` rows (Task C4 `outboxFor(...)`), bumps `version` (mismatch → `version_conflict`).
- Key allocation: `UPDATE projects SET next_item_number = next_item_number + 1 … RETURNING` inside the create transaction.
- `transition` to a gated status by an agent actor → creates a `gate` decision (Task C7) and returns `{ gate }`; by a person who is the gate's confirmer → moves. Entering a status with `default_assignment` calls `assign` (function label → the project's member with that label; none or several → leave unchanged and post an inbox item to the project owner).
- Parent auto-move per Global Constraints.

- [ ] **Step 1: failing tests**: `parallel creates allocate distinct keys`; `concurrent transition: second gets version_conflict`; `next_keys restricts transitions`; `agent into gated status returns a gate decision`; `entering ready reassigns to the engineering member and their agent`; `parent moves to acceptance when children are done`; `guest cannot create items`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(collab): projects, items, workflows, assignment`.

### Task C4: Events: outbox, emitter, trigger source

**Files:**
- Create: `plugins/collab/src/events/{declarations.ts,outbox.ts,emitter.ts,source.ts,summary.ts}`
- Test: `plugins/collab/test/events/*.test.ts`

**Interfaces:**
- Produces: event types (`permissions.triggers.emit`): `item.created`, `item.updated`, `item.status_changed`, `item.assigned` (directed), `item.unassigned` (directed), `item.commented`, `item.closed`, `decision.answered` (directed), `gate.requested`.
- Facts (all filterable): `projectKey` string, `itemType` string, `status` string, `statusCategory` string, `priority` number, `labels` string[], `responsibleAccountId` string, `executingAgentId` string, `mentions` string[], `changedFields` string[].
- `outboxFor(tx, orgId, type, item, extra): Promise<void>` writes a row with `dedupe_key = <type>-<item.id>-<item.version>` (`decision.answered`: `-<decision.id>`).
- `emitter.ts`: after a write commits, the request path emits each new outbox row at once and sets
  `emitted_at`; a write made by a tool passes `cause: { call }` (the live `ToolCallContext`, which
  the kernel verifies and uses for depth and the self-trigger rule). Every row also owes a
  `ctx.queue` job `collab-emit-<outboxId>` (registered as `collab-emit`) that emits rows still
  without `emitted_at` (a failed or interrupted emit) with `cause: { accountId }`; failures rethrow
  so the queue retries, and the kernel dedupes on `dedupeKey`. The retry path loses the run link
  (no depth, no self-trigger check by run): rare, and the item's `audience` and facts are unchanged.
  Subject: `{ kind: "item", id, title: "<KEY-n> <title>", url: "/p/collab/projects?item=<KEY-n>" }`.
- `summary.ts`: English, ≤ 4096 bytes, e.g. `Status changed from "Drafting" to "Review" by Li (product agent).` plus changed fields; never the full description (first 500 chars).
- `source.ts`: `TriggerSource` with `events()` from declarations and `visible({ orgId, accountIds, subject })` = members of the item's project.

- [ ] **Step 1: failing tests**: `every domain write leaves exactly one outbox row with a stable dedupeKey`; `emitter retries with the same dedupeKey`; `removed member is not visible`; `summary stays under 4096 bytes for a huge description`; `tool-originated writes emit with cause.call`; `a failed emit is retried by the queue job with cause.accountId`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(collab): item events and the trigger source`.

### Task C5: Agent tools

**Files:**
- Create: `plugins/collab/src/tools/{index.ts,projects.ts,items.ts,decisions.ts,format.ts}`
- Test: `plugins/collab/test/tools/*.test.ts`

**Interfaces:**
- Produces 13 tools (`ctx.tools.register`), each acting as `call.ownerAccountId` (the conversation's person) with actor `{ accountId, agentId: call.agentId, conversationId: call.conversationId }`:
  `project_list`, `project_create`, `item_search` (`{ project?, query?, status?, type?, assignedToMe?, limit ≤ 50 }`), `item_get` (`{ key }`: fields, children, links, open decisions, last 20 activity), `item_create`, `item_update` (`{ key, version, patch }`), `item_transition` (`{ key, version, to }` → moved, or "gate requested, waiting on <name>"), `item_assign` (`{ key, version, responsible, agent? }`), `item_comment`, `item_link`, `artifact_attach` (`{ key, kind, name, url? | fileRef? }`), `decision_ask` (Task C7), `decision_list`.
- `item_assign` to another person returns `InputRequired` (confirm question: "Assign <KEY> to <name> and their agent <agent>?") on first call; the resumed call performs it.
- Write tools on an item whose `executing_agent_id` ≠ `call.agentId` while the call's agent was the previous executor → `no_longer_assigned` (actionable error text).
- Output: compact English text plus `display` card where useful; `version` always returned for follow-up writes.

- [ ] **Step 1: failing tests**: `item_get on a foreign project returns not found`; `item_assign to another person asks first, then assigns on resume`; `item_assign to self does not ask`; `write after unassignment fails with no_longer_assigned`; `item_transition into a gate reports waiting`; tool design check (`pnpm check`) passes descriptions.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(collab): agent tools`.

### Task C6: Assignment notices and run state

**Files:**
- Create: `plugins/collab/src/notify.ts`, `plugins/collab/src/lifecycle.ts`
- Modify: `migrations/0002_agent_state.sql` (`items.agent_state text null check in ('working','waiting','idle','declined')`, `items.agent_conversation_id text null`)
- Test: `plugins/collab/test/notify.test.ts`, `test/lifecycle.test.ts`

**Interfaces:**
- `notifyAssigned(ctx, orgId, item, byActor)`: `ctx.inbox.post({ accountId: responsible, kind: "collab.assigned", title: "<KEY-n> assigned to you", body: "<agent name> is working on it" | "", link: "/p/collab/projects?item=<KEY-n>", actions: [{ id: "stop", label: {zh:"停止智能体",en:"Stop agent"}, style: "danger", uiAction: { contribution: "projects", actionId: "inbox.stop-agent", payload: { itemId } } }] })`; skipped when the responsible person assigned themselves.
- `ctx.hooks.on("run.lifecycle", p => …)`: `started` → `working` + `agent_conversation_id`; `waiting` → `waiting`; `finished`/`failed` → `idle`; `offer_declined` → `declined` + activity entry; then `ctx.ui.invalidate({ orgId, contribution: "projects" })`.

- [ ] **Step 1: failing tests**: `assignment by someone else posts one inbox item with a stop action`; `stop action unassigns the agent and records activity`; `lifecycle phases update agent_state and invalidate`; `offer_declined marks declined`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(collab): assignment notices and agent state`.

### Task C7: Gates and decisions

**Files:**
- Create: `plugins/collab/src/domain/decisions.ts`, `plugins/collab/src/decisions-queue.ts`
- Test: `plugins/collab/test/domain/decisions.test.ts`

**Interfaces:**
- `askDecision(db, orgId, actor, { itemId, question, options: { id: string; label: string }[], recommendation?: { optionId: string; why: string }, blocking: boolean, addressee?: accountId, deadlineHours?: number }): Promise<Decision>` (addressee defaults to the item's responsible person); posts `ctx.inbox` item `collab.decision` with up to 3 option actions (more options → link only) calling `inbox.answer`.
- `answerDecision(db, orgId, personAccountId, decisionId, { optionId?, text? })`: persons only (UI action path); writes `decision.answered` outbox row directed to `{ accountId: item.responsible, agentId: asker.agentId }` with the answer in the summary; gate decisions apply the transition on approve.
- Deadlines: `ctx.queue` job `collab-decision-remind-<id>` at the deadline → inbox reminder; `collab-decision-escalate-<id>` at deadline + 24 h → inbox to project owner.
- Tool `decision_ask` returns: blocking → "Asked <name>. Stop work that depends on this answer; the answer will arrive in this conversation."; non-blocking → "Asked <name>. Proceed with the recommended option; the answer will arrive in this conversation."

- [ ] **Step 1: failing tests**: `answer emits decision.answered directed to the asking agent`; `only a person can answer` (tool path has no answer tool; UI action with a person passes); `approving a gate moves the item, rejecting keeps it`; `deadline reminds then escalates once` (deterministic job ids, idempotent on retry).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(collab): decisions and gates`.

### Task C8: Page server half: queries and actions

**Files:**
- Create: `plugins/collab/src/page/{queries.ts,actions.ts,people.ts}`
- Test: `plugins/collab/test/page/*.test.ts`

**Interfaces:**
- `ctx.ui.query("projects", handler)` queries: `projects.list`, `project.board` (`{ project }` → columns from the type's workflow incl. `locked` for gates + cards ≤ 500 with responsible/agent display), `project.items` (paged table rows, `{ project, page, pageSize ≤ 100, sort, filter }`), `item.detail` (`{ key }`), `item.activity` (`{ key, before? }`), `project.settings`, `people.search` (`ctx.people.search`), `agents.usable` (`ctx.agents.usableBy` for a chosen responsible), `item.conversations` (`ctx.conversations.bySubject`).
- `ctx.ui.query("item-panel" | "item-properties", …)`: `item.byConversation` (subject from the panel args' conversation) ; `"agent-items"`: `agent.items`.
- `ctx.ui.action("projects", …)` actions: `project.create`, `item.create`, `item.update`, `item.move` (`{ itemId, version, to }` → `{ invalidate: ["project.board"] }` or `{ toast }` for a gate request / conflict), `item.assign`, `item.comment`, `gate.confirm`, `inbox.stop-agent`, `inbox.answer`, `decision.answer`, `settings.save`, `member.add|remove|function`.
- Every handler checks `canSee` / role first; responses carry `version`.

- [ ] **Step 1: failing tests**: `board query returns locked gate columns and ≤ 500 cards`; `move into a gate returns a toast and creates a gate decision`; `version conflict returns a conflict toast and invalidates`; `non-member gets not found for every query`; `gate.confirm by a non-confirmer is forbidden`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(collab): page queries and actions`.

### Task C9: Client pages and panels

**Files:**
- Create: `plugins/collab/src/client.tsx` (`defineClientExtension({ name: "collab", components: { projects, "item-panel", "item-properties", "agent-items" } })`), `plugins/collab/src/client/{router.tsx,projects-list.tsx,board.tsx,items-table.tsx,item-detail.tsx,item-form.tsx,settings.tsx,panel.tsx,agent-items.tsx,i18n.ts}`
- Test: `plugins/collab/test/client/*.test.tsx` (`// @vitest-environment jsdom`, `renderWithFakeHost` with `queries` and `params`)

**Interfaces:**
- Consumes: forwarded templates/components and hooks (full-pages plan F1/F5).
- `router.tsx` maps `usePageParams()`: none → `ProjectsList` (ListPage + DataTable); `project=KEY` (+ `view=board|list`, default board) → `Board` page (ListPage with toolbar Segmented board/list, filter chips, "新建事项"); `item=KEY-n` → `ItemDetail` (DetailPage, tabs 概览 / 活动 / 产物 / 决策 / 会话; facts: status, responsible + agent, priority, parent); `project=KEY&settings=1` → `Settings` (SettingsPage: members & functions, types & workflows, gates, default assignments). Exactly one template per route.
- `ItemForm`: Dialog with Input title, Textarea + Markdown preview tabs, PrincipalPicker for responsible (people) and agent (`agents.usable` for the chosen person), priority Segmented, labels.
- `panel.tsx`: item card (key, title, status, open decisions with answer buttons) in the conversation panel / properties section; `agent-items.tsx`: ItemList of items the agent executes.

- [ ] **Step 1: failing tests**: `no params renders the projects list`; `project param renders the board with gate columns locked`; `drag to next column calls item.move and invalidates on success`; `item param renders detail tabs`; `agent picker lists only agents usable by the chosen responsible`; `panel shows the item for a collab conversation and nothing otherwise`; `exactly one template per route` (fake host counts).
- [ ] **Step 2–4:** FAIL → implement → PASS; `pnpm check` (client CSS rules if any CSS; prefer none).
- [ ] **Step 5: Commit** `feat(collab): project pages, board, item detail and panels`.

### Task C10: Role agents and skills

**Files:**
- Create: `plugins/collab/agents/{product.md,engineer.md,qa.md}`, `plugins/collab/skills/{collab-workflow,prd-writing,test-planning}/SKILL.md`; list both in `.capybara-plugin/plugin.json`
- Create: `docs/superpowers/plans/2026-11-25-collab-live-acceptance-checklist.md`
- Test: `plugins/collab/test/agents.test.ts`

**Interfaces:**
- Templates (frontmatter per writing-plugins): `model: capable` (product, engineer), `standard` (qa); `skills`: product `[collab-workflow, prd-writing]`, engineer `[collab-workflow]`, qa `[collab-workflow, test-planning]`; `tools` include the collab tools plus, for engineer, the sandbox tools.
- `collab-workflow` states the mechanism only (spec §6, neutral injected context): the item conversation receives item events; read the item with `item_get`; record work as artifacts and comments; ask a decision when a choice needs a person, with options and a recommendation; request gated transitions, never expect to pass them; hand off by moving the item to the next status.
- Live acceptance checklist: spec §7 flow end to end on a dev deployment with real models (PRD artifact quality, two decisions asked, gate stop, handoff to engineer, bug loop, parent auto-acceptance), with pass criteria per step.

- [ ] **Step 1:** failing `agents.test.ts`: every template parses, names its skills, skills exist and pass frontmatter checks.
- [ ] **Step 2–4:** write → PASS; `pnpm check:skills-frontmatter`.
- [ ] **Step 5: Commit** `feat(collab): product, engineer and QA agents`.

### Task C11: End-to-end with a kernel, pack, release

**Files:**
- Create: `plugins/collab/test/kernel.http.test.ts`, `plugins/collab/test/emit.dual.test.ts`, `plugins/collab/test/pack.test.ts`
- Modify: `plugins/collab/README.md`

- [ ] **Step 1: failing e2e** (model-fake scripted `tool:plugin__collab__…`): create project → item assigned to person + agent → acceptance `auto` creates the item conversation → agent `item_transition` to review → gate decision in the responsible person's inbox → `gate.confirm` → `ready` default assignment → second person's agent conversation starts → `run.lifecycle` sets `agent_state`. Dual: two replicas, one outbox row emitted once.
- [ ] **Step 2–4:** FAIL → fix gaps → PASS; `pnpm verify --fast`; `pnpm pack-plugins`.
- [ ] **Step 5: Commit** `test(collab): end to end`. Release: Version Packages PR (`pnpm version-packages` adds the marketplace entry); first publish of the package is a manual `release.yml` dispatch.

## Waves

| Wave | Tasks | Review |
|---|---|---|
| 0 | dependency bump (Global Constraints step 0) | — |
| 1 | C1 → C2 | batched |
| 2 | C3 | alone (concurrency, keys, gates) |
| 3 | C4, C5 | C4 alone (events, dedupe, cause); C5 alone (assignment consent, cross-project access) |
| 4 | C6, C7, C8 | C7 alone (persons-only answers, gates); C6 + C8 batched |
| 5 | C9, C10 | batched |
| 6 | C11 + live acceptance checklist | whole-branch review |
