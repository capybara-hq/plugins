import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeConversationDeleted } from "@capybara-hq/plugin-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolReply } from "../../daemon/protocol.js";
import {
  conv,
  openViewer,
  ownTabIds,
  rawRequest,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
} from "./helpers.js";

/**
 * The kernel's conversation-deleted notice (SDK `encodeConversationDeleted`, close tabs on delete
 * design §5): the daemon closes the tabs of the conversation and of its tree, forgets their
 * state, keeps the session file from restoring them, answers how many tabs it closed, and never
 * touches the profile.
 */

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
const daemons: TestDaemon[] = [];

beforeAll(async () => {
  fx = await startFixtureServer({
    "/a": "<!doctype html><title>A</title><p>page a</p>",
    "/set": (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "kept=v1; Max-Age=3600; Path=/",
      });
      res.end("<!doctype html><title>Set</title><p>set</p>");
    },
    "/get": (req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Get</title><p>cookie: ${req.headers.cookie ?? "none"}</p>`);
    },
  });
});

afterAll(async () => {
  await fx?.close();
});

afterEach(async () => {
  for (const d of daemons.splice(0)) {
    await d.stop();
    removeDir(d.stateDir);
  }
});

async function daemon(stateDir?: string): Promise<TestDaemon> {
  const d = await startTestDaemon(stateDir === undefined ? {} : { stateDir });
  daemons.push(d);
  return d;
}

function ok(r: ToolReply): Extract<ToolReply, { ok: true }> {
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r;
}

/** The kernel's notice for `id`, as its request body. */
const notice = (d: TestDaemon, id: string) =>
  rawRequest(d.socketPath, JSON.parse(new TextDecoder().decode(encodeConversationDeleted(id))));

const R = conv("r");
const S = conv("s", "r");
const X = conv("x");

const listText = async (d: TestDaemon, of = X) =>
  ok(await request(d.socketPath, { op: "tabs", action: "list" }, of)).text ?? "";

describe("conversation-deleted notice", () => {
  it("closes the tree's tabs and only those, forgets their state and keeps the profile", async () => {
    const d = await daemon();
    ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/set` }, R));
    ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/a` }, S));
    ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/a` }, X));
    await request(d.socketPath, { op: "handoff_notice", callId: "h1", message: "Sign in" }, S);
    d.daemon.state.park("s", "r", { kind: "long_wait", key: "w1" });
    expect(d.daemon.state.conversationIds.sort()).toEqual(["r", "s", "x"]);

    expect(await notice(d, "r")).toEqual({ ok: true, closed: 2 });
    expect(d.daemon.state.conversationIds).toEqual(["x"]);
    expect(d.daemon.state.handoffs()).toEqual([]);
    // x keeps its own tab; the tree's tabs are gone from every list
    await vi.waitFor(async () => {
      const text = await listText(d);
      expect(ownTabIds(text)).toHaveLength(1);
      expect(text).not.toContain("Tabs of other conversations");
    });
    // a repeat closes nothing
    expect(await notice(d, "r")).toEqual({ ok: true, closed: 0 });
    // the profile is untouched: the cookie set in r's page is still sent
    ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/get` }, X));
    const snap = ok(await request(d.socketPath, { op: "snapshot" }, X));
    expect(snap.text ?? "").toContain("cookie: kept=v1");
  });

  it("closes them during a takeover of another conversation's panel", async () => {
    const d = await daemon();
    ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/a` }, R));
    ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/a` }, X));
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 }, X);
    await v.next((m) => m.t === "state");
    const taken = v.after((m) => m.t === "state" && m.control === "user");
    v.send({ t: "takeover" });
    await taken;
    expect(await notice(d, "r")).toEqual({ ok: true, closed: 1 });
    expect(d.daemon.state.control).toBe("user");
    await v.close();
  });

  it("closes restored tabs after a restart and keeps the session file from restoring them", async () => {
    const first = await daemon();
    ok(await request(first.socketPath, { op: "navigate", url: `${fx.url}/a` }, R));
    ok(await request(first.socketPath, { op: "navigate", url: `${fx.url}/a` }, X));
    // the session file is written soon after the navigations
    const file = join(first.stateDir, "session.json");
    await vi.waitFor(() => expect(JSON.parse(readFileSync(file, "utf8")).tabs).toHaveLength(2));
    // a restart (not an idle stop) keeps the file: the next daemon restores r's and x's tabs
    daemons.splice(daemons.indexOf(first), 1);
    await first.stop();
    const second = await daemon(first.stateDir);
    expect(await notice(second, "r")).toEqual({ ok: true, closed: 1 });
    await vi.waitFor(() =>
      expect(
        JSON.parse(readFileSync(file, "utf8")).tabs.map((t: { owner: string }) => t.owner),
      ).toEqual(["x"]),
    );
    const text = await listText(second);
    expect(ownTabIds(text)).toHaveLength(1);
    expect(text).not.toContain("Tabs of other conversations");
  });
});
