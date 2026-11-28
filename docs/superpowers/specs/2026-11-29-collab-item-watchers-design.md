# Collab item watchers

[Issue #320](https://github.com/capybara-hq/plugins/issues/320) adds the watcher relationship
defined in the collaboration design. Project owners and members can follow an item for themselves
from its detail page or through an agent acting for them. The page shows the viewer's current
state with a localized Follow or Unfollow action. Repeating the same action succeeds without
changing the result.

## Approach

Use a normalized item-to-account relationship with membership-scoped reads. This keeps membership
removal and concurrent subscriptions enforceable in PostgreSQL. An array on the item row would
also store subscriptions, but would need separate membership cleanup and would couple a personal
preference to the item's edit version. The page action and agent tool share the same domain
operation and existing project write policy, including the archived-project guard.

Each item supports up to 64 watchers because the kernel accepts at most 64 entries in a trigger
fact array. Enforce the limit under the item's transaction lock and return an actionable error
when the list is full. Existing watchers can repeat their subscription at capacity. Persist the
watcher account IDs in sorted order on the event outbox row when each item event is recorded.

## Notices

Status transitions, new comments, and answered decisions record the recipients owed a notice in
the same transaction as the change. The existing org drain delivers the notice with a stable
dedupe key per activity and recipient. Delivery checks that the recipient still watches the item
and still has project access. Suppress the acting person's own notice. Titles and bodies are
bilingual and link to the item. The decision notice states that a decision was answered and
keeps the answer in its existing visibility scope. Watchers get no directed agent event or
decision action from a notice.

## AGENTS.md rules touched

- Add an idempotent migration. Keep the applied initial migration immutable and scope every
  read and write by org.
- Persist changes and notice intent in PostgreSQL. Use the existing org-scoped queue and
  idempotent delivery across replicas.
- Register the tool in the extension manifest and honor the existing actor and project rules.
- Reuse the item's forwarded design components and localize UI copy in English and Chinese.
- Add a changeset for the collab plugin.
