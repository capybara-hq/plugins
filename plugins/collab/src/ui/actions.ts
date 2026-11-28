import type { ExtensionContext, UiActionResult, UiOrgActionArgs } from "@capybara-hq/plugin-sdk";
import { PROJECTS } from "../constants.js";
import { type CollabDb, collabDb } from "../store/db.js";

/** What an action handler needs: the kernel's ctx and the plugin's typed database. */
export interface ActionDeps {
  ctx: ExtensionContext;
  db: CollabDb;
}

/**
 * One UI action of the `projects` component (page buttons and inbox item buttons). It runs as
 * the clicking person (`args.accountId`) and must be idempotent: inbox actions are delivered at
 * least once.
 */
export type ActionHandler = (deps: ActionDeps, args: UiOrgActionArgs) => Promise<UiActionResult>;

// capybara:allow-module-state static dispatch table: filled by registerAction at module load, read only afterwards
const ACTIONS = new Map<string, ActionHandler>();

/**
 * Adds an action to the dispatch table. Call it at the top level of the module that owns the
 * action (never at runtime), so every replica has the same table once the modules are loaded.
 */
export function registerAction(actionId: string, handler: ActionHandler): void {
  if (ACTIONS.has(actionId)) throw new Error(`collab: UI action ${actionId} registered twice`);
  ACTIONS.set(actionId, handler);
}

/** Runs the action named by `args.actionId`; an unknown one is refused. */
export async function dispatchAction(
  deps: ActionDeps,
  args: UiOrgActionArgs,
): Promise<UiActionResult> {
  const handler = ACTIONS.get(args.actionId);
  if (!handler) throw new Error(`collab: unknown UI action ${args.actionId}`);
  return handler(deps, args);
}

/**
 * Registers the one `ctx.ui.action` handler of the `projects` component (in `setup`); it
 * dispatches on `actionId`. The modules that register actions must be imported before it runs.
 */
export function registerUiActions(ctx: ExtensionContext): void {
  const deps: ActionDeps = { ctx, db: collabDb(ctx.db) };
  ctx.ui.action(PROJECTS, async (args) => {
    if (args.scope === "platform") throw new Error("collab: actions are org-scoped");
    return dispatchAction(deps, args);
  });
}
