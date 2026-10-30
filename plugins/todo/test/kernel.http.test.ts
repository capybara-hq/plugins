import { fileURLToPath } from "node:url";
import {
  type ConversationEvent,
  createAgent,
  createConversation,
  createDb,
  createLocalAccount,
  createOrg,
  eventsOf,
  kernelDb,
  login,
  postMessage,
  startTestKernel,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
  type TestKernel,
  testKernelConfig,
  waitForTerminal,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * todo through a real kernel (one in-process kernel, model-fake scripting the tool call): the
 * `tasks-panel` view (and its old alias `tasks`) the kernel serves after `todo__write` shows the in-progress item by its activeForm,
 * the badge counts completed items, and the bilingual display summary lands in the tool_result
 * event while the model sees the rendered list. The kernel side of views (routes, invalidation, the
 * summary staying out of model requests) is tested in core on the fake `fake-tools-ui`.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const TODO = fileURLToPath(new URL("../src/index.ts", import.meta.url));
/** The scripted model provider (a devDependency): `tool:<key>:<json>` makes it call a tool. */
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startTestKernel(
    testKernelConfig(
      { pg: pgc.url, redis: rd.url },
      { extensions: [MODEL_FAKE, TODO], roles: ["api", "worker"] },
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

describe("todo in a kernel", () => {
  it("the tasks view shows the in-progress item by its activeForm; the summary is in tool_result", async () => {
    const db = kernelDb(raw);
    await createLocalAccount(db, "owner");
    const owner = await login(k, "owner");
    const orgId = await createOrg(owner);
    const enabled = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/todo`,
      payload: { enabled: true },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const agentId = await createAgent(owner, orgId, {
      tools: [{ kind: "plugin", plugin: "todo", name: "write" }],
    });
    const convId = await createConversation(owner, orgId, agentId);
    const view = async (id = "tasks-panel") => {
      const res = await owner({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/ui/views/todo/${id}?conversationId=${convId}&locale=en`,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as {
        view: { badge?: string; blocks: { type: string; items?: unknown[] }[] };
      };
    };
    expect((await view()).view.badge).toBe("0/0");

    const todos = {
      todos: [
        { content: "Plan", status: "completed", activeForm: "Planning" },
        { content: "Build", status: "in_progress", activeForm: "Building" },
        { content: "Ship", status: "pending", activeForm: "Shipping" },
      ],
    };
    await postMessage(owner, orgId, convId, `tool:todo__write:${JSON.stringify(todos)}`);
    await waitForTerminal(db, convId, 1, 20_000);

    const after = (await view()).view;
    expect(after.badge).toBe("1/3");
    expect(after.blocks).toEqual([
      {
        type: "checklist",
        items: [
          { text: "Plan", status: "completed", id: "0" },
          { text: "Building", status: "in_progress", id: "1" },
          { text: "Ship", status: "pending", id: "2" },
        ],
      },
    ]);
    // the old id `tasks` still answers, with the panel (one release)
    expect((await view("tasks")).view).toEqual(after);
    expect((await view("tasks-section")).view.badge).toBe("1/3");
    expect((await view("tasks-card")).view.badge).toBe("1/3");

    const result = (await eventsOf(db, convId)).find(
      (e): e is Extract<ConversationEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(result?.payload).toMatchObject({
      toolKey: "todo__write",
      isError: false,
      content: "Todo list updated (3 items):\n[x] Plan\n[>] Building\n[ ] Ship",
      display: { summary: { zh: "更新任务清单（3 项）", en: "Updated task list (3 items)" } },
      card: { plugin: "todo", view: "tasks-card", key: expect.any(String) },
    });

    // a second write: the first call's card still shows the list as of that call (review M1)
    const next = { todos: todos.todos.map((t) => ({ ...t, status: "completed" })) };
    await postMessage(owner, orgId, convId, `tool:todo__write:${JSON.stringify(next)}`);
    await waitForTerminal(db, convId, 2, 20_000);
    expect((await view()).view.badge).toBe("3/3");
    const first = result?.payload as { callId: string; card: { key: string } };
    const card = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/ui/views/todo/tasks-card?conversationId=${convId}&locale=en&callId=${encodeURIComponent(first.callId)}&key=${encodeURIComponent(first.card.key)}`,
    });
    expect(card.statusCode, card.body).toBe(200);
    expect((card.json() as { view: { badge: string } }).view.badge).toBe("1/3");
  }, 60_000);
});
