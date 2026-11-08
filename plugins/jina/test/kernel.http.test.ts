import { fileURLToPath } from "node:url";
import {
  type ConversationEvent,
  createAgent,
  createConversation,
  createDb,
  createLocalAccount,
  createOrg,
  eventsOf,
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
  waitForEvent,
  waitForTerminal,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeJina, startFakeJina } from "./fake-jina.js";

/**
 * jina through a real kernel (one in-process kernel, model-fake scripting the tool calls): the
 * kernel's builtin WebSearch and WebFetch tools reach Jina's search and reader APIs (a local fake)
 * through this plugin, with the org's key.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const JINA = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";

let pgc: TestContainer;
let rd: TestContainer;
let fake: FakeJina;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;

beforeAll(async () => {
  fake = await startFakeJina();
  fake.respond((req) =>
    req.method === "GET"
      ? {
          status: 200,
          body: JSON.stringify({
            data: [
              {
                title: "Capybara facts",
                url: "https://example.org/capybara",
                description: "The largest rodent.",
              },
            ],
          }),
        }
      : {
          status: 200,
          body: JSON.stringify({
            data: {
              title: "Page",
              url: (JSON.parse(req.body) as { url: string }).url,
              content: "# Page\n\nSome text.",
            },
          }),
        },
  );
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startTestKernel(
    testKernelConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, JINA],
        roles: ["api", "worker"],
        extensionConfig: { jina: { searchUrl: fake.url, readerUrl: fake.url } },
      },
    ),
    { resolveFrom: PLUGIN_DIR },
  );
  raw = createDb(pgc.url, 3);
}, 120_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), fake?.stop()]);
});

type ToolResult = Extract<ConversationEvent, { type: "tool_result" }>;

describe("jina in a kernel", () => {
  it("WebSearch and WebFetch run through jina with the org's key", async () => {
    const db = kernelDb(raw);
    await createLocalAccount(db, "owner");
    const owner = await login(k, "owner");
    const orgId = await createOrg(owner);
    const enabled = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/jina`,
      payload: { enabled: true, config: { apiKey: "org-key-1" } },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);

    const points = await availablePoints(owner, orgId);
    expect(points).toContainEqual({ point: "web-search", available: true });
    expect(points).toContainEqual({ point: "web-fetch", available: true });

    const agentId = await createAgent(owner, orgId, {
      disabledTools: [],
    });
    const convId = await createConversation(owner, orgId, agentId);

    // WebSearch: ask -> approve always -> result from the fake
    await postMessage(
      owner,
      orgId,
      convId,
      `tool:WebSearch:${JSON.stringify({ query: "capybara" })}`,
    );
    await approve(owner, orgId, db, convId);
    await waitForTerminal(db, convId, 1, 30_000);
    const search = await toolResult(db, convId, "WebSearch");
    expect(search.isError).toBe(false);
    const searchText = textOf(search.content);
    expect(searchText.startsWith("Search date: ")).toBe(true);
    expect(searchText).toContain("Capybara facts");
    expect(searchText).toContain("https://example.org/capybara");
    const searchReq = fake.requests.find((r) => r.method === "GET");
    expect(searchReq?.headers.authorization).toBe("Bearer org-key-1");

    // WebFetch: the page is read through the reader; the answer is model-fake's extraction reply
    const page = "https://example.com/page";
    await postMessage(
      owner,
      orgId,
      convId,
      `tool:WebFetch:${JSON.stringify({ url: page, prompt: "What is it?" })}`,
    );
    await approve(owner, orgId, db, convId);
    await waitForTerminal(db, convId, 2, 30_000);
    const fetched = await toolResult(db, convId, "WebFetch");
    expect(fetched.isError).toBe(false);
    expect(textOf(fetched.content).startsWith(`URL: ${page}`)).toBe(true);
    const readReq = fake.requests.find((r) => r.method === "POST");
    expect(readReq?.path).toBe("/");
    expect(readReq?.body).toContain(page);
    expect(readReq?.headers.authorization).toBe("Bearer org-key-1");

    // a second org cannot enable jina without a key (the kernel validates the org config), so
    // neither point is available to it
    const org2 = await createOrg(owner, "second");
    const enabled2 = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${org2}/extensions/jina`,
      payload: { enabled: true },
    });
    expect(enabled2.statusCode, enabled2.body).toBe(400);
    expect(enabled2.json()).toMatchObject({ error: { code: "extension.config_invalid" } });
    const points2 = await availablePoints(owner, org2);
    expect(points2.find((p) => p.point === "web-search")?.available ?? false).toBe(false);
    expect(points2.find((p) => p.point === "web-fetch")?.available ?? false).toBe(false);
  }, 120_000);
});

async function availablePoints(owner: KernelRequest, orgId: string) {
  const res = await owner({
    method: "GET",
    url: `/api/v1/orgs/${orgId}/extension-points/available`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { points: { point: string; available: boolean }[] }).points;
}

async function approve(
  owner: KernelRequest,
  orgId: string,
  db: ReturnType<typeof kernelDb>,
  convId: string,
) {
  const seen = new Set<string>();
  for (const e of await eventsOf(db, convId)) {
    if (e.type === "approval_requested") seen.add((e.payload as { approvalId: string }).approvalId);
  }
  const ev = await waitForEvent(
    db,
    convId,
    (e) =>
      e.type === "approval_requested" &&
      !seen.has((e.payload as { approvalId: string }).approvalId),
    20_000,
    "approval_requested",
  );
  const { approvalId } = ev.payload as { approvalId: string };
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/decision`,
    payload: { decision: "approve", scope: "always" },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function toolResult(db: ReturnType<typeof kernelDb>, convId: string, toolKey: string) {
  const e = (await eventsOf(db, convId)).find(
    (x): x is ToolResult =>
      x.type === "tool_result" && (x.payload as { toolKey: string }).toolKey === toolKey,
  );
  if (!e) throw new Error(`no tool_result for ${toolKey}`);
  return e.payload as { isError: boolean; content: unknown };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b as { text?: string }).text ?? "").join("");
  }
  return JSON.stringify(content);
}
