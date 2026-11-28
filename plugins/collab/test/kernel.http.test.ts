import { fileURLToPath } from "node:url";
import {
  createAgent,
  createDb,
  createLocalAccount,
  createOrg,
  enableModelProviders,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ItemConversationsResult,
  ItemDetailResult,
  ProjectsListResult,
} from "../src/page/contract.js";

/**
 * The collab plugin end to end through a real kernel (one in-process kernel with the api and
 * worker roles, model-fake scripting the agent's tool calls), with the plugin's real permission
 * manifest (auto-approved like every test kernel):
 *
 * the product owner creates a project and a requirement assigned to themselves and their agent →
 * the directed `item.assigned` runs through their acceptance rule (`auto`, the org default), which
 * opens the item's conversation → the agent moves the item into the gated "ready" status with
 * `item_transition` → the gate becomes a decision in the confirmer's (the project owner's) inbox →
 * another member's `gate.confirm` is refused, the owner's inbox "approve" button moves it → the
 * status's default assignment hands it to the engineering member and their default agent → their
 * acceptance opens a second conversation, which runs → `run.lifecycle` records the agent's state.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const COLLAB = fileURLToPath(new URL("../src/index.ts", import.meta.url));
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
      { extensions: [MODEL_FAKE, COLLAB], roles: ["api", "worker"] },
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

type Json = Record<string, unknown>;

interface InboxEntry {
  type: string;
  id: string;
  item?: {
    id: string;
    kind: string;
    title: { zh: string; en: string };
    link?: string;
    actions: { id: string; label: { en: string } }[];
  };
}

describe("collab in a kernel", () => {
  it("assignment → acceptance → agent transition → gate in the inbox → approval → handoff → agent state", async () => {
    const db = kernelDb(raw);
    const ownerId = await createLocalAccount(db, "owner", "Olivia");
    const owner = await login(k, "owner");
    const orgId = await createOrg(owner);
    const eng = await joinOrg(k, owner, orgId, "eng");
    await enableModelProviders(owner, orgId, ["model-fake"]);
    const enabled = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/collab`,
      payload: { enabled: true },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    // one subject's events coalesce into one automation run after a window (default 30 s)
    const settings = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { automations: { coalesceSeconds: 1 } },
    });
    expect(settings.statusCode, settings.body).toBe(200);
    // org-visible agents: usable by every member (the product agent and the engineering agent)
    const productAgent = await createAgent(owner, orgId);
    const engAgent = await createAgent(owner, orgId);

    const action = async (req: KernelRequest, actionId: string, payload: Json) => {
      const res = await req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/ui/actions/collab/projects`,
        payload: { actionId, payload, locale: "en" },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as { toast?: unknown; invalidate?: string[] };
    };
    const ok = async (req: KernelRequest, actionId: string, payload: Json) => {
      const out = await action(req, actionId, payload);
      expect(out.toast, `${actionId}: ${JSON.stringify(out)}`).toBeUndefined();
      return out;
    };
    const query = async <T>(req: KernelRequest, name: string, params: Json): Promise<T> => {
      const res = await req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/ui/query/collab/projects`,
        payload: { query: name, params, locale: "en" },
      });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { data: T }).data;
    };
    const detail = async (req: KernelRequest = owner) => {
      const d = await query<ItemDetailResult | { notFound: true }>(req, "item.detail", {
        key: "WEB-1",
      });
      if ("notFound" in d) throw new Error("WEB-1 not found");
      return d;
    };
    const conversations = async (req: KernelRequest = owner) => {
      const c = await query<ItemConversationsResult | { notFound: true }>(
        req,
        "item.conversations",
        { key: "WEB-1" },
      );
      if ("notFound" in c) throw new Error("WEB-1 not found");
      return c.conversations;
    };
    const inbox = async (req: KernelRequest) => {
      const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { items: InboxEntry[] }).items.filter((e) => e.type === "item");
    };

    // the project, with the engineer as an engineering member whose default agent is engAgent
    await ok(owner, "project.create", { key: "WEB", name: "Website" });
    const projects = await query<ProjectsListResult>(owner, "projects.list", {});
    const project = projects.projects.find((p) => p.key === "WEB");
    if (!project) throw new Error("project WEB missing");
    await ok(owner, "member.add", {
      projectId: project.id,
      accountId: eng.accountId,
      role: "member",
      functionLabel: "engineering",
    });
    await ok(eng.req, "member.function", {
      projectId: project.id,
      accountId: eng.accountId,
      defaultAgentId: engAgent,
    });

    // a requirement for the owner and their product agent: a directed item.assigned
    await ok(owner, "item.create", {
      projectId: project.id,
      type: "requirement",
      title: "Sign-up page",
      description: "Let visitors create an account.",
      responsibleAccountId: ownerId,
      agentId: productAgent,
    });
    let item = (await detail()).item;
    expect(item).toMatchObject({
      key: "WEB-1",
      statusKey: "backlog",
      responsible: { id: ownerId },
      agent: { id: productAgent },
    });

    // acceptance `auto` (the org's default): the kernel opens the item's conversation for the pair
    const first = await waitFor(
      async () => (await conversations()).find((c) => c.agent.id === productAgent),
      20_000,
      "the product agent's item conversation",
    );
    expect(first.owner.id).toBe(ownerId);
    await waitForTerminal(db, first.id, 1, 20_000);
    // run.lifecycle: the plugin recorded the pair's run state and conversation
    await waitFor(
      async () => {
        const d = (await detail()).item;
        return d.agentState === "idle" && d.agentConversationId === first.id;
      },
      20_000,
      "agent state of the first run",
    );

    // the owner drafts and sends it to review on the board (no gates on the way)
    item = (await detail()).item;
    await ok(owner, "item.move", { itemId: item.id, version: item.version, to: "drafting" });
    item = (await detail()).item;
    await ok(owner, "item.move", { itemId: item.id, version: item.version, to: "review" });
    item = (await detail()).item;
    expect(item.statusKey).toBe("review");

    // the agent moves it into the gated "ready": a gate decision for the confirmer, nothing moves
    const transition = { key: "WEB-1", version: item.version, to: "ready" };
    await postMessage(
      owner,
      orgId,
      first.id,
      `tool:plugin__collab__item_transition:${JSON.stringify(transition)}`,
    );
    await waitForTerminal(db, first.id, 2, 20_000);
    const result = (await eventsOf(db, first.id)).filter((e) => e.type === "tool_result").at(-1);
    expect(result?.payload).toMatchObject({
      toolKey: "plugin__collab__item_transition",
      isError: false,
      content: expect.stringMatching(/^Gate requested/),
    });
    const gated = await detail();
    expect(gated.item.statusKey).toBe("review");
    const gate = gated.decisions.find((d) => d.kind === "gate" && d.state === "open");
    expect(gate).toMatchObject({
      gateTarget: "ready",
      addressee: { id: ownerId },
      asker: { person: { id: ownerId }, agent: { id: productAgent } },
      canAnswer: true,
    });
    if (!gate) throw new Error("no open gate");

    // the gate decision waits in the owner's inbox with approve / reject buttons
    const notice = await waitFor(
      async () =>
        (await inbox(owner)).find(
          (e) => e.item?.kind === "collab.decision" && e.item.title.en.includes("WEB-1"),
        ),
      20_000,
      "the gate decision in the owner's inbox",
    );
    expect(notice.item?.title.zh).toMatch(/^请确认 WEB-1 /);
    expect(notice.item?.title.en).toMatch(/^Confirm on WEB-1 /);
    expect(notice.item?.link).toBe("/p/collab/projects?item=WEB-1");
    expect(notice.item?.actions.map((a) => a.id).sort()).toEqual(["approve", "reject"]);

    // only a confirmer may answer: the engineer's page action is refused, nothing moves
    const refused = await action(eng.req, "gate.confirm", { decisionId: gate.id, approve: true });
    expect(refused.toast).toBeDefined();
    expect((await detail()).item.statusKey).toBe("review");

    // the owner approves from the inbox: the kernel calls the plugin's action as the owner
    const clicked = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/inbox/items/${notice.item?.id}/actions/approve`,
      payload: { locale: "en" },
    });
    expect(clicked.statusCode, clicked.body).toBe(200);

    // entering "ready" hands it to the engineering member and their default agent
    const ready = await detail();
    expect(ready.item).toMatchObject({
      statusKey: "ready",
      responsible: { id: eng.accountId },
      agent: { id: engAgent },
    });
    expect(ready.decisions.find((d) => d.id === gate.id)).toMatchObject({
      state: "answered",
      answer: { optionId: "approve", by: { id: ownerId } },
    });
    // the clicked inbox item is resolved
    expect((await inbox(owner)).some((e) => e.item?.id === notice.item?.id)).toBe(false);
    // the engineer is told it is theirs (the assignment notice, with a stop button)
    const assigned = await waitFor(
      async () => (await inbox(eng.req)).find((e) => e.item?.kind === "collab.assigned"),
      20_000,
      "the engineer's assignment notice",
    );
    expect(assigned.item?.actions.map((a) => a.id)).toEqual(["stop"]);

    // the engineer's acceptance opens their agent's conversation on the item, which runs
    const second = await waitFor(
      async () => (await conversations(eng.req)).find((c) => c.agent.id === engAgent),
      20_000,
      "the engineering agent's item conversation",
    );
    expect(second.owner.id).toBe(eng.accountId);
    await waitForTerminal(db, second.id, 1, 20_000);
    await waitFor(
      async () => {
        const d = (await detail(eng.req)).item;
        return d.agentState === "idle" && d.agentConversationId === second.id;
      },
      20_000,
      "agent state of the engineering agent's run",
    );

    // the activity tells the story in order
    const activity = await query<{ entries: { kind: string }[] }>(owner, "item.activity", {
      key: "WEB-1",
    });
    expect(activity.entries.map((e) => e.kind).reverse()).toEqual(
      expect.arrayContaining([
        "created",
        "status_changed",
        "gate_requested",
        "decision_answered",
        "assigned",
      ]),
    );
  }, 120_000);
});
