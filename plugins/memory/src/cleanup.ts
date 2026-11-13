import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { purge } from "./store.js";

/**
 * Lifecycle cleanup (spec §5.6): the kernel delivers `org.member_removed`, `agent.deleted` and
 * `org.deleted` durably, at least once, whether or not the org has the plugin enabled. Each handler
 * is one plain `DELETE … WHERE` (idempotent: a redelivery deletes nothing more), well within the hook
 * time limit since one owner pair holds at most 1,000 rows.
 */
export function registerCleanup(ctx: Pick<ExtensionContext, "db" | "hooks">): void {
  ctx.hooks.on(
    "org.member_removed",
    async ({ orgId, accountId }) => {
      await purge(ctx.db, { orgId, accountId });
    },
    { mode: "observe" },
  );
  ctx.hooks.on(
    "agent.deleted",
    async ({ orgId, agentId }) => {
      await purge(ctx.db, { orgId, agentId });
    },
    { mode: "observe" },
  );
  ctx.hooks.on(
    "org.deleted",
    async ({ orgId }) => {
      await purge(ctx.db, { orgId });
    },
    { mode: "observe" },
  );
}
