import { fileURLToPath } from "node:url";
import {
  type ConversationEvent,
  createAgent,
  createConversation,
  createDb,
  createLocalAccount,
  createOrg,
  eventsOf,
  joinOrg,
  type KernelRequest,
  kernelDb,
  login,
  postMessage,
  startTestKernel,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
  type TestKernel,
  testKernelConfig,
  waitFor,
  waitForTerminal,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spiedRequests } from "./fixtures/request-spy.js";

/**
 * memory through a real kernel (one in-process kernel with the api and worker roles, model-fake
 * scripting the tool calls, `request-spy` recording each model request): a memory written in one
 * web conversation is in the next conversation's request as the `<plugin-context plugin="memory">`
 * system message; a group conversation gets neither the context nor the tools; with an embedding
 * model mapped to `memory.embed` the `memory-embed` queue embeds a memory written before the
 * mapping; removing the member and deleting the agent delete their rows (lifecycle hooks, delivered
 * through the kernel's outbox queue, so the test waits for the effect).
 */

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const MEMORY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const SPY = fileURLToPath(new URL("./fixtures/request-spy.ts", import.meta.url));
/** The scripted model provider (a devDependency): `tool:<key>:<json>` makes it call a tool. */
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";
const CONTEXT_OPEN = '<plugin-context plugin="memory">';

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startTestKernel(
    testKernelConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, MEMORY, SPY],
        roles: ["api", "worker"],
        extensionConfig: {
          "model-fake": { models: [{ id: "fake-1" }, { id: "fake-embed", kind: "embedding" }] },
        },
      },
    ),
    { resolveFrom: PLUGIN_DIR },
  );
  raw = createDb(pgc.url, 3);
}, 120_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

interface Row {
  path: string;
  account_id: string;
  agent_id: string;
  embedding_model: string | null;
}

async function memories(orgId: string): Promise<Row[]> {
  const { rows } = await sql<Row>`
    SELECT path, account_id, agent_id, embedding_model FROM plugin_memory.memories
    WHERE org_id = ${orgId} ORDER BY path`.execute(raw);
  return rows;
}

async function owners(orgId: string): Promise<{ account_id: string; agent_id: string }[]> {
  const { rows } = await sql<{ account_id: string; agent_id: string }>`
    SELECT account_id, agent_id FROM plugin_memory.owners WHERE org_id = ${orgId}`.execute(raw);
  return rows;
}

type ToolResultEvent = Extract<ConversationEvent, { type: "tool_result" }>;

/** Posts a message, waits for the `n`-th run of the conversation, returns its last tool result. */
async function run(
  req: KernelRequest,
  orgId: string,
  convId: string,
  n: number,
  text: string,
): Promise<ToolResultEvent["payload"] | undefined> {
  const db = kernelDb(raw);
  await postMessage(req, orgId, convId, text);
  const ends = await waitForTerminal(db, convId, n, 20_000);
  expect(ends[n - 1]?.type).toBe("run_finished");
  const results = (await eventsOf(db, convId)).filter(
    (e): e is ToolResultEvent => e.type === "tool_result",
  );
  return results.at(-1)?.payload;
}

const tool = (name: string, input: unknown) =>
  `tool:plugin__memory__${name}:${JSON.stringify(input)}`;

const requestsOf = (convId: string) => spiedRequests().filter((r) => r.conversationId === convId);

async function enable(req: KernelRequest, orgId: string, plugin: string): Promise<void> {
  const res = await req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
    payload: { enabled: true },
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe("memory in a kernel", () => {
  it("indexes a memory into the next conversation, never in a group, embeds once mapped, and cleans up", async () => {
    const db = kernelDb(raw);
    await createLocalAccount(db, "owner", "Olivia");
    const owner = await login(k, "owner");
    const orgId = await createOrg(owner);
    // memory is optional: off until the org switches it on
    await enable(owner, orgId, "memory");
    await enable(owner, orgId, "request-spy");
    const agentId = await createAgent(owner, orgId, { disabledTools: [] });

    // run 1: the model writes a memory (no embedding model mapped yet: saved without a vector)
    const first = await createConversation(owner, orgId, agentId);
    const written = await run(
      owner,
      orgId,
      first,
      1,
      tool("write", {
        path: "feedback/reply-in-chinese",
        description: "Reply in Chinese",
        body: "回复一律用中文。\nWhy: the member reads Chinese faster.",
      }),
    );
    expect(written).toMatchObject({
      toolKey: "plugin__memory__write",
      isError: false,
      content: "Created memory feedback/reply-in-chinese.md.",
    });
    expect(await memories(orgId)).toMatchObject([
      { path: "feedback/reply-in-chinese.md", embedding_model: null },
    ]);

    // run 2 in a new conversation: the request carries the index with that memory, and the tools
    const second = await createConversation(owner, orgId, agentId);
    await run(owner, orgId, second, 1, "echo:hi");
    const [req2] = requestsOf(second);
    const ctx2 = req2?.system.find((s) => s.includes(CONTEXT_OPEN));
    expect(ctx2).toContain("# Memory");
    expect(ctx2).toContain("- feedback/reply-in-chinese.md — Reply in Chinese");
    expect(req2?.tools).toEqual(expect.arrayContaining(["plugin__memory__view"]));

    // the memory page's server view, served by the kernel (the component's data)
    const page = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/ui/views/memory/overview?locale=en`,
    });
    expect(page.statusCode, page.body).toBe(200);
    expect((page.json() as { view: { data: unknown } }).view.data).toMatchObject({
      canAdmin: true,
      agents: [{ id: agentId, name: "Helper" }],
      selection: { agentId },
      nodes: [{ path: "feedback/reply-in-chinese.md", recalls: 0 }],
    });

    // a group conversation: neither the context nor the memory tools. (The kernel stores the
    // source at creation from the channel inbound; setting it here stands in for a fake IM group.)
    const group = await createConversation(owner, orgId, agentId);
    await sql`UPDATE capybara.conversations SET source = 'channel_group' WHERE id = ${group}`.execute(
      raw,
    );
    await run(owner, orgId, group, 1, "echo:hi");
    const [reqG] = requestsOf(group);
    expect(reqG).toBeDefined();
    expect(reqG?.system.some((s) => s.includes(CONTEXT_OPEN))).toBe(false);
    expect(reqG?.tools.some((t) => t.startsWith("plugin__memory__"))).toBe(false);
    const groupEvents = await eventsOf(db, group);
    expect(groupEvents.some((e) => e.type === "plugin_context")).toBe(false);

    // map memory.embed to model-fake's embedding model: a search finds the memory without a
    // vector and the memory-embed queue embeds it
    const mapped = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/model-purposes/memory.embed`,
      payload: { target: { model: { provider: "model-fake", model: "fake-embed" } } },
    });
    expect(mapped.statusCode, mapped.body).toBe(200);
    const found = await run(owner, orgId, second, 2, tool("search", { query: "中文" }));
    expect(found).toMatchObject({ isError: false });
    expect(found?.content).toContain("1. feedback/reply-in-chinese.md — Reply in Chinese");
    await waitFor(
      async () => (await memories(orgId))[0]?.embedding_model === "model-fake/fake-embed",
      20_000,
      "the memory-embed job",
    );
    // a write with the model mapped embeds within the call
    await run(
      owner,
      orgId,
      second,
      3,
      tool("write", { path: "user/role", description: "Backend lead", body: "Leads the team." }),
    );
    expect((await memories(orgId)).find((r) => r.path === "user/role.md")?.embedding_model).toBe(
      "model-fake/fake-embed",
    );

    // a member's memories with the same agent; removing the member deletes them only
    const mem = await joinOrg(k, owner, orgId, "mia", "member");
    const memConv = await createConversation(mem.req, orgId, agentId);
    await run(
      mem.req,
      orgId,
      memConv,
      1,
      tool("write", { path: "user/name", description: "Called Mia", body: "Mia." }),
    );
    expect((await memories(orgId)).filter((r) => r.account_id === mem.accountId)).toHaveLength(1);
    expect((await owners(orgId)).some((o) => o.account_id === mem.accountId)).toBe(true);
    const removed = await owner({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/members/${mem.accountId}`,
    });
    expect(removed.statusCode, removed.body).toBeLessThan(300);
    await waitFor(
      async () =>
        (await memories(orgId)).every((r) => r.account_id !== mem.accountId) &&
        (await owners(orgId)).every((o) => o.account_id !== mem.accountId),
      20_000,
      "the member's memories deleted",
    );
    expect((await memories(orgId)).map((r) => r.path)).toEqual([
      "feedback/reply-in-chinese.md",
      "user/role.md",
    ]);

    // deleting the agent deletes its memories (another agent's stay)
    const other = await createAgent(owner, orgId, { disabledTools: [] });
    const otherConv = await createConversation(owner, orgId, other);
    await run(
      owner,
      orgId,
      otherConv,
      1,
      tool("write", { path: "project/x", description: "Project X", body: "X." }),
    );
    const deleted = await owner({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
    });
    expect(deleted.statusCode, deleted.body).toBeLessThan(300);
    await waitFor(
      async () => (await memories(orgId)).every((r) => r.agent_id !== agentId),
      20_000,
      "the agent's memories deleted",
    );
    expect(await memories(orgId)).toMatchObject([{ path: "project/x.md", agent_id: other }]);
  }, 120_000);
});
