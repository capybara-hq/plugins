import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  edit,
  get,
  linksOf,
  list,
  MAX_BODY_BYTES,
  MAX_DESCRIPTION_LENGTH,
  MAX_MEMORIES_PER_OWNER,
  MemoryEditError,
  MemoryLimitError,
  MemoryNotFoundError,
  MemoryPathError,
  type Owner,
  purge,
  put,
  rememberOwner,
  remove,
  touch,
} from "../src/store.js";
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
  await db.deleteFrom("admin_access_log").execute();
});

const A: Owner = { orgId: "org-1", agentId: "agent-1", accountId: "acc-a" };
/** Same agent, another member. */
const B: Owner = { ...A, accountId: "acc-b" };
/** Same member, another agent. */
const A2: Owner = { ...A, agentId: "agent-2" };
/** Same ids in another org. */
const OTHER_ORG: Owner = { ...A, orgId: "org-2" };

const write = (owner: Owner, path: string, body = "body", description = "desc") =>
  put(db, owner, { path, description, body, conversationId: "conv-1" });

describe("store", () => {
  it("put then get round-trips a memory", async () => {
    const { row, created } = await write(
      A,
      "feedback/Reply-In-Chinese",
      "回复一律用中文",
      "Reply in Chinese",
    );
    expect(created).toBe(true);
    expect(row).toMatchObject({
      orgId: A.orgId,
      agentId: A.agentId,
      accountId: A.accountId,
      path: "feedback/reply-in-chinese.md",
      type: "feedback",
      description: "Reply in Chinese",
      body: "回复一律用中文",
      hasEmbedding: false,
      recallCount: 0,
      lastRecalledAt: null,
      createdIn: "conv-1",
    });
    const got = await get(db, A, "feedback/reply-in-chinese.md");
    expect(got).toEqual(row);
    expect(await get(db, A, "/feedback/Reply-In-Chinese")).toEqual(row);
  });

  it("put on an existing path replaces it and keeps recall_count and created_in", async () => {
    const first = await write(A, "user/role", "old");
    await touch(db, A, [first.row.id]);
    const second = await put(db, A, {
      path: "user/role.md",
      description: "new desc",
      body: "new",
      conversationId: "conv-2",
    });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row).toMatchObject({
      body: "new",
      description: "new desc",
      recallCount: 1,
      createdIn: "conv-1",
    });
    expect(second.row.lastRecalledAt).toBeInstanceOf(Date);
    expect(await list(db, A)).toHaveLength(1);
  });

  it("owners with the same path are independent across member, agent and org", async () => {
    await write(A, "user/role.md", "a");
    await write(B, "user/role.md", "b");
    await write(A2, "user/role.md", "a2");
    await write(OTHER_ORG, "user/role.md", "other");
    expect((await get(db, A, "user/role.md"))?.body).toBe("a");
    expect((await get(db, B, "user/role.md"))?.body).toBe("b");
    expect((await get(db, A2, "user/role.md"))?.body).toBe("a2");
    expect((await get(db, OTHER_ORG, "user/role.md"))?.body).toBe("other");

    await write(B, "user/only-b.md");
    expect((await list(db, A)).map((r) => r.path)).toEqual(["user/role.md"]);
    expect(await get(db, A, "user/only-b.md")).toBeNull();
    expect(await remove(db, A, "user/only-b.md")).toBe(false);
    expect(await get(db, B, "user/only-b.md")).not.toBeNull();

    expect(await remove(db, A, "user/role.md")).toBe(true);
    expect(await get(db, A, "user/role.md")).toBeNull();
    for (const o of [B, A2, OTHER_ORG]) expect(await get(db, o, "user/role.md")).not.toBeNull();
  });

  it("touch and edit by id or path never reach another owner's row", async () => {
    const b = await write(B, "user/role.md", "b body");
    await touch(db, A, [b.row.id]);
    expect((await get(db, B, "user/role.md"))?.recallCount).toBe(0);
    await expect(edit(db, A, "user/role.md", "b", "x")).rejects.toBeInstanceOf(MemoryNotFoundError);
    expect(await linksOf(db, A, b.row.id)).toEqual([]);
  });

  it("a crafted path cannot escape the owner's rows", async () => {
    await write(B, "user/secret.md", "b secret");
    await expect(write(A, "user/../../acc-b/user/secret")).rejects.toBeInstanceOf(MemoryPathError);
    expect(await get(db, A, "user/../secret.md")).toBeNull();
    expect(await list(db, A, "user/%")).toEqual([]);
    expect(await list(db, A, "%")).toEqual([]);
    expect(await list(db, A, "_ser")).toEqual([]);
  });

  it("list filters by directory, ordered by path", async () => {
    await write(A, "project/github/probe.md");
    await write(A, "project/plan.md");
    await write(A, "user/role.md");
    await write(A, "project_x/../user/no.md").catch(() => {});
    expect((await list(db, A)).map((r) => r.path)).toEqual([
      "project/github/probe.md",
      "project/plan.md",
      "user/role.md",
    ]);
    expect((await list(db, A, "/project/")).map((r) => r.path)).toEqual([
      "project/github/probe.md",
      "project/plan.md",
    ]);
    expect((await list(db, A, "Project/GitHub")).map((r) => r.path)).toEqual([
      "project/github/probe.md",
    ]);
    expect((await list(db, A, "proj")).map((r) => r.path)).toEqual([]);
    expect((await list(db, A, "/")).map((r) => r.path)).toHaveLength(3);
  });

  it("list matches a directory with a supplementary-plane character literally", async () => {
    // U+20000 is two UTF-16 code units but one character in PostgreSQL
    await write(A, "project/𠀀/plan.md");
    await write(A, "project/𠀀x/other.md");
    await write(A, "project/plan.md");
    expect((await list(db, A, "project/𠀀")).map((r) => r.path)).toEqual(["project/𠀀/plan.md"]);
    expect((await list(db, A, "project")).map((r) => r.path)).toHaveLength(3);
  });

  it("rows do not carry the vector, only whether there is one", async () => {
    const { row } = await write(A, "user/role.md");
    expect(row).not.toHaveProperty("embedding");
    expect(row.hasEmbedding).toBe(false);
  });

  it("rejects an invalid path, a long description, a multi-line description and a large body", async () => {
    await expect(write(A, "notes/x")).rejects.toThrow(/user\/, feedback\/, project\/, reference\//);
    await expect(
      write(A, "user/x", "b", "d".repeat(MAX_DESCRIPTION_LENGTH + 1)),
    ).rejects.toBeInstanceOf(MemoryLimitError);
    await expect(write(A, "user/x", "b", "")).rejects.toBeInstanceOf(MemoryLimitError);
    await expect(write(A, "user/x", "b", "line one\nline two")).rejects.toThrow(/one line/);
    // 3 bytes per character in UTF-8
    await expect(
      write(A, "user/x", "中".repeat(Math.floor(MAX_BODY_BYTES / 3) + 1)),
    ).rejects.toThrow(String(MAX_BODY_BYTES));
    expect(await list(db, A)).toEqual([]);
  });

  it("the write past the per-owner cap fails with the cap message; replacing still works", async () => {
    await db
      .insertInto("memories")
      .values(
        Array.from({ length: MAX_MEMORIES_PER_OWNER }, (_, i) => ({
          org_id: A.orgId,
          agent_id: A.agentId,
          account_id: A.accountId,
          path: `reference/m${i}.md`,
          type: "reference",
          description: "d",
          body: "b",
        })),
      )
      .execute();
    const err = await write(A, "reference/one-more.md").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryLimitError);
    expect((err as Error).message).toContain(String(MAX_MEMORIES_PER_OWNER));
    expect((err as Error).message).toMatch(/consolidate/i);
    expect((await write(A, "reference/m0.md", "replaced")).created).toBe(false);
    // another owner is not affected by A's count
    expect((await write(B, "reference/one-more.md")).created).toBe(true);
  });

  it("edit replaces exactly one occurrence and may change the description", async () => {
    await write(A, "feedback/style.md", "Use tabs. Why: team rule.", "Indentation");
    const row = await edit(db, A, "feedback/style", "tabs", "spaces", "Indent with spaces");
    expect(row.body).toBe("Use spaces. Why: team rule.");
    expect(row.description).toBe("Indent with spaces");
    const again = await edit(db, A, "feedback/style.md", "team", "house");
    expect(again.body).toBe("Use spaces. Why: house rule.");
    expect(again.description).toBe("Indent with spaces");
  });

  it("edit with zero or several matches fails with the count", async () => {
    await write(A, "feedback/style.md", "a a a");
    const none = await edit(db, A, "feedback/style.md", "b", "c").catch((e: unknown) => e);
    expect(none).toBeInstanceOf(MemoryEditError);
    expect((none as MemoryEditError).count).toBe(0);
    const many = await edit(db, A, "feedback/style.md", "a", "c").catch((e: unknown) => e);
    expect(many).toBeInstanceOf(MemoryEditError);
    expect((many as MemoryEditError).count).toBe(3);
    expect((many as Error).message).toContain("3");
    await expect(edit(db, A, "feedback/missing.md", "a", "b")).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
    expect((await get(db, A, "feedback/style.md"))?.body).toBe("a a a");
  });

  it("links resolve by path or unique file name, and dangle otherwise", async () => {
    const src = await write(
      A,
      "project/plan.md",
      "see [[user/role]], [[probe]], [[later]], [[dup]] and [[user/role.md]]",
    );
    await write(A, "user/role.md");
    await write(A, "project/github/probe.md");
    await write(A, "project/dup.md");
    await write(A, "reference/dup.md");
    // B has the "later" memory: never a target for A
    await write(B, "user/later.md");
    const links = await linksOf(db, A, src.row.id);
    const byPath = Object.fromEntries(links.map((l) => [l.path, l.target?.path ?? null]));
    expect(byPath).toEqual({
      "user/role.md": "user/role.md",
      probe: "project/github/probe.md",
      later: null,
      dup: null,
    });
    // a dangling link becomes live when its target is written
    await write(A, "user/later.md");
    const live = await linksOf(db, A, src.row.id);
    expect(live.find((l) => l.path === "later")?.target?.path).toBe("user/later.md");
  });

  it("put replaces the links; remove drops them", async () => {
    const src = await write(A, "project/plan.md", "[[a]] [[b]]");
    await write(A, "project/plan.md", "[[c]]");
    expect((await linksOf(db, A, src.row.id)).map((l) => l.path)).toEqual(["c"]);
    await edit(db, A, "project/plan.md", "[[c]]", "[[d]] [[e]]");
    expect((await linksOf(db, A, src.row.id)).map((l) => l.path)).toEqual(["d", "e"]);
    await remove(db, A, "project/plan.md");
    expect(
      await db.selectFrom("memory_links").selectAll().where("memory_id", "=", src.row.id).execute(),
    ).toEqual([]);
  });

  it("touch increments recall_count and sets last_recalled_at", async () => {
    const r = await write(A, "user/role.md");
    await touch(db, A, [r.row.id]);
    await touch(db, A, [r.row.id]);
    await touch(db, A, []);
    const got = await get(db, A, "user/role.md");
    expect(got?.recallCount).toBe(2);
    expect(got?.lastRecalledAt).toBeInstanceOf(Date);
  });

  it("purge by member removes their rows with every agent only", async () => {
    for (const o of [A, B, A2, OTHER_ORG]) {
      await write(o, "user/role.md");
      await rememberOwner(db, o, { agentName: "Agent", ownerName: "Member" });
    }
    expect(await purge(db, { orgId: A.orgId, accountId: A.accountId })).toBe(2);
    expect(await get(db, A, "user/role.md")).toBeNull();
    expect(await get(db, A2, "user/role.md")).toBeNull();
    expect(await get(db, B, "user/role.md")).not.toBeNull();
    expect(await get(db, OTHER_ORG, "user/role.md")).not.toBeNull();
    const owners = await db
      .selectFrom("owners")
      .select(["org_id", "agent_id", "account_id"])
      .execute();
    expect(owners).toHaveLength(2);
    expect(owners.some((o) => o.org_id === A.orgId && o.account_id === A.accountId)).toBe(false);
  });

  it("purge by agent and by org; only the org purge drops the admin access log", async () => {
    for (const o of [A, B, A2, OTHER_ORG]) await write(o, "user/role.md");
    const logRow = (orgId: string) => ({
      org_id: orgId,
      admin_account_id: "admin",
      owner_account_id: A.accountId,
      agent_id: A.agentId,
      action: "view",
    });
    await db
      .insertInto("admin_access_log")
      .values([logRow(A.orgId), logRow(OTHER_ORG.orgId)])
      .execute();
    expect(await purge(db, { orgId: A.orgId, agentId: A.agentId })).toBe(2);
    expect(await get(db, A2, "user/role.md")).not.toBeNull();
    expect(await db.selectFrom("admin_access_log").selectAll().execute()).toHaveLength(2);
    expect(await purge(db, { orgId: A.orgId })).toBe(1);
    expect(await get(db, OTHER_ORG, "user/role.md")).not.toBeNull();
    const logs = await db.selectFrom("admin_access_log").select("org_id").execute();
    expect(logs).toEqual([{ org_id: OTHER_ORG.orgId }]);
    expect(await purge(db, { orgId: A.orgId })).toBe(0);
  });

  it("rememberOwner upserts the display names", async () => {
    await rememberOwner(db, A, { agentName: "Helper", ownerName: "Ann" });
    await rememberOwner(db, A, { agentName: "Helper 2", ownerName: "Ann L." });
    const rows = await db.selectFrom("owners").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_name: "Helper 2", owner_name: "Ann L." });
  });
});
