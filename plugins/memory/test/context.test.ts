import type { ContextRequest, ExtensionContext } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  GUIDANCE,
  INDEX_MAX_BYTES,
  INDEX_MAX_LINES,
  provideMemoryContext,
} from "../src/context.js";
import { type Owner, put, touch } from "../src/store.js";
import { migrate, pluginDb } from "./helpers.js";

let pgc: TestContainer;
let db: ExtensionContext["db"];
let destroy: () => Promise<void>;

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
  await db.deleteFrom("owners").execute();
});

const A: Owner = { orgId: "org-1", agentId: "agent-1", accountId: "acc-a" };

const request = (over: Partial<ContextRequest> = {}): ContextRequest => ({
  orgId: A.orgId,
  accountId: A.accountId,
  agentId: A.agentId,
  agentName: "Helper",
  conversationId: "conv-1",
  runId: "run-1",
  source: "web",
  role: "member",
  ownerAccountId: A.accountId,
  ownerName: "Alice",
  tools: ["Bash", "plugin__memory__view", "plugin__memory__write"],
  config: {},
  signal: new AbortController().signal,
  ...over,
});

const write = (path: string, description = "desc", owner: Owner = A) =>
  put(db, owner, { path, description, body: "body", conversationId: null });

const indexOf = (text: string): string[] => text.slice(GUIDANCE.length + 2).split("\n");

async function owners() {
  return db.selectFrom("owners").select(["account_id", "agent_name", "owner_name"]).execute();
}

describe("memory context", { timeout: 120_000 }, () => {
  it.each([
    ["a channel group", { source: "channel_group" as const }],
    ["a sub-agent", { source: "subagent" as const }],
    ["a guest", { role: "guest" as const }],
  ])("provides nothing in %s and remembers no owner", async (_, over) => {
    await write("user/role");
    expect(await provideMemoryContext(db, request(over))).toBeNull();
    expect(await owners()).toEqual([]);
  });

  it("provides nothing when the caller is not the conversation's owner", async () => {
    await write("user/role");
    expect(
      await provideMemoryContext(db, request({ ownerAccountId: "acc-b", ownerName: "Bob" })),
    ).toBeNull();
  });

  it("provides nothing without a memory tool, but still remembers the owner's names", async () => {
    await write("user/role");
    expect(await provideMemoryContext(db, request({ tools: ["Bash"] }))).toBeNull();
    expect(await owners()).toEqual([
      { account_id: "acc-a", agent_name: "Helper", owner_name: "Alice" },
    ]);
  });

  it("gives the guidance and 'No memories yet.' when there are none", async () => {
    const res = await provideMemoryContext(db, request({ source: "channel_dm", role: "owner" }));
    expect(res).toEqual({ text: `${GUIDANCE}\n\nNo memories yet.` });
  });

  it("lists memories by type (user, feedback, project, reference), then recalls, then path", async () => {
    const ref = await write("reference/dash", "Dashboards");
    await write("project/b", "Project B");
    const pa = await write("project/a", "Project A");
    await write("feedback/tone", "Tone");
    await write("user/role", "Role");
    const pc = await write("project/c", "Project C");
    await touch(db, A, [pc.row.id]);
    await touch(db, A, [pc.row.id, pa.row.id, ref.row.id]);
    // another owner's memory never shows
    await write("user/other", "Other", { ...A, accountId: "acc-b" });

    const res = await provideMemoryContext(db, request());
    expect(res?.text.startsWith(`${GUIDANCE}\n\n`)).toBe(true);
    expect(indexOf(res?.text ?? "")).toEqual([
      "- user/role.md — Role",
      "- feedback/tone.md — Tone",
      "- project/c.md — Project C",
      "- project/a.md — Project A",
      "- project/b.md — Project B",
      "- reference/dash.md — Dashboards",
    ]);
  });

  it("stops at 200 lines with the 'N more' line", async () => {
    for (let i = 0; i < 250; i++) await write(`project/p${String(i).padStart(3, "0")}`, `P${i}`);
    const lines = indexOf((await provideMemoryContext(db, request()))?.text ?? "");
    expect(lines).toHaveLength(INDEX_MAX_LINES + 1);
    expect(lines[INDEX_MAX_LINES]).toBe(
      "- … 50 more memories not listed; use plugin__memory__search or plugin__memory__view to find them, and consolidate.",
    );
    expect(Buffer.byteLength(lines.join("\n"))).toBeLessThanOrEqual(INDEX_MAX_BYTES);
  });

  it("stops before 16 KB with the 'N more' line", async () => {
    const long = "记".repeat(190);
    for (let i = 0; i < 120; i++) await write(`project/p${String(i).padStart(3, "0")}`, long);
    const lines = indexOf((await provideMemoryContext(db, request()))?.text ?? "");
    const index = lines.join("\n");
    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(INDEX_MAX_BYTES);
    const listed = lines.length - 1;
    expect(listed).toBeLessThan(120);
    expect(lines.at(-1)).toBe(
      `- … ${120 - listed} more memories not listed; use plugin__memory__search or plugin__memory__view to find them, and consolidate.`,
    );
  });

  it("returns the same text when nothing changed, and after a recall that keeps the order", async () => {
    const a = await write("user/a", "A");
    await write("user/b", "B");
    await touch(db, A, [a.row.id]);
    const first = await provideMemoryContext(db, request());
    const second = await provideMemoryContext(db, request({ runId: "run-2" }));
    expect(second).toEqual(first);
    await touch(db, A, [a.row.id]);
    expect(await provideMemoryContext(db, request({ runId: "run-3" }))).toEqual(first);
  });
});
