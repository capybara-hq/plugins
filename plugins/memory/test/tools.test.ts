import type {
  ExtensionContext,
  ToolCallContext,
  ToolHandler,
  ToolResult,
  ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EMBED_QUEUE } from "../src/embed.js";
import { get, put } from "../src/store.js";
import { NOT_AVAILABLE, registerTools } from "../src/tools.js";
import { fakeModels, fakeQueue, type QueuedJob } from "./fakes.js";
import { migrate, pluginDb } from "./helpers.js";

let pgc: TestContainer;
let db: ExtensionContext["db"];
let destroy: () => Promise<void>;
let jobs: QueuedJob[];

beforeAll(async () => {
  pgc = await startTestPostgres();
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

const A = { orgId: "org-1", agentId: "agent-1", accountId: "acc-a" };

/** The tools as registered, on a ctx whose model is `models`. */
function tools(
  models: ExtensionContext["models"] = fakeModels({ mapped: false }),
  opts?: { embedWaitMs?: number },
) {
  const registered = new Map<string, { spec: ToolSpec; handler: ToolHandler }>();
  registerTools(
    {
      db,
      models,
      queue: fakeQueue(jobs),
      tools: {
        register: (spec: ToolSpec, handler: ToolHandler) => {
          registered.set(spec.name, { spec, handler });
        },
      },
    } as unknown as ExtensionContext,
    opts,
  );
  const run = async (name: string, input: unknown, call: CallOverrides = {}) => {
    const t = registered.get(name);
    if (t === undefined) throw new Error(`no tool ${name}`);
    const r = (await t.handler(input, ctxOf(call))) as ToolResult;
    const first = r.content[0];
    return first?.type === "text" ? first.text : "";
  };
  return { registered, run };
}

/** Fields to change in the call context; `undefined` removes one (an older kernel). */
type CallOverrides = { [K in keyof ToolCallContext]?: ToolCallContext[K] | undefined };

const ctxOf = (over: CallOverrides = {}): ToolCallContext =>
  ({
    orgId: A.orgId,
    accountId: A.accountId,
    agentId: A.agentId,
    conversationId: "conv-1",
    callId: "call-1",
    signal: new AbortController().signal,
    source: "web",
    ownerAccountId: A.accountId,
    role: "member",
    ...over,
  }) as ToolCallContext;

describe("memory tools", { timeout: 60_000 }, () => {
  it("registers view, search, write, edit and delete for web and DM conversations only", () => {
    const { registered } = tools();
    expect([...registered.keys()].sort()).toEqual(["delete", "edit", "search", "view", "write"]);
    for (const { spec } of registered.values()) {
      expect(spec.sources).toEqual(["web", "channel_dm"]);
      expect(spec.description.length).toBeGreaterThan(20);
      expect(spec.description).not.toMatch(/[一-鿿]/);
    }
  });

  it.each([
    ["a guest", { role: "guest" as const }],
    ["a channel group", { source: "channel_group" as const }],
    ["a sub-agent", { source: "subagent" as const }],
    ["someone other than the owner", { ownerAccountId: "acc-b" }],
    ["a call without a source", { source: undefined }],
  ])("refuses every tool for %s", async (_, over) => {
    const { run } = tools();
    const inputs: Record<string, unknown> = {
      view: { path: "/" },
      search: { query: "x" },
      write: { path: "user/x", description: "d", body: "b" },
      edit: { path: "user/x", old: "a", new: "b" },
      delete: { path: "user/x" },
    };
    for (const [name, input] of Object.entries(inputs)) {
      const err = await run(name, input, over).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(ToolError);
      expect((err as Error).message).toContain(
        "Memory is only available in one-to-one conversations with their owner.",
      );
      expect((err as Error).message).toBe(NOT_AVAILABLE);
    }
    expect(await db.selectFrom("memories").select("id").execute()).toEqual([]);
  });

  it("works in a channel DM for an admin who owns the conversation", async () => {
    const { run } = tools();
    const text = await run(
      "write",
      { path: "user/role", description: "Role", body: "Engineer" },
      { source: "channel_dm", role: "admin" },
    );
    expect(text).toContain("Created memory user/role.md");
  });

  it("write creates, then updates, and lists links to memories not written yet", async () => {
    const { run } = tools();
    const created = await run("write", {
      path: "feedback/Reply-In-Chinese",
      description: "Reply in Chinese",
      body: "回复一律用中文. See [[tone]] and [[user/role.md]].",
    });
    expect(created).toContain("Created memory feedback/reply-in-chinese.md");
    expect(created).toContain("tone");
    expect(created).toContain("user/role.md");
    const row = await get(db, A, "feedback/reply-in-chinese.md");
    expect(row?.createdIn).toBe("conv-1");

    await run("write", { path: "user/role", description: "Role", body: "Engineer" });
    const updated = await run("write", {
      path: "feedback/reply-in-chinese.md",
      description: "Reply in Chinese",
      body: "回复一律用中文. See [[user/role.md]].",
    });
    expect(updated).toContain("Updated memory feedback/reply-in-chinese.md");
    expect(updated).not.toContain("not written yet");
  });

  it("write to a path outside the four types fails naming them", async () => {
    const { run } = tools();
    const err = await run("write", { path: "notes/x", description: "d", body: "b" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toContain("user/, feedback/, project/, reference/");
    const up = await run("write", { path: "user/../x", description: "d", body: "b" }).catch(
      (e: unknown) => e,
    );
    expect(up).toBeInstanceOf(ToolError);
  });

  it("write embeds the memory when a model is mapped", async () => {
    const { run } = tools(fakeModels());
    await run("write", { path: "user/coffee", description: "Coffee", body: "Drinks coffee" });
    const row = await get(db, A, "user/coffee.md");
    expect(row?.embeddingModel).toBe("fake/emb-1");
    expect(jobs).toEqual([]);
  });

  it("write returns after the wait when embedding hangs, and enqueues the embedding", async () => {
    const { run } = tools(fakeModels({ hang: true }), { embedWaitMs: 50 });
    const text = await run("write", { path: "user/coffee", description: "Coffee", body: "x" });
    expect(text).toContain("Created memory user/coffee.md");
    const row = await get(db, A, "user/coffee.md");
    expect(jobs.map((j) => [j.name, (j.opts as { jobId: string }).jobId])).toContainEqual([
      EMBED_QUEUE,
      `memory-embed-${row?.id}`,
    ]);
  });

  it("view lists the root, a directory, and a memory with its links; a read is a recall", async () => {
    const { run } = tools();
    await run("write", { path: "user/role", description: "Role", body: "Engineer" });
    await run("write", {
      path: "project/github/probe",
      description: "Probe work",
      body: "Ship it. [[user/role.md]] [[later]]",
    });
    const root = await run("view", { path: "/" });
    expect(root.split("\n")).toEqual(["user/ (1 memory)", "project/ (1 memory)"]);
    const dir = await run("view", { path: "project/" });
    expect(dir.split("\n")).toEqual(["project/github/ (1 memory)"]);
    const deep = await run("view", { path: "project/github" });
    expect(deep).toBe("project/github/probe.md — Probe work");

    const mem = await run("view", { path: "project/github/probe.md" });
    expect(mem).toContain("path: project/github/probe.md");
    expect(mem).toContain("description: Probe work");
    expect(mem).toContain("Ship it.");
    expect(mem).toContain("→ user/role.md");
    expect(mem).toContain("→ later (not written yet)");
    expect((await get(db, A, "project/github/probe.md"))?.recallCount).toBe(1);
  });

  it("view of an empty root says there are no memories yet", async () => {
    const { run } = tools();
    expect(await run("view", { path: "/" })).toBe("No memories yet.");
  });

  it("never shows, changes or deletes another member's or agent's memory", async () => {
    await put(
      db,
      { ...A, accountId: "acc-b" },
      { path: "user/secret.md", description: "B", body: "B's", conversationId: null },
    );
    await put(
      db,
      { ...A, agentId: "agent-2" },
      { path: "user/other.md", description: "O", body: "other", conversationId: null },
    );
    const { run } = tools();
    for (const path of ["user/secret.md", "user/other.md"]) {
      await expect(run("view", { path })).rejects.toThrow(/No memory at/);
      await expect(run("edit", { path, old: "B", new: "x" })).rejects.toThrow(/No memory at/);
      await expect(run("delete", { path })).rejects.toThrow(/No memory at/);
    }
    expect(await run("view", { path: "/" })).toBe("No memories yet.");
    expect(await run("search", { query: "secret" })).toContain("No memories match");
    // the call context's owner wins over anything in the input
    await expect(
      run("view", { path: "user/secret.md", accountId: "acc-b", agentId: "agent-2" }),
    ).rejects.toThrow(/No memory at/);
  });

  it("edit replaces one occurrence and reports a wrong count", async () => {
    const { run } = tools();
    await run("write", { path: "feedback/style", description: "Style", body: "Use tabs. tabs!" });
    await expect(
      run("edit", { path: "feedback/style", old: "tabs", new: "spaces" }),
    ).rejects.toThrow(/occurs 2 times/);
    const ok = await run("edit", {
      path: "feedback/style",
      old: "Use tabs.",
      new: "Use spaces.",
      description: "Indentation",
    });
    expect(ok).toContain("Edited memory feedback/style.md");
    const row = await get(db, A, "feedback/style.md");
    expect(row?.body).toBe("Use spaces. tabs!");
    expect(row?.description).toBe("Indentation");
  });

  it("delete removes a memory; deleting a missing one fails", async () => {
    const { run } = tools();
    await run("write", { path: "user/role", description: "Role", body: "Engineer" });
    expect(await run("delete", { path: "user/role.md" })).toContain("Deleted memory user/role.md");
    expect(await get(db, A, "user/role.md")).toBeNull();
    await expect(run("delete", { path: "user/role.md" })).rejects.toThrow(/No memory at/);
  });

  it("search lists numbered hits with a snippet", async () => {
    const { run } = tools();
    await run("write", {
      path: "feedback/reply-in-chinese",
      description: "Reply language",
      body: "回复一律用中文",
    });
    await run("write", { path: "user/role", description: "Role", body: "Engineer" });
    const text = await run("search", { query: "中文" });
    expect(text.split("\n")).toEqual([
      "1. feedback/reply-in-chinese.md — Reply language",
      "   回复一律用中文",
    ]);
    expect(await run("search", { query: "nothing-like-this" })).toContain("No memories match");
  });
});
