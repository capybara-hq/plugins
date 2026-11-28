import { fileURLToPath } from "node:url";
import {
  createDb,
  createDualReplicaHarness,
  createLocalAccount,
  type Harness,
  kernelDb,
  replicaOf,
  startTestPostgres,
  startTestRedis,
  TEST_PASSWORD,
  type TestContainer,
  waitFor,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The collab event outbox across two kernel replicas (two processes sharing PG / Redis): a write
 * on replica 0 emits its rows on the request path, once each (one kernel trigger event per dedupe
 * key). Then replica 0 crashes with its rows owed again (as if it died after the commit, before
 * marking them emitted): the org's drain job it queued before the write (intent first, a
 * deterministic per-org-and-minute id in the shared queue) runs on replica 1, emits the rows
 * again and marks them, and the kernel's dedupe keeps one trigger event per row.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const COLLAB = fileURLToPath(new URL("../src/index.ts", import.meta.url));
/** The scripted model provider (a devDependency), as in the other kernel tests. */
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";

let pgc: TestContainer;
let rdc: TestContainer;
let h: Harness | undefined;
let raw: ReturnType<typeof createDb> | undefined;

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
}, 120_000);
afterAll(async () => {
  await raw?.destroy();
  await h?.stop();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

type Json = Record<string, unknown>;

describe("collab outbox (dual replica)", () => {
  it("emits each row once; a crashed replica's owed rows are drained by the other replica", async () => {
    h = await createDualReplicaHarness({
      resolveFrom: PLUGIN_DIR,
      extensions: [MODEL_FAKE, COLLAB],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      config: { auth: { cookieSecure: false } },
    });
    const harness = h;
    raw = createDb(harness.dbUrl, 3);
    const db = kernelDb(raw);
    const outbox = raw.withSchema("plugin_collab");

    let cookie = "";
    const at = async (i: 0 | 1, method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${harness.replicas[i].port}${path}`, {
        method,
        headers: {
          "x-capybara-csrf": "1",
          ...(cookie !== "" && { cookie }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      expect(replicaOf(res)).toBe(i);
      const text = await res.text();
      return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json };
    };

    const ownerId = await createLocalAccount(db, "owner");
    const signedIn = await harness.requestTo(0, "/api/v1/auth/login", {
      method: "POST",
      headers: { "x-capybara-csrf": "1", "content-type": "application/json" },
      body: JSON.stringify({ login: "owner", password: TEST_PASSWORD }),
    });
    expect(signedIn.status).toBe(200);
    await signedIn.body?.cancel();
    cookie = signedIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const org = await at(0, "POST", "/api/v1/orgs", { name: "Acme" });
    const orgId = (org.json.org as { id: string }).id;
    const base = `/api/v1/orgs/${orgId}`;
    const en = await at(1, "PUT", `${base}/extensions/collab`, { enabled: true });
    expect(en.status, JSON.stringify(en.json)).toBe(200);
    const action = async (i: 0 | 1, actionId: string, payload: Json) => {
      const res = await at(i, "POST", `${base}/ui/actions/collab/projects`, {
        actionId,
        payload,
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.toast, JSON.stringify(res.json)).toBeUndefined();
    };

    await action(1, "project.create", { key: "OPS", name: "Operations" });
    const listed = await at(1, "POST", `${base}/ui/query/collab/projects`, {
      query: "projects.list",
    });
    const projectId = (listed.json.data as { projects: { id: string }[] }).projects[0]?.id;
    if (!projectId) throw new Error("project missing");

    // a write on replica 0 emits its rows on the request path: item.created + item.updated
    // (a person-only assignment, no agent)
    await action(0, "item.create", {
      projectId,
      type: "task",
      title: "Rotate keys",
      responsibleAccountId: ownerId,
    });
    const rows = await outbox
      .selectFrom("event_outbox")
      .select(["id", "dedupe_key", "emitted_at"])
      .where("org_id", "=", orgId)
      .execute();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.emitted_at !== null)).toBe(true);
    const keys = rows.map((r) => r.dedupe_key as string).sort();
    const eventsByKey = async () =>
      (
        await db
          .selectFrom("trigger_events")
          .select(["dedupe_key", sql<number>`count(*)::int`.as("n")])
          .where("org_id", "=", orgId)
          .where("plugin", "=", "collab")
          .groupBy("dedupe_key")
          .execute()
      ).map((r) => [r.dedupe_key, r.n]);
    expect(await eventsByKey()).toEqual(expect.arrayContaining(keys.map((k) => [k, 1])));

    // replica 0 crashes with its rows owed (as if it died after the commit, before the emit)
    await outbox
      .updateTable("event_outbox")
      .set({ emitted_at: null })
      .where("org_id", "=", orgId)
      .execute();
    await harness.kill(0);

    // the drain job replica 0 queued before its write runs on replica 1 (at most two minutes:
    // the job of a minute runs after the next one ends) and emits every owed row
    await waitFor(
      async () => {
        const left = await outbox
          .selectFrom("event_outbox")
          .select("id")
          .where("org_id", "=", orgId)
          .where("emitted_at", "is", null)
          .execute();
        return left.length === 0;
      },
      150_000,
      "the owed rows drained by replica 1",
      1_000,
    );
    // the kernel deduped the second emit: still one trigger event per row
    const after = await eventsByKey();
    expect(after).toEqual(expect.arrayContaining(keys.map((k) => [k, 1])));
    expect(after.every(([, n]) => n === 1)).toBe(true);
    const failed = await outbox
      .selectFrom("event_outbox")
      .select("id")
      .where("org_id", "=", orgId)
      .where("failed_at", "is not", null)
      .execute();
    expect(failed).toEqual([]);
  }, 240_000);
});
