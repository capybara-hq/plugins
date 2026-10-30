import { fileURLToPath } from "node:url";
import {
  createDb,
  createDualReplicaHarness,
  createLocalAccount,
  type Harness,
  type KernelSchemaDb,
  kernelDb,
  openSse,
  replicaOf,
  type SseClient,
  startTestPostgres,
  startTestRedis,
  TEST_PASSWORD,
  type TestContainer,
  waitFor,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * example-board's live updates across replicas (two kernel processes sharing PG / Redis / master
 * key): a token issued on replica 0 is accepted by the plugin on replica 1; `/ui/events` on replica 1
 * (one `ctx.bus` subscription per request) gets the `cards` frame of a change made on replica 0; the
 * conversation board's stream and the org page's stream each see only their own cards; when the
 * client disconnects the plugin unsubscribes (no subscription to the org's cards channel is left in
 * Redis). The kernel side (tokens across replicas, `ctx.bus` SSE, unsubscribe) is tested in core on
 * the fake `fake-embed`.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const BOARD = fileURLToPath(new URL("../src/index.ts", import.meta.url));
/** The scripted model provider (a devDependency): the conversation needs an agent. */
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";

let pgc: TestContainer;
let rdc: TestContainer;
let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
}, 120_000);
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});
afterAll(async () => {
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

type Json = Record<string, unknown>;

describe("example-board live updates (dual replica)", () => {
  it("a token from replica 0 works on replica 1; a change on replica 0 reaches replica 1's /ui/events; streams are split by scope", async () => {
    h = await createDualReplicaHarness({
      resolveFrom: PLUGIN_DIR,
      extensions: [MODEL_FAKE, BOARD],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      config: { auth: { cookieSecure: false } },
    });
    const harness = h;
    const raw = createDb(harness.dbUrl, 3);
    cleanups.push(() => raw.destroy());
    const db: KernelSchemaDb = kernelDb(raw);

    let cookie = "";
    const at = async (
      i: 0 | 1,
      method: string,
      path: string,
      body?: unknown,
      auth?: { bearer: string },
    ) => {
      const res = await fetch(`http://127.0.0.1:${harness.replicas[i].port}${path}`, {
        method,
        headers: {
          ...(auth === undefined
            ? { "x-capybara-csrf": "1", ...(cookie !== "" && { cookie }) }
            : { authorization: `Bearer ${auth.bearer}` }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      expect(replicaOf(res)).toBe(i);
      const text = await res.text();
      return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json };
    };

    await createLocalAccount(db, "owner");
    const login = await harness.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "x-capybara-csrf": "1", "content-type": "application/json" },
      body: JSON.stringify({ login: "owner", password: TEST_PASSWORD }),
    });
    expect(login.status).toBe(200);
    await login.body?.cancel();
    cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const org = await at(0, "POST", "/api/v1/orgs", { name: "Acme" });
    const orgId = (org.json.org as { id: string }).id;
    const base = `/api/v1/orgs/${orgId}`;
    const en = await at(1, "PUT", `${base}/extensions/example-board`, { enabled: true });
    expect(en.status, JSON.stringify(en.json)).toBe(200);

    // Replica 0 issues
    const issued = await at(0, "POST", `${base}/ui/embeds/example-board/board/token`, {});
    expect(issued.status, JSON.stringify(issued.json)).toBe(200);
    const token = issued.json.token as string;

    // Replica 1 verifies it (plugin route)
    const created = await at(
      1,
      "POST",
      "/plugins/example-board/ui/cards",
      { title: "Ship" },
      {
        bearer: token,
      },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const cardId = (created.json.card as { id: string }).id;

    // Replica 1 opens the event stream
    const sse = async (i: 0 | 1, bearer: string): Promise<SseClient> => {
      const s = await openSse(
        `http://127.0.0.1:${harness.replicas[i].port}/plugins/example-board/ui/events`,
        { authorization: `Bearer ${bearer}` },
      );
      cleanups.push(() => s.close());
      return s;
    };
    const denied = await sse(1, "nope");
    expect(denied.status).toBe(401);
    const stream = await sse(1, token);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toMatch(/^text\/event-stream/);
    await stream.until((m) => m.some((x) => x.event === "ready"), 10_000, "ready frame");

    // A conversation card's change is not pushed to the org page's stream (the page has no conversation cards)
    const ag = await at(0, "POST", `${base}/agents`, {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [],
      },
      visibility: "org",
    });
    expect(ag.status, JSON.stringify(ag.json)).toBe(201);
    const conv = await at(1, "POST", `${base}/conversations`, {
      agentId: (ag.json.agent as { id: string }).id,
    });
    const convId = (conv.json.conversation as { id: string }).id;
    const convIssued = await at(1, "POST", `${base}/ui/embeds/example-board/board-conv/token`, {
      conversationId: convId,
    });
    expect(convIssued.status, JSON.stringify(convIssued.json)).toBe(200);
    const convToken = convIssued.json.token as string;
    const convCard = await at(
      0,
      "POST",
      "/plugins/example-board/ui/cards",
      { title: "Conv" },
      {
        bearer: convToken,
      },
    );
    expect(convCard.status).toBe(201);
    const convCardId = (convCard.json.card as { id: string }).id;
    const convStream = await sse(0, convToken);
    await convStream.until((m) => m.some((x) => x.event === "ready"), 10_000, "conv ready");
    const convMoved = await at(
      1,
      "POST",
      `/plugins/example-board/ui/cards/${convCardId}`,
      {
        status: "doing",
      },
      { bearer: convToken },
    );
    expect(convMoved.status).toBe(200);
    await convStream.until(
      (m) => m.some((x) => x.event === "cards" && (x.data ?? "").includes(convCardId)),
      10_000,
      "conv cards frame",
    );

    // Replica 0 changes a status -> replica 1's stream gets the cards frame
    const moved = await at(
      0,
      "POST",
      `/plugins/example-board/ui/cards/${cardId}`,
      { status: "done" },
      {
        bearer: token,
      },
    );
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    await stream.until(
      (m) => m.some((x) => x.event === "cards" && (x.data ?? "").includes(cardId)),
      10_000,
      "cards frame",
    );
    const frames = stream.messages.filter((x) => x.event === "cards");
    expect(frames.map((f) => JSON.parse(f.data ?? "{}"))).toEqual([{ cardId, status: "done" }]);
    // Nor does the conversation's stream see the org card's change
    expect(
      convStream.messages.filter((x) => x.event === "cards").map((f) => JSON.parse(f.data ?? "{}")),
    ).toEqual([{ cardId: convCardId, status: "doing" }]);
    convStream.close();

    // The client disconnects -> the plugin unsubscribes (per-request subscription, no shared state)
    const redis = new Redis(rdc.url);
    cleanups.push(() => redis.quit());
    const subscribed = async () =>
      ((await redis.pubsub("CHANNELS", `*cards.${orgId}*`)) as string[]).length;
    expect(await subscribed()).toBeGreaterThan(0);
    stream.close();
    await waitFor(async () => ((await subscribed()) === 0 ? true : undefined), 10_000);
  }, 120_000);
});
