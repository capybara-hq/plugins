import type { DirectoryMember } from "@capybara-hq/plugin-sdk";
import { type FakeSlackServer, startFakeSlack } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSlackDirectory } from "../src/directory.js";

let slack: FakeSlackServer;
let other: FakeSlackServer;

beforeAll(async () => {
  [slack, other] = await Promise.all([
    startFakeSlack({ teamId: "T1" }),
    startFakeSlack({ teamId: "T2" }),
  ]);
  const add = (id: string, extra: Record<string, unknown> = {}) =>
    slack.users.set(id, { id, teamId: "T1", name: id.toLowerCase(), ...extra });
  add("U1", { realName: "Alice", displayName: "Ally", email: "alice@corp.example" });
  add("U2", { realName: "Bob", email: "bob@corp.example" });
  add("U3", { realName: "Carol" });
  add("UBOT2", { realName: "Some bot", isBot: true });
  add("U4", { realName: "Dave", email: "dave@corp.example", deleted: true });
  add("U5", { realName: "Eve" });
  // Ruling A29：访客与 Grid 下其他工作区的人不同步
  add("UGUEST1", { realName: "Guest multi", isRestricted: true });
  add("UGUEST2", { realName: "Guest single", isUltraRestricted: true });
  add("UOTHERWS", { realName: "Other workspace", teamId: "T9" });
});
afterAll(async () => {
  await Promise.all([slack?.stop(), other?.stop()]);
});

const cfg = (s: FakeSlackServer = slack, teamId = "T1") => ({ teamId, botToken: s.botToken });
const dir = (s: FakeSlackServer = slack, o: { maxRateLimitWaitMs?: number } = {}) =>
  createSlackDirectory({ apiUrl: s.apiUrl, pageSize: 2, ...o });
const signal = () => AbortSignal.timeout(15_000);

describe("Slack directory@1", () => {
  it("pages through users.list with the cursor, skipping bots and Slackbot", async () => {
    const before = slack.calls.length;
    const members: DirectoryMember[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await dir().listMembers({
        orgConfig: cfg(),
        ...(cursor !== undefined && { cursor }),
        signal: signal(),
      });
      members.push(...r.members);
      cursor = r.next;
      pages++;
    } while (cursor !== undefined && pages < 20);
    expect(cursor).toBeUndefined();
    expect(pages).toBeGreaterThan(2);
    expect(members).toEqual([
      {
        externalId: "U1",
        tenantId: "T1",
        email: "alice@corp.example",
        emailVerified: false,
        displayName: "Ally",
        active: true,
      },
      {
        externalId: "U2",
        tenantId: "T1",
        email: "bob@corp.example",
        emailVerified: false,
        displayName: "Bob",
        active: true,
      },
      {
        externalId: "U3",
        tenantId: "T1",
        emailVerified: false,
        displayName: "Carol",
        active: true,
      },
      {
        externalId: "U4",
        tenantId: "T1",
        email: "dave@corp.example",
        emailVerified: false,
        displayName: "Dave",
        active: false,
      },
      { externalId: "U5", tenantId: "T1", emailVerified: false, displayName: "Eve", active: true },
    ]);
    const lists = slack.calls.slice(before).filter((c) => c.method === "users.list");
    expect(lists[0]?.body).toMatchObject({ limit: "2", team_id: "T1" });
    expect(lists[0]?.body.cursor).toBeUndefined();
    expect(lists[1]?.body.cursor).toBeTypeOf("string");
    expect(lists.every((c) => c.token === slack.botToken)).toBe(true);
  });

  it("fails when the token belongs to another team than the configured teamId", async () => {
    await expect(
      dir(other).listMembers({ orgConfig: cfg(other, "T1"), signal: signal() }),
    ).rejects.toThrow(/T2.*T1|team/);
    expect(other.calls.some((c) => c.method === "users.list")).toBe(false);
  });

  it("rejects an enterprise (E…) or org-wide install token: the tenant is the workspace team", async () => {
    const grid = await startFakeSlack({ teamId: "E1" });
    try {
      await expect(
        dir(grid).listMembers({ orgConfig: cfg(grid, "T1"), signal: signal() }),
      ).rejects.toThrow(/workspace/);
      expect(grid.calls.some((c) => c.method === "users.list")).toBe(false);
    } finally {
      await grid.stop();
    }
    slack.failNext("auth.test", {
      body: { ok: true, team_id: "T1", user_id: "UBOT", is_enterprise_install: true },
    });
    await expect(dir().listMembers({ orgConfig: cfg(), signal: signal() })).rejects.toThrow(
      /enterprise/,
    );
  });

  it("configured(): true only when teamId and botToken are both set", () => {
    const d = dir();
    expect(d.configured?.(cfg())).toBe(true);
    expect(d.configured?.({})).toBe(false);
    expect(d.configured?.({ teamId: "T1" })).toBe(false);
    expect(d.configured?.({ botToken: "xoxb-1" })).toBe(false);
    expect(d.configured?.(undefined)).toBe(false);
    expect(d.configured?.({ teamId: "E1", botToken: "xoxb-1" })).toBe(false);
  });

  it("fails when the directory is not configured", async () => {
    await expect(dir().listMembers({ orgConfig: {}, signal: signal() })).rejects.toThrow(
      /teamId and botToken/,
    );
  });

  it("maps platform errors to the error code only (no token)", async () => {
    slack.failNext("users.list", { error: "missing_scope" });
    const err = await dir()
      .listMembers({ orgConfig: cfg(), signal: signal() })
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("missing_scope");
    expect((err as Error).message).not.toContain(slack.botToken);
  });

  it("on HTTP 429 waits Retry-After and retries", async () => {
    slack.failNext("users.list", { status: 429, retryAfter: 1 });
    const t0 = Date.now();
    const r = await dir().listMembers({ orgConfig: cfg(), signal: signal() });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    // 第一页：Slackbot（排除）与 U1
    expect(r.members.map((m) => m.externalId)).toEqual(["U1"]);
  });

  it("gives up after a few 429s instead of looping forever", async () => {
    // 第一次 + 3 次重试，全部 429
    slack.failNext("users.list", { status: 429, retryAfter: 0 }, 4);
    const before = slack.calls.filter((c) => c.method === "users.list").length;
    await expect(dir().listMembers({ orgConfig: cfg(), signal: signal() })).rejects.toThrow(
      /rate limited/,
    );
    expect(slack.calls.filter((c) => c.method === "users.list").length - before).toBe(4);
  });

  it("caps the total 429 wait per page (budget), not just each wait", async () => {
    slack.failNext("users.list", { status: 429, retryAfter: 1 }, 2);
    const before = slack.calls.filter((c) => c.method === "users.list").length;
    const t0 = Date.now();
    await expect(
      dir(slack, { maxRateLimitWaitMs: 1500 }).listMembers({ orgConfig: cfg(), signal: signal() }),
    ).rejects.toThrow(/rate limited \(retry after 1s\)/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(slack.calls.filter((c) => c.method === "users.list").length - before).toBe(2);
  });

  it("throws at once when Retry-After is longer than it is willing to wait", async () => {
    slack.failNext("users.list", { status: 429, retryAfter: 120 });
    const t0 = Date.now();
    await expect(
      dir(slack, { maxRateLimitWaitMs: 5000 }).listMembers({ orgConfig: cfg(), signal: signal() }),
    ).rejects.toThrow(/rate limited.*120/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("stops waiting when the signal aborts", async () => {
    slack.failNext("users.list", { status: 429, retryAfter: 5 });
    const ac = new AbortController();
    const t0 = Date.now();
    const p = dir().listMembers({ orgConfig: cfg(), signal: ac.signal });
    setTimeout(() => ac.abort(new Error("stop")), 200);
    await expect(p).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
