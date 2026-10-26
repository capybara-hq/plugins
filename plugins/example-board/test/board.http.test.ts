import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";
import {
  createAgent,
  createConv,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
} from "../helpers/runs.js";

/**
 * example-board's own behaviour behind embed tokens (single replica, official plugin example-board):
 * card CRUD with a page token, isolation between orgs, and the split between conversation cards and
 * org-wide cards. The kernel side of embeds (token issue and verification) is in
 * `embed.http.test.ts` on the fake `fake-embed`. This file moves into the plugin with Task 3 of
 * phase A3a.
 */

const BOARD = fileURLToPath(
  new URL("../../../../plugins/example-board/src/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let k: Kernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  const base = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] });
  k = await createKernel(
    { ...base, extensions: [...base.extensions, BOARD] },
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
}, 120_000);
afterAll(async () => {
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function account(name: string): Promise<string> {
  return (
    await new AccountsService(db).createLocal({ login: name, password: PW, displayName: name })
  ).id;
}

const enable = async (req: Req, orgId: string, plugin: string) => {
  const r = await req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
    payload: { enabled: true },
  });
  expect(r.statusCode, r.body).toBe(200);
};

type Issued = { token: string; src: string; expiresAt: string; expiresIn: number };

describe("example-board behind embed tokens", () => {
  let owner: Req;
  let other: Req;
  let ownerId: string;
  let orgId: string;
  let convId: string;
  let ui: string;

  const issue = (req: Req, plugin: string, id: string, body: Record<string, unknown> = {}) =>
    req({ method: "POST", url: `${ui}/embeds/${plugin}/${id}/token`, payload: body });

  const asPlugin = (
    method: "GET" | "POST",
    path: string,
    token?: string,
    payload?: Record<string, unknown>,
  ) =>
    k.http.inject({
      method,
      url: `/plugins/example-board${path}`,
      headers: {
        ...(token !== undefined && { authorization: `Bearer ${token}` }),
        ...(payload !== undefined && { "content-type": "application/json" }),
      },
      ...(payload !== undefined && { payload: JSON.stringify(payload) }),
    });

  beforeEach(async () => {
    await truncateTables(
      raw,
      "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.deployment_settings, plugin_example_board.cards",
    );
    await redis.flushdb();
    ownerId = await account("owner");
    const otherId = await account("other");
    owner = await session(k, "owner");
    other = await session(k, "other");
    orgId = await createOrg(owner);
    await testMembers(db).add(orgId, otherId, "member", ownerId);
    const agentId = await createAgent(owner, orgId);
    convId = await createConv(owner, orgId, agentId);
    await createConv(other, orgId, agentId);
    ui = `/api/v1/orgs/${orgId}/ui`;
  });

  it("a page token reads and writes this org's cards; another org's token sees none of them", async () => {
    await enable(owner, orgId, "example-board");
    const { token } = (await issue(owner, "example-board", "board")).json() as Issued;
    const created = await asPlugin("POST", "/ui/cards", token, { title: "Write spec" });
    expect(created.statusCode, created.body).toBe(201);
    const card = (created.json() as { card: { id: string; status: string } }).card;
    expect(card.status).toBe("todo");
    const moved = await asPlugin("POST", `/ui/cards/${card.id}`, token, { status: "doing" });
    expect(moved.statusCode, moved.body).toBe(200);
    const list = await asPlugin("GET", "/ui/cards", token);
    expect(list.statusCode).toBe(200);
    expect((list.json() as { cards: unknown[] }).cards).toEqual([
      expect.objectContaining({ id: card.id, title: "Write spec", status: "doing" }),
    ]);
    expect(
      (await asPlugin("POST", `/ui/cards/${card.id}`, token, { status: "bad" })).statusCode,
    ).toBe(400);

    // 另一个组织的令牌看不到也改不了这张卡
    const org2 = await createOrg(owner, "Other");
    await enable(owner, org2, "example-board");
    const { token: t2 } = (
      await owner({
        method: "POST",
        url: `/api/v1/orgs/${org2}/ui/embeds/example-board/board/token`,
        payload: {},
      })
    ).json() as Issued;
    expect(((await asPlugin("GET", "/ui/cards", t2)).json() as { cards: unknown[] }).cards).toEqual(
      [],
    );
    expect(
      (await asPlugin("POST", `/ui/cards/${card.id}`, t2, { status: "done" })).statusCode,
    ).toBe(404);
  });

  it("对话嵌入的令牌只看得到、只改得了这个对话的卡片；组织页面看不到、改不了对话里的卡片", async () => {
    await enable(owner, orgId, "example-board");
    const { token: orgToken } = (await issue(owner, "example-board", "board")).json() as Issued;
    const { token: convToken } = (
      await issue(owner, "example-board", "board-conv", { conversationId: convId })
    ).json() as Issued;
    const a = await asPlugin("POST", "/ui/cards", convToken, { title: "In conversation" });
    expect(a.statusCode).toBe(201);
    const b = await asPlugin("POST", "/ui/cards", orgToken, { title: "Org wide" });
    const orgCard = (b.json() as { card: { id: string } }).card.id;
    const conv = (await asPlugin("GET", "/ui/cards", convToken)).json() as {
      cards: { title: string }[];
    };
    expect(conv.cards.map((c) => c.title)).toEqual(["In conversation"]);
    const all = (await asPlugin("GET", "/ui/cards", orgToken)).json() as {
      cards: { title: string }[];
    };
    expect(all.cards.map((c) => c.title)).toEqual(["Org wide"]);
    expect(
      (await asPlugin("POST", `/ui/cards/${orgCard}`, convToken, { status: "done" })).statusCode,
    ).toBe(404);
    const convCard = (a.json() as { card: { id: string } }).card.id;
    expect(
      (await asPlugin("POST", `/ui/cards/${convCard}`, orgToken, { status: "done" })).statusCode,
    ).toBe(404);
  });
});
