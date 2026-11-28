# Collab Item Watchers Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the implementation. Steps use checkboxes for tracking.

**Goal** — Add personal item subscriptions, inbox notices, and filterable watcher facts to collab.

**Architecture** — A project-scoped domain operation writes the subscription. Item mutations snapshot watchers into event facts and record notice intent for the existing org drain.

**Tech Stack** — TypeScript, Kysely, PostgreSQL, Vitest, Capybara plugin SDK.

**Spec** — [Collab item watchers](../specs/2026-11-29-collab-item-watchers-design.md).

## Global constraints

The project write policy applies to self-subscription. Every persisted row is org-scoped.
The per-item cap is 64. The existing directed decision event retains its current audience.
Notice copy uses both UI languages and contains an item link.

## Review focus

- Concurrent subscriptions at capacity and idempotent repeats at capacity.
- Membership removal and delivery after a recipient has unsubscribed.
- A decision answer after the asking agent has been removed.
- A worker retry after delivery succeeds but marking the notice fails.
- UI actions and tools acting only for the current person.

### Task 1 · Subscription storage and domain operation

- [ ] Extend `plugins/collab/test/migration.test.ts` and add a watcher domain test using
  `test/domain/setup.ts`. Assert repeated subscribe/unsubscribe, 64 subscriptions with a
  rejected 65th, scoped lookups, and the existing guest and archive errors. Run those tests
  before adding the migration and implementation.
- [ ] Add `plugins/collab/migrations/0002_item_watchers.sql` and update the typed schema in
  `src/store`. Constrain the subscription to one item and project membership, with cascading
  cleanup when either is removed. Update the migration test helper to run both migrations.
- [ ] Add `src/domain/watchers.ts` with `setItemWatching(db, orgId, actor, itemId, watching)`
  and `watcherIds(db, orgId, itemId)`. Lock the item before checking capacity and writing the
  subscription. Return the current boolean from the write and sorted account IDs from the read.
- [ ] Run the migration and domain tests and check the concurrent capacity case.

### Task 2 · Item page and agent tool

- [ ] Extend `test/page/page.test.ts`, `test/client/pages.test.ts`, and
  `test/tools/tools.test.ts` with a follow/unfollow round trip and an actor-scope assertion.
  Run the affected tests before wiring the entry points.
- [ ] Add `watching` to the item detail, add the `item.watch` page action, and render a localized
  button in `src/client/item-detail.tsx`. Reuse the existing action invalidation and write controls.
- [ ] Register `watch_item` with inputs `key` and `watching`. Resolve the key through the existing
  project access path and apply the write for the conversation owner. Update extension tool
  permissions and the manifest tests.
- [ ] Run the page, client, tools, and manifest tests.

### Task 3 · Event facts and notification delivery

- [ ] Extend `test/events/source.test.ts` and `test/events/emitter.test.ts` to assert a filterable
  `watchers` fact and its snapshot semantics. Extend `test/notices/notify.test.ts` to assert
  status/comment/answer notices, access revocation before delivery, and retry deduplication.
  Cover an answered decision with no viable asking agent.
- [ ] Update `src/events/declarations.ts` and `src/events/outbox.ts` to expose the account
  list as a filterable `string[]` fact, including an empty array for items with no watchers.
- [ ] Record notice intent from status, comment, and answered-decision activity in the write
  transaction. Use the existing notice drain in `src/notices.ts` and its stable inbox dedupe
  keys. Recheck current membership and subscriptions before posting. Read the decision activity
  directly so a directed event's audience or absence does not govern watcher delivery.
- [ ] Run the event, notice, decision, and dual-replica tests.

### Task 4 · Release and verification

- [ ] Add a patch changeset and update the plugin README with the feature and its permissions.
- [ ] Run `pnpm -s verify --fast --json` and `pnpm exec vitest run plugins/collab`. Inspect the
  diff for org scoping, transaction boundaries, pack contents, and bilingual UI copy.
