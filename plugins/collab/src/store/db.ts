import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import type { Kysely } from "kysely";
import type { CollabDatabase } from "./types.js";

/** A Kysely handle typed with the plugin's tables. */
export type CollabDb = Kysely<CollabDatabase>;

/** `ctx.db` seen through the plugin's table types (the kernel gives an untyped handle). */
export function collabDb(db: ExtensionContext["db"]): CollabDb {
  return db as unknown as CollabDb;
}
