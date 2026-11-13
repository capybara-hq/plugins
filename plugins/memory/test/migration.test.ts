import {
  startPostgresContainer,
  startTestPostgres,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { migrate, pluginDb, SCHEMA } from "./helpers.js";

/**
 * The migration through a real kernel on both kinds of server: the default test image (PostgreSQL
 * 17 with pgvector, which the kernel installs into `public`) gives `embedding vector`; a plain
 * `postgres:17` without pgvector gives `embedding real[]`, and the kernel and the plugin still start.
 */

const containers: TestContainer[] = [];
afterAll(async () => {
  await Promise.all(containers.splice(0).map((c) => c.stop()));
});

async function columns(pgUrl: string): Promise<Map<string, string>> {
  const { db, destroy } = pluginDb(pgUrl);
  try {
    const { rows } = await sql<{ table_name: string; column_name: string; type: string }>`
      SELECT c.table_name, c.column_name, format_type(a.atttypid, a.atttypmod) AS type
      FROM information_schema.columns c
      JOIN pg_attribute a
        ON a.attrelid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass
       AND a.attname = c.column_name
      WHERE c.table_schema = ${SCHEMA}`.execute(db);
    return new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r.type]));
  } finally {
    await destroy();
  }
}

const TABLES = ["memories", "memory_links", "memory_neighbors", "owners", "admin_access_log"];

describe("memory migration", { timeout: 180_000 }, () => {
  it("creates embedding as vector when pgvector is installed", async () => {
    const pgc = await startTestPostgres();
    containers.push(pgc);
    await migrate(pgc.url);
    const cols = await columns(pgc.url);
    expect(cols.get("memories.embedding")).toBe("vector");
    expect(cols.get("memories.tokens")).toBe("tsvector");
    for (const t of TABLES) {
      expect(
        [...cols.keys()].some((k) => k.startsWith(`${t}.`)),
        t,
      ).toBe(true);
    }
  });

  it("creates embedding as real[] on a server without pgvector", async () => {
    const pgc = await startPostgresContainer({ image: "postgres:17" });
    containers.push(pgc);
    await migrate(pgc.url);
    const cols = await columns(pgc.url);
    expect(cols.get("memories.embedding")).toBe("real[]");
    expect(cols.get("memories.tokens")).toBe("tsvector");
    for (const t of TABLES) {
      expect(
        [...cols.keys()].some((k) => k.startsWith(`${t}.`)),
        t,
      ).toBe(true);
    }
  });
});
