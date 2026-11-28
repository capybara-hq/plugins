import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { collabDb } from "../store/db.js";
import { registerDecisionTools } from "./decisions.js";
import { registerItemTools } from "./items.js";
import { registerProjectTools } from "./projects.js";

/**
 * Registers the agent tools (`plugin__collab__<name>`): projects, items and decisions. Each acts
 * as the conversation's owner (`call.ownerAccountId`) and records the agent as the actor of its
 * writes.
 */
export function registerTools(ctx: ExtensionContext): void {
  const deps = { ctx, db: collabDb(ctx.db) };
  registerProjectTools(deps);
  registerItemTools(deps);
  registerDecisionTools(deps);
}
