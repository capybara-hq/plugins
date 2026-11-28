import { readFileSync } from "node:fs";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { migrate, pluginDb, SCHEMA } from "./helpers.js";

const TABLES = [
  "projects",
  "project_members",
  "workflows",
  "statuses",
  "item_types",
  "items",
  "item_watchers",
  "item_links",
  "comments",
  "activity",
  "artifacts",
  "decisions",
  "event_outbox",
];

const containers: TestContainer[] = [];
afterAll(async () => {
  await Promise.all(containers.splice(0).map((c) => c.stop()));
});

describe("collab migration", { timeout: 180_000 }, () => {
  it("creates the tables with org_id, enforces (project_id, number), and is idempotent", async () => {
    const pgc = await startTestPostgres();
    containers.push(pgc);
    await migrate(pgc.url);
    const { db: scoped, destroy } = pluginDb(pgc.url);
    try {
      await scoped.connection().execute(async (db) => {
        // Raw SQL ignores withSchema: resolve table names the way the kernel runs migrations.
        await sql`SET search_path TO plugin_collab, public`.execute(db);
        const { rows } = await sql<{ table_name: string; column_name: string }>`
          SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = ${SCHEMA}`.execute(db);
        for (const t of TABLES) {
          const cols = rows.filter((r) => r.table_name === t).map((r) => r.column_name);
          expect(cols, t).toContain("org_id");
        }

        const project = await sql<{ id: string }>`
          INSERT INTO projects (org_id, key, name, owner_account_id) VALUES ('o1', 'P', 'P', 'a1')
          RETURNING id`.execute(db);
        const projectId = project.rows[0]?.id;
        const insertItem = () =>
          sql`INSERT INTO items (org_id, project_id, number, type, title, status_key)
              VALUES ('o1', ${projectId}, 1, 'task', 't', 'todo')`.execute(db);
        await insertItem();
        await expect(insertItem()).rejects.toThrow(/duplicate key/);
        await expect(
          sql`INSERT INTO projects (org_id, key, name, owner_account_id)
              VALUES ('o1', 'P', 'Q', 'a1')`.execute(db),
        ).rejects.toThrow(/duplicate key/);

        const outbox = (org: string) =>
          sql`INSERT INTO event_outbox (org_id, type, subject, summary, dedupe_key)
              VALUES (${org}, 'item.created', '{}'::jsonb, 's', 'k1')`.execute(db);
        await outbox("o1");
        await outbox("o2");
        await expect(outbox("o1")).rejects.toThrow(/duplicate key/);

        // The kernel applies a migration once; running the same SQL again is a no-op.
        const text = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
        await sql.raw(text).execute(db);
        const count = await sql<{ n: string }>`SELECT count(*) AS n FROM items`.execute(db);
        expect(count.rows[0]?.n).toBe("1");
      });
    } finally {
      await destroy();
    }
  });
});
