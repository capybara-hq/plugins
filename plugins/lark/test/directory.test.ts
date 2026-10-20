import type { DirectoryMember } from "@capybara-hq/plugin-sdk";
import { type FakeLarkServer, type FakeLarkUser, startFakeLark } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLarkDirectory } from "../src/directory.js";

const LOGIN_APP = { appId: "cli_0000000000000001", appSecret: "login-app-secret-3c4d" };

let lark: FakeLarkServer;
let other: FakeLarkServer;

beforeAll(async () => {
  [lark, other] = await Promise.all([
    startFakeLark({ tenantKey: "t1", appSecret: "dir-secret-5e6f", extraApps: [LOGIN_APP] }),
    startFakeLark({ tenantKey: "t2", appSecret: "dir-secret-5e6f" }),
  ]);
  lark.departments.push(
    { openDepartmentId: "od-eng", name: "Engineering", parent: "0" },
    { openDepartmentId: "od-web", name: "Web", parent: "od-eng" },
    { openDepartmentId: "od-ops", name: "Ops", parent: "0" },
  );
  const add = (openId: string, departments: string[], extra: Partial<FakeLarkUser> = {}) =>
    lark.users.set(openId, { openId, name: openId.slice(3), departments, ...extra });
  add("ou_a", ["0"], { name: "Alice", email: "alice@corp.example" });
  add("ou_b", ["0"], { name: "", enName: "Bob", enterpriseEmail: "bob@mail.corp.example" });
  add("ou_c", ["0"], { name: "Carol", status: { isResigned: true, isActivated: true } });
  add("ou_d", ["od-eng"], { name: "Dave", status: { isFrozen: true } });
  add("ou_e", ["od-eng", "od-ops"], { name: "Eve" });
  add("ou_f", ["od-web"], { name: "Pending", status: { isActivated: false } });
  add("ou_g", ["od-web"], { name: "Unjoined", status: { isUnjoin: true } });
  add("ou_h", ["od-ops"], { name: "Hank", status: { isExited: true } });
  add("ou_i", ["od-web"], { name: "Ivy" });
});
afterAll(async () => {
  await Promise.all([lark?.stop(), other?.stop()]);
});

const cfg = (s: FakeLarkServer = lark) => ({ appId: s.appId, appSecret: s.appSecret });
const dir = (
  s: FakeLarkServer = lark,
  o: { maxRateLimitWaitMs?: number; loginApp?: { appId: string; appSecret: string } } = {},
) => createLarkDirectory({ apiUrl: s.url, pageSize: 2, ...o });
const signal = () => AbortSignal.timeout(15_000);

async function listAll(d = dir(), orgConfig: unknown = cfg()) {
  const members: DirectoryMember[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const r = await d.listMembers({
      orgConfig,
      ...(cursor !== undefined && { cursor }),
      signal: signal(),
    });
    members.push(...r.members);
    cursor = r.next;
    if (cursor !== undefined) cursors.push(cursor);
    pages++;
  } while (cursor !== undefined && pages < 50);
  return { members, cursors, pages, last: cursor };
}

describe("Lark directory@1", () => {
  it("walks the root and every department (recursive), paging users; maps status", async () => {
    const { members, pages, last, cursors } = await listAll();
    expect(last).toBeUndefined();
    expect(pages).toBeGreaterThan(3);
    expect(new Set(cursors).size).toBe(cursors.length);
    const byId = new Map(members.map((m) => [m.externalId, m]));
    expect([...byId.keys()].sort()).toEqual([
      "ou_a",
      "ou_b",
      "ou_c",
      "ou_d",
      "ou_e",
      "ou_h",
      "ou_i",
    ]);
    expect(byId.get("ou_a")).toEqual({
      externalId: "ou_a",
      tenantId: "t1",
      email: "alice@corp.example",
      emailVerified: false,
      displayName: "Alice",
      active: true,
    });
    expect(byId.get("ou_b")).toEqual({
      externalId: "ou_b",
      tenantId: "t1",
      email: "bob@mail.corp.example",
      emailVerified: false,
      displayName: "Bob",
      active: true,
    });
    // 离职 / 冻结 / 主动退出 → active false；未激活 / 未加入不同步
    expect(byId.get("ou_c")?.active).toBe(false);
    expect(byId.get("ou_d")?.active).toBe(false);
    expect(byId.get("ou_h")?.active).toBe(false);
    expect(byId.get("ou_e")?.active).toBe(true);
    expect(byId.get("ou_i")?.active).toBe(true);
    // 机器人 / 应用不是通讯录用户：机器人 open_id 从不出现
    expect(byId.has(lark.botOpenId)).toBe(false);
    for (const m of members) {
      expect(m.tenantId).toBe("t1");
      expect(m.emailVerified).toBe(false);
    }
    // 同一页内不重复
    const users = lark.calls.filter((c) => c.api === "find_by_department");
    expect(users.every((c) => c.query.user_id_type === "open_id")).toBe(true);
    expect(users.every((c) => c.query.department_id_type === "open_department_id")).toBe(true);
    expect(users.some((c) => c.query.department_id === "0")).toBe(true);
    const depts = lark.calls.filter((c) => c.api === "departments");
    expect(depts.every((c) => c.query.fetch_child === "true")).toBe(true);
  });

  it("configured(): true only with both appId and appSecret", () => {
    const d = dir();
    expect(d.configured?.(cfg())).toBe(true);
    expect(d.configured?.({})).toBe(false);
    expect(d.configured?.(undefined)).toBe(false);
    expect(d.configured?.({ appId: lark.appId })).toBe(false);
    expect(d.configured?.({ appSecret: "s" })).toBe(false);
    expect(d.configured?.({ appId: "not-an-app-id", appSecret: "s" })).toBe(false);
  });

  it("unconfigured → throws (never an empty list)", async () => {
    await expect(dir().listMembers({ orgConfig: {}, signal: signal() })).rejects.toThrow(
      /not configured/,
    );
  });

  it("a cursor from another tenant is rejected", async () => {
    const first = await dir().listMembers({ orgConfig: cfg(), signal: signal() });
    expect(first.next).toBeDefined();
    await expect(
      dir(other).listMembers({
        orgConfig: cfg(other),
        cursor: first.next as string,
        signal: signal(),
      }),
    ).rejects.toThrow(/tenant/);
    await expect(
      dir().listMembers({ orgConfig: cfg(), cursor: "garbage!", signal: signal() }),
    ).rejects.toThrow(/cursor/);
  });

  it("department list changed mid-sync → throws (no silent skip)", async () => {
    // 走到某个部门里（di ≥ 0）的游标
    const { cursors } = await listAll();
    const inDept = cursors.find((c) => JSON.parse(Buffer.from(c, "base64url").toString()).di >= 0);
    expect(inDept).toBeDefined();
    lark.departments.unshift({ openDepartmentId: "od-new", name: "New", parent: "0" });
    try {
      await expect(
        dir().listMembers({ orgConfig: cfg(), cursor: inDept as string, signal: signal() }),
      ).rejects.toThrow(/changed/);
    } finally {
      lark.departments.shift();
    }
  });

  it("users without status (scope missing) → throws instead of treating everyone as active", async () => {
    lark.hideUserStatus(true);
    try {
      await expect(dir().listMembers({ orgConfig: cfg(), signal: signal() })).rejects.toThrow(
        /status/,
      );
    } finally {
      lark.hideUserStatus(false);
    }
  });

  it("platform errors carry the code, never the secret", async () => {
    const err = await dir()
      .listMembers({
        orgConfig: { appId: lark.appId, appSecret: "wrong-dir-secret" },
        signal: signal(),
      })
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/code 10015/);
    expect((err as Error).message).not.toContain("wrong-dir-secret");
    lark.failNext("departments", { status: 400, code: 40004, msg: "no dept authority" });
    const first = await dir().listMembers({ orgConfig: cfg(), signal: signal() });
    // 根部门的第一页不查部门；之后某页查部门时报错
    let cursor = first.next;
    let e2: Error | undefined;
    for (let i = 0; i < 10 && cursor !== undefined && !e2; i++) {
      try {
        cursor = (await dir().listMembers({ orgConfig: cfg(), cursor, signal: signal() })).next;
      } catch (e) {
        e2 = e as Error;
      }
    }
    expect(e2?.message).toMatch(/code 40004/);
  });

  it("429 → waits x-ogw-ratelimit-reset and retries", async () => {
    lark.failNext("find_by_department", { status: 429, code: 99991400, retryAfter: 1 });
    const started = Date.now();
    const r = await dir().listMembers({ orgConfig: cfg(), signal: signal() });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(r.members.length).toBeGreaterThan(0);
  });

  it("429 beyond the wait budget → throws 'rate limited' after a bounded number of calls", async () => {
    const before = lark.calls.filter((c) => c.api === "find_by_department").length;
    lark.failNext("find_by_department", { status: 429, code: 99991400, retryAfter: 1 }, 5);
    try {
      await expect(
        dir(lark, { maxRateLimitWaitMs: 1500 }).listMembers({ orgConfig: cfg(), signal: signal() }),
      ).rejects.toThrow(/rate limited/);
      const after = lark.calls.filter((c) => c.api === "find_by_department").length;
      expect(after - before).toBe(2);
    } finally {
      // 清掉剩余的失败
      for (let i = 0; i < 3; i++) {
        await dir(lark, { maxRateLimitWaitMs: 0 })
          .listMembers({ orgConfig: cfg(), signal: signal() })
          .catch(() => {});
      }
    }
  });

  it("abort during a rate-limit wait rejects promptly", async () => {
    lark.failNext("find_by_department", { status: 429, code: 99991400, retryAfter: 10 });
    const ac = new AbortController();
    const started = Date.now();
    const p = dir().listMembers({ orgConfig: cfg(), signal: ac.signal });
    setTimeout(() => ac.abort(new Error("stop")), 200);
    await expect(p).rejects.toThrow(/stop/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("a different app than the deployment login app in the same tenant → throws", async () => {
    await expect(
      dir(lark, { loginApp: LOGIN_APP }).listMembers({ orgConfig: cfg(), signal: signal() }),
    ).rejects.toThrow(/same Lark app/);
    // 登录应用就是这个应用：照常
    const ok = await dir(lark, { loginApp: cfg() }).listMembers({
      orgConfig: cfg(),
      signal: signal(),
    });
    expect(ok.members.length).toBeGreaterThan(0);
    // 登录应用属于别的租户（凭据在这里取不到 token）：不影响本租户的通讯录
    const ok2 = await dir(other, { loginApp: LOGIN_APP }).listMembers({
      orgConfig: cfg(other),
      signal: signal(),
    });
    expect(ok2.next).toBeUndefined();
  });

  it("visited department swapped with an unvisited one mid-sync → last page throws (digest)", async () => {
    const flat = await startFakeLark({ tenantKey: "t1" });
    try {
      flat.departments.push(
        { openDepartmentId: "od-1", name: "One", parent: "0" },
        { openDepartmentId: "od-2", name: "Two", parent: "0" },
        { openDepartmentId: "od-3", name: "Three", parent: "0" },
      );
      for (const [id, d] of [
        ["ou_1", "od-1"],
        ["ou_2", "od-2"],
        ["ou_3", "od-3"],
      ] as const) {
        flat.users.set(id, { openId: id, name: id, departments: [d] });
      }
      const d = dir(flat);
      const page = (cursor?: string) =>
        d.listMembers({
          orgConfig: cfg(flat),
          ...(cursor !== undefined && { cursor }),
          signal: signal(),
        });
      const root = await page(); // 根部门（没有直属成员）
      const p1 = await page(root.next); // od-1（已访问）
      expect(p1.members.map((m) => m.externalId)).toEqual(["ou_1"]);
      // od-1（已访问）与 od-3（未访问）对调；od-2 仍在原位，逐页的部门 id 核对发现不了
      const [a, , c] = flat.departments;
      flat.departments.splice(0, 3, c as never, flat.departments[1] as never, a as never);
      const p2 = await page(p1.next); // od-2
      expect(p2.members.map((m) => m.externalId)).toEqual(["ou_2"]);
      // 下一个是下标 2 —— 现在是 od-1（又一次），od-3 被跳过；最后一页重列部门、摘要不符 → 抛错
      await expect(page(p2.next)).rejects.toThrow(/changed/);
    } finally {
      await flat.stop();
    }
  });

  it("app contact scope is not 'all members' (root department rejected) → page 1 throws", async () => {
    lark.rejectRootDepartment(true);
    try {
      await expect(dir().listMembers({ orgConfig: cfg(), signal: signal() })).rejects.toThrow(
        /code 40004.*all members|all members.*code 40004/,
      );
    } finally {
      lark.rejectRootDepartment(false);
    }
  });

  it("tenant query goes through the same rate-limit backoff", async () => {
    lark.failNext("tenant", { status: 429, code: 99991400, retryAfter: 1 });
    const started = Date.now();
    const r = await dir().listMembers({ orgConfig: cfg(), signal: signal() });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(r.members.length).toBeGreaterThan(0);
  });

  it("login-app tenant check: transient failure fails closed; only auth errors fail open", async () => {
    // 第 1 次企业信息查询（本应用）正常，第 2 次（登录应用）503 → 抛错，不放行
    lark.failNext("tenant", { status: 503, code: 5000 }, 1, 1);
    await expect(
      dir(lark, { loginApp: LOGIN_APP }).listMembers({ orgConfig: cfg(), signal: signal() }),
    ).rejects.toThrow(/code 5000/);
    // 登录应用凭据错误（10015）→ 放行
    const ok = await dir(lark, {
      loginApp: { appId: LOGIN_APP.appId, appSecret: "wrong" },
    }).listMembers({ orgConfig: cfg(), signal: signal() });
    expect(ok.members.length).toBeGreaterThan(0);
  });
});
