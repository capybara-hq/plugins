import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import {
  startPostgresContainer,
  startTestPostgres,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EMBED_QUEUE,
  EMBED_RETRY_DELAY_MS,
  embedJobId,
  embedMemory,
  type MemoryDeps,
  runEmbedJob,
} from "../src/embed.js";
import { search } from "../src/search.js";
import { get, type Owner, put } from "../src/store.js";
import { fakeModels, fakeQueue, type QueuedJob } from "./fakes.js";
import { migrate, pluginDb } from "./helpers.js";

/**
 * Hybrid search on both schemas a deployment can have: `embedding vector` (pgvector) and
 * `embedding real[]` (no pgvector). The model is a stub whose vectors encode a few topics, so a
 * query that shares no word with a memory can still be close to it in vector space.
 */

const A: Owner = { orgId: "org-1", agentId: "agent-1", accountId: "acc-a" };
const B: Owner = { ...A, accountId: "acc-b" };

type Db = ExtensionContext["db"];

const schemas: { name: string; start: () => Promise<TestContainer> }[] = [
  { name: "vector", start: startTestPostgres },
  { name: "real[]", start: () => startPostgresContainer({ image: "postgres:17" }) },
];

describe.each(schemas)("search on an $name schema", { timeout: 180_000 }, ({ start }) => {
  let pgc: TestContainer;
  let db: Db;
  let destroy: () => Promise<void>;
  let jobs: QueuedJob[];

  beforeAll(async () => {
    pgc = await start();
    await migrate(pgc.url);
    ({ db, destroy } = pluginDb(pgc.url));
  }, 180_000);

  afterAll(async () => {
    await destroy?.();
    await pgc?.stop();
  });

  beforeEach(async () => {
    await db.deleteFrom("memories").execute();
    jobs = [];
  });

  const deps = (models: MemoryDeps["models"] = fakeModels({ mapped: false })): MemoryDeps => ({
    db,
    models,
    queue: fakeQueue(jobs),
  });

  const write = async (
    owner: Owner,
    path: string,
    body: string,
    description = "a memory",
    d?: MemoryDeps,
  ) => {
    const { row } = await put(db, owner, { path, description, body, conversationId: "conv-1" });
    if (d !== undefined) await embedMemory(d, owner, row);
    return row;
  };

  it("finds Chinese text with no spaces by a word inside it, with no model mapped", async () => {
    await write(A, "feedback/reply-in-chinese.md", "回复一律用中文", "Language for replies");
    await write(A, "user/role.md", "Backend engineer on the payments team", "Role");
    const hits = await search(deps(), db, A, "中文", 5);
    expect(hits.map((h) => h.row.path)).toEqual(["feedback/reply-in-chinese.md"]);
    expect(hits[0]?.snippet).toContain("中文");
  });

  it("finds a memory by words of its path and description", async () => {
    await write(A, "feedback/reply-in-chinese.md", "回复一律用中文", "Language for replies");
    expect((await search(deps(), db, A, "Chinese", 5)).map((h) => h.row.path)).toEqual([
      "feedback/reply-in-chinese.md",
    ]);
    expect((await search(deps(), db, A, "replies language", 5)).map((h) => h.row.path)).toEqual([
      "feedback/reply-in-chinese.md",
    ]);
  });

  it("ranks a memory first by vector when the query shares no word with it", async () => {
    const d = deps(fakeModels());
    await write(A, "user/morning.md", "Drinks a coffee every morning before standup", "Habit", d);
    await write(A, "user/pet.md", "Has a puppy named Max", "Pet", d);
    await write(A, "project/launch.md", "Launch deadline is 2026-12-01", "Launch", d);
    const hits = await search(d, db, A, "espresso", 5);
    expect(hits[0]?.row.path).toBe("user/morning.md");
    // keyword alone finds nothing for this query
    expect(await search(deps(), db, A, "espresso", 5)).toEqual([]);
  });

  it("fuses keyword and vector ranks", async () => {
    const d = deps(fakeModels());
    await write(A, "user/morning.md", "Drinks a coffee every morning", "Habit", d);
    await write(A, "user/pet.md", "Has a puppy; walks it every morning", "Pet", d);
    // "morning" matches both by keyword; "latte" puts the coffee memory first by vector
    const hits = await search(d, db, A, "latte morning", 5);
    expect(hits.map((h) => h.row.path)).toEqual(["user/morning.md", "user/pet.md"]);
  });

  it("never returns another owner's memory, by keyword or by vector", async () => {
    const d = deps(fakeModels());
    await write(B, "user/morning.md", "Drinks a coffee every morning 中文", "Habit", d);
    await write(A, "user/pet.md", "Has a puppy", "Pet", d);
    expect(await search(d, db, A, "coffee", 5)).toEqual([]);
    expect(await search(d, db, A, "中文", 5)).toEqual([]);
    expect((await search(d, db, A, "espresso", 5)).map((h) => h.row.path)).not.toContain(
      "user/morning.md",
    );
    const other = { ...A, agentId: "agent-2" };
    expect(await search(d, db, other, "puppy", 5)).toEqual([]);
  });

  it("treats % and _ in the query as plain text", async () => {
    await write(A, "user/a.md", "alpha beta", "First");
    await write(A, "user/b_c.md", "gamma", "Second");
    expect(await search(deps(), db, A, "%", 5)).toEqual([]);
    expect(await search(deps(), db, A, "_", 5)).toEqual([]);
    expect(await search(deps(), db, A, "%alpha%", 5)).toHaveLength(1);
  });

  it("caps the hits at the limit and counts each hit as a recall", async () => {
    for (let i = 0; i < 25; i++) await write(A, `project/p${i}.md`, `shared word ${i}`, "P");
    const hits = await search(deps(), db, A, "shared", 50);
    expect(hits).toHaveLength(20);
    expect((await search(deps(), db, A, "shared", 3)).length).toBe(3);
    const row = await get(db, A, hits[0]?.row.path ?? "");
    expect(row?.recallCount).toBeGreaterThanOrEqual(1);
    expect(row?.lastRecalledAt).not.toBeNull();
  });

  it("cuts the snippet to 200 characters around the match", async () => {
    const body = `${"x ".repeat(300)}needle ${"y ".repeat(300)}`;
    await write(A, "reference/long.md", body, "Long");
    const [hit] = await search(deps(), db, A, "needle", 5);
    expect(hit?.snippet.length).toBeLessThanOrEqual(200);
    expect(hit?.snippet).toContain("needle");
  });

  it("only compares vectors of the current model and re-embeds stale rows through the queue", async () => {
    const old = deps(fakeModels({ model: "emb-1" }));
    const row = await write(A, "user/morning.md", "Drinks a coffee every morning", "Habit", old);
    expect((await get(db, A, row.path))?.embeddingModel).toBe("fake/emb-1");

    const next = deps(fakeModels({ model: "emb-2", dims: 7 }));
    // the stored vector belongs to another model (and dimension): no vector hit, no error
    expect(await search(next, db, A, "espresso", 5)).toEqual([]);
    expect(jobs).toEqual([
      {
        name: EMBED_QUEUE,
        data: { ...A, memoryId: row.id },
        opts: { jobId: embedJobId(row) },
      },
    ]);
    expect(embedJobId(row)).toMatch(new RegExp(`^memory-embed-${row.id}-[0-9a-f]{12}$`));
    // the job re-embeds with the current model; then the vector path finds it
    await runEmbedJob(next, { ...A, memoryId: row.id });
    expect((await get(db, A, row.path))?.embeddingModel).toBe("fake/emb-2");
    expect((await search(next, db, A, "espresso", 5)).map((h) => h.row.path)).toEqual([
      "user/morning.md",
    ]);
  });

  it("embedMemory stores the vector; no model mapped is silent; a failure enqueues a retry", async () => {
    const row = await write(A, "user/morning.md", "Drinks a coffee", "Habit");
    await embedMemory(deps(fakeModels({ mapped: false })), A, row);
    expect((await get(db, A, row.path))?.hasEmbedding).toBe(false);
    expect(jobs).toEqual([]);

    await embedMemory(deps(fakeModels({ fail: true })), A, row);
    expect(jobs).toEqual([
      {
        name: EMBED_QUEUE,
        data: { ...A, memoryId: row.id },
        opts: { jobId: embedJobId(row), delayMs: EMBED_RETRY_DELAY_MS },
      },
    ]);

    await embedMemory(deps(fakeModels()), A, row);
    const stored = await get(db, A, row.path);
    expect(stored?.hasEmbedding).toBe(true);
    expect(stored?.embeddingModel).toBe("fake/emb-1");
    const { dims } = await db
      .selectFrom("memories")
      .select(
        sql<number>`cardinality(string_to_array(trim(both '[]{}' from embedding::text), ','))`.as(
          "dims",
        ),
      )
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    expect(Number(dims)).toBe(5);
  });

  it("does not store a vector for text that changed while it was computed", async () => {
    const row = await write(A, "user/morning.md", "Drinks a coffee", "Habit");
    await put(db, A, {
      path: row.path,
      description: "Habit",
      body: "Has a puppy",
      conversationId: null,
    });
    await embedMemory(deps(fakeModels()), A, row);
    expect((await get(db, A, row.path))?.hasEmbedding).toBe(false);
  });

  it("re-enqueues a memory edited after its embedding job completed (the job id follows the text)", async () => {
    const d = deps(fakeModels());
    const row = await write(A, "user/morning.md", "Drinks a coffee every morning", "Habit");
    await search(d, db, A, "espresso", 5);
    expect(jobs.map((j) => j.data)).toEqual([{ ...A, memoryId: row.id }]);
    await runEmbedJob(d, { ...A, memoryId: row.id });
    expect((await get(db, A, row.path))?.hasEmbedding).toBe(true);

    // the edit drops the vector; the completed job is still retained by the queue
    const { row: edited } = await put(db, A, {
      path: row.path,
      description: "Habit",
      body: "Drinks a latte every morning",
      conversationId: null,
    });
    await search(d, db, A, "espresso", 5);
    expect(jobs.map((j) => (j.opts as { jobId: string }).jobId)).toEqual([
      embedJobId(row),
      embedJobId(edited),
    ]);
    expect(embedJobId(edited)).not.toBe(embedJobId(row));
    // the same text again is the same job (deduped while pending)
    await search(d, db, A, "espresso", 5);
    expect(jobs).toHaveLength(2);
  });

  it("still answers when enqueueing stale memories fails", async () => {
    await write(A, "user/morning.md", "Drinks a coffee every morning", "Habit");
    const broken: MemoryDeps = {
      db,
      models: fakeModels(),
      queue: {
        define() {},
        async add() {
          throw new Error("Redis is down");
        },
      },
    };
    const hits = await search(broken, db, A, "coffee", 5);
    expect(hits.map((h) => h.row.path)).toEqual(["user/morning.md"]);
  });

  it("links near-identical memories as neighbours both ways, not dissimilar ones", async () => {
    const d = deps(fakeModels());
    const a = await write(A, "user/coffee.md", "Drinks coffee", "Coffee", d);
    const b = await write(A, "user/latte.md", "Likes a latte", "Latte", d);
    const c = await write(A, "user/pet.md", "Has a puppy", "Pet", d);
    // another owner's near-identical memory is never a neighbour
    await write(B, "user/espresso.md", "Espresso", "Espresso", d);
    const rows = await db
      .selectFrom("memory_neighbors")
      .select(["memory_id", "neighbor_id", "score"])
      .execute();
    const pairs = rows.map((r) => `${r.memory_id}>${r.neighbor_id}`).sort();
    expect(pairs).toEqual([`${a.id}>${b.id}`, `${b.id}>${a.id}`].sort());
    expect(pairs.some((p) => p.includes(c.id))).toBe(false);
    expect(rows.every((r) => r.score >= 0.75)).toBe(true);
  });
});
