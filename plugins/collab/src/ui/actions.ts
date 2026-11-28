import type { ExtensionContext, UiActionResult, UiOrgActionArgs } from "@capybara-hq/plugin-sdk";
import { ITEM_PANEL, ITEM_PROPERTIES, PROJECTS } from "../constants.js";
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
  try {
    return await handler(deps, args);
  } catch (err) {
    if (err instanceof ActionPayloadError) {
      return {
        toast: { zh: "这个操作的参数无效", en: `This action's input is invalid: ${err.message}` },
      };
    }
    throw err;
  }
}

/** A malformed action payload: the dispatcher answers it with a toast, not a failed call. */
export class ActionPayloadError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Kernel ids (accounts, agents, conversations) are opaque strings of bounded length. */
const KERNEL_ID_MAX = 256;

/**
 * Reads the named string fields of an action payload: `"uuid"` for the plugin's own row ids,
 * `"id"` for a kernel id (non-empty, at most 256 characters). Throws {@link ActionPayloadError}
 * when the payload is not an object or a field is missing or malformed.
 */
export function payloadFields<K extends string>(
  payload: unknown,
  spec: Record<K, "uuid" | "id">,
): Record<K, string> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new ActionPayloadError("the payload must be an object");
  }
  const out = {} as Record<K, string>;
  for (const key of Object.keys(spec) as K[]) {
    const value = (payload as Record<string, unknown>)[key];
    const ok =
      typeof value === "string" &&
      (spec[key] === "uuid"
        ? UUID_RE.test(value)
        : value.length > 0 && value.length <= KERNEL_ID_MAX);
    if (!ok) throw new ActionPayloadError(`${key} is missing or malformed`);
    out[key] = value as string;
  }
  return out;
}

/**
 * Registers the `ctx.ui.action` handler of each component that acts (in `setup`): the projects
 * page and the conversation panels share one dispatch table on `actionId`. The modules that
 * register actions must be imported before it runs.
 */
export function registerUiActions(ctx: ExtensionContext): void {
  const deps: ActionDeps = { ctx, db: collabDb(ctx.db) };
  for (const component of [PROJECTS, ITEM_PANEL, ITEM_PROPERTIES]) {
    ctx.ui.action(component, async (args) => {
      if (args.scope === "platform") throw new Error("collab: actions are org-scoped");
      return dispatchAction(deps, args);
    });
  }
}
