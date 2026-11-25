import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_CAP_MESSAGE,
  deviceCapMessage,
  notYourTab,
  tabEvicted,
  tabInUse,
  tabMoved,
} from "../../daemon/actions.js";
import {
  CONVERSATION_IDLE_MS,
  EVICT_MIN_IDLE_MS,
  MAX_TABS,
  MAX_TABS_PER_CONVERSATION,
  NO_CONVERSATION_MESSAGE,
  type ToolReply,
} from "../../daemon/protocol.js";
import {
  conv,
  openViewer,
  ownTabIds,
  rawRequest,
  removeDir,
  request,
  ShiftClock,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
} from "./helpers.js";

const LONG_TITLE = "T".repeat(200);
const POPUPS = `<!doctype html><title>Popups</title><style>body{margin:0}</style>
<a href="/b" target="_blank" rel="noopener"
  style="position:absolute;left:0;top:0;width:200px;height:50px;display:block">link</a>
<button onclick="window.open('/c', '_blank', 'noopener')"
  style="position:absolute;left:0;top:100px;width:200px;height:50px">Open</button>`;

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
let hold: ((res: ServerResponse) => void) | undefined;
/** Resolves with the next /slow response once its request arrived. */
const held = () =>
  new Promise<ServerResponse>((r) => {
    hold = r;
  });
const daemons: TestDaemon[] = [];

beforeAll(async () => {
  fx = await startFixtureServer({
    "/a": "<!doctype html><title>A</title><p>page a</p>",
    "/b": "<!doctype html><title>B</title><p>page b</p>",
    "/c": "<!doctype html><title>C</title><p>page c</p>",
    "/long": `<!doctype html><title>${LONG_TITLE}</title>`,
    "/popups": POPUPS,
    "/slow": (_req, res) => {
      const h = hold;
      hold = undefined;
      h?.(res);
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

async function daemon(clock?: ShiftClock): Promise<TestDaemon> {
  const d = await startTestDaemon(clock === undefined ? {} : { clock });
  daemons.push(d);
  return d;
}

const A = conv("a");
const B = conv("b");

function ok(r: ToolReply): Extract<ToolReply, { ok: true }> {
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r;
}

async function ownTabs(d: TestDaemon, of = A): Promise<string[]> {
  return ownTabIds(ok(await request(d.socketPath, { op: "tabs", action: "list" }, of)).text);
}

describe("requests name their conversation", () => {
  it("a request without the conversation fields is refused", async () => {
    const d = await daemon();
    for (const body of [
      { op: "snapshot" },
      { op: "snapshot", conversationId: "a" },
      { op: "snapshot", conversationId: "", rootConversationId: "a" },
    ]) {
      const r = await rawRequest(d.socketPath, body);
      expect(r).toEqual({
        ok: false,
        error: "failed",
        message: NO_CONVERSATION_MESSAGE,
        blockedHosts: [],
      });
    }
  });

  it("every reply carries the conversation's own tab count, ok or not", async () => {
    const d = await daemon();
    const nav = await request(d.socketPath, { op: "navigate", url: `${fx.url}/a` }, A);
    expect(nav).toMatchObject({ ok: true, tabs: { open: 1, max: MAX_TABS_PER_CONVERSATION } });
    const refused = await request(d.socketPath, { op: "tabs", action: "switch", tabId: "t99" }, B);
    expect(refused).toMatchObject({ ok: false, tabs: { open: 0, max: MAX_TABS_PER_CONVERSATION } });
  });
});

describe("tabs owned per conversation", () => {
  it("the first acting call claims the blank tab, another conversation's gets a new one", async () => {
    const d = await daemon();
    const a = ok(await request(d.socketPath, { op: "snapshot" }, A));
    expect(a.page?.tabId).toBe("t1");
    const b = ok(await request(d.socketPath, { op: "snapshot" }, B));
    expect(b.page?.tabId).toBe("t2");
    expect(await ownTabs(d, A)).toEqual(["t1"]);
    expect(await ownTabs(d, B)).toEqual(["t2"]);
  });

  it("two conversations navigate at once; each reply reports its own page", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "snapshot" }, A);
    const arrived = held();
    const slow = request(d.socketPath, { op: "navigate", url: `${fx.url}/slow` }, A);
    const res = await arrived;
    // B is not queued behind A's navigation
    const b = ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/b` }, B));
    expect(b.page).toMatchObject({ url: `${fx.url}/b`, title: "B" });
    res.writeHead(200, { "content-type": "text/html" }).end("<title>Slow</title>");
    expect(ok(await slow).page).toMatchObject({ url: `${fx.url}/slow`, title: "Slow" });
    expect(ok(await request(d.socketPath, { op: "snapshot" }, A)).page?.title).toBe("Slow");
    expect(ok(await request(d.socketPath, { op: "snapshot" }, B)).text).toContain("page b");
  });

  it("non-acting requests open no tab", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/a` }, A);
    for (const r of [
      await request(d.socketPath, { op: "tabs", action: "list" }, B),
      await request(d.socketPath, { op: "handoff_notice", callId: "h", message: "x" }, B),
      await request(d.socketPath, { op: "handoff_clear", callId: "h" }, B),
    ]) {
      expect(r).toMatchObject({ ok: true, tabs: { open: 0 } });
      expect(ok(r).page).toBeUndefined();
    }
    expect(await ownTabs(d, A)).toEqual(["t1"]);
  });

  it("lists own tabs, the task's other tabs and the device's, clipped outside its own", async () => {
    const d = await daemon();
    const root = conv("root");
    const sub = conv("sub", "root");
    const other = conv("other");
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/a` }, root);
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/long?secret=1#frag` }, sub);
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/b?q=2` }, other);
    const list = ok(await request(d.socketPath, { op: "tabs", action: "list" }, root)).text ?? "";
    expect(list.split("\n")).toEqual([
      `t1 (active): A ${fx.url}/a`,
      "Tabs of other conversations in this task:",
      `t2: ${"T".repeat(119)}… ${fx.url}/long`,
      "Tabs of other conversations on this device:",
      `t3: B ${fx.url}/b`,
      "To use another conversation's tab, call browser_tabs with action adopt and its tabId.",
    ]);
    expect(list).not.toContain("root");
    expect(list).not.toContain("secret");
  });

  it("switch and close of another conversation's tab are refused", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/a` }, A);
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/b` }, B);
    for (const action of ["switch", "close"] as const) {
      expect(await request(d.socketPath, { op: "tabs", action, tabId: "t1" }, B)).toMatchObject({
        ok: false,
        error: "failed",
        message: notYourTab("t1"),
      });
    }
    expect(await ownTabs(d, A)).toEqual(["t1"]);
  });

  it("popups from a noopener link and window.open belong to the opener's owner", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/popups` }, A);
    await request(d.socketPath, { op: "snapshot" }, B);
    // B has a request in flight while A's page opens its popups (a navigation held open)
    const arrived = held();
    const bWaits = request(d.socketPath, { op: "navigate", url: `${fx.url}/slow` }, B);
    const res = await arrived;
    ok(await request(d.socketPath, { op: "click_at", x: 10, y: 10 }, A));
    await vi.waitFor(async () => expect(await ownTabs(d, A)).toHaveLength(2));
    // the popup is A's active tab now: go back to the opener for the button
    ok(await request(d.socketPath, { op: "tabs", action: "switch", tabId: "t1" }, A));
    ok(await request(d.socketPath, { op: "click_at", x: 10, y: 110 }, A));
    await vi.waitFor(async () => expect(await ownTabs(d, A)).toHaveLength(3));
    expect(await ownTabs(d, B)).toEqual(["t2"]);
    const a = ok(await request(d.socketPath, { op: "snapshot" }, A));
    expect(a.page?.url).toBe(`${fx.url}/c`);
    expect(d.daemon.state.busy("b")).toBe(true);
    res.writeHead(200, { "content-type": "text/html" }).end("<title>Slow</title>");
    expect(ok(await bWaits).page?.tabId).toBe("t2");
  });
});

describe("adopt", () => {
  it("moves the tab, makes it active and tells the previous owner", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/a` }, A);
    const r = ok(await request(d.socketPath, { op: "tabs", action: "adopt", tabId: "t1" }, B));
    expect(r.page).toMatchObject({ tabId: "t1", url: `${fx.url}/a` });
    expect(r.tabs).toEqual({ open: 1, max: MAX_TABS_PER_CONVERSATION });
    const a = ok(await request(d.socketPath, { op: "tabs", action: "list" }, A));
    expect(a.text).toContain(tabMoved("t1", "A"));
    expect(a.page).toBeUndefined();
    // the note is told once
    expect(ok(await request(d.socketPath, { op: "tabs", action: "list" }, A)).text).not.toContain(
      "moved",
    );
  });

  it("is refused while the owner has a request running or queued", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/a` }, A);
    const arrived = held();
    const slow = request(d.socketPath, { op: "navigate", url: `${fx.url}/slow` }, A);
    const res = await arrived;
    const queued = request(d.socketPath, { op: "press", key: "Tab" }, A);
    expect(
      await request(d.socketPath, { op: "tabs", action: "adopt", tabId: "t1" }, B),
    ).toMatchObject({ ok: false, error: "failed", message: tabInUse("t1") });
    res.writeHead(200, { "content-type": "text/html" }).end("<title>Slow</title>");
    await slow;
    await queued;
    expect((await request(d.socketPath, { op: "tabs", action: "adopt", tabId: "t1" }, B)).ok).toBe(
      true,
    );
  });

  it("is refused while the owner runs wait, and while it has a park", async () => {
    const clock = new ShiftClock();
    const d = await daemon(clock);
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/a` }, A);
    const waiting = request(d.socketPath, { op: "wait", timeoutMs: 60_000 }, A);
    await vi.waitFor(() => expect(d.daemon.state.busy("a")).toBe(true));
    expect(
      await request(d.socketPath, { op: "tabs", action: "adopt", tabId: "t1" }, B),
    ).toMatchObject({ ok: false, message: tabInUse("t1") });
    clock.advance(60_000);
    expect((await waiting).ok).toBe(true);
    d.daemon.state.park("a", "a", { kind: "long_wait", key: "w1" });
    expect(
      await request(d.socketPath, { op: "tabs", action: "adopt", tabId: "t1" }, B),
    ).toMatchObject({ ok: false, message: tabInUse("t1") });
    // a park that pins another tab does not hold this one
    d.daemon.state.unpark("a", "long_wait", "w1");
    d.daemon.state.park("a", "a", { kind: "dialog", key: "d1", tabId: "t9" });
    expect((await request(d.socketPath, { op: "tabs", action: "adopt", tabId: "t1" }, B)).ok).toBe(
      true,
    );
  });
});

describe("caps and eviction", () => {
  /** Opens tabs for a conversation until it owns `n`. */
  async function fill(d: TestDaemon, of: typeof A, n: number): Promise<void> {
    while ((await ownTabs(d, of)).length < n)
      ok(await request(d.socketPath, { op: "tabs", action: "open" }, of));
  }

  it("refuses past the conversation's cap and, with nothing evictable, past the device's", async () => {
    const d = await daemon(new ShiftClock());
    await fill(d, A, MAX_TABS_PER_CONVERSATION);
    expect(await request(d.socketPath, { op: "tabs", action: "open" }, A)).toMatchObject({
      ok: false,
      message: CONVERSATION_CAP_MESSAGE,
      tabs: { open: MAX_TABS_PER_CONVERSATION },
    });
    await fill(d, B, MAX_TABS - MAX_TABS_PER_CONVERSATION);
    // A made a request a moment ago: it is never evicted
    expect(await request(d.socketPath, { op: "tabs", action: "open" }, B)).toMatchObject({
      ok: false,
      message: deviceCapMessage(MAX_TABS - MAX_TABS_PER_CONVERSATION),
    });
    expect(await request(d.socketPath, { op: "snapshot" }, conv("c"))).toMatchObject({
      ok: false,
      message: deviceCapMessage(0),
    });
    expect(deviceCapMessage(0)).toBe(
      "Other conversations hold all 10 tabs of the browser; retry later or ask the user to close one in the browser panel.",
    );
  });

  it("evicts the least recently active idle owner, non-active tabs first, and tells it", async () => {
    const clock = new ShiftClock();
    const d = await daemon(clock);
    await fill(d, A, MAX_TABS_PER_CONVERSATION);
    const aActive = ok(await request(d.socketPath, { op: "snapshot" }, A)).page?.tabId;
    let before = new Set(await ownTabs(d, A));
    await fill(d, B, MAX_TABS - MAX_TABS_PER_CONVERSATION);
    clock.advance(EVICT_MIN_IDLE_MS);
    // B made a request a moment ago: only A qualifies
    await request(d.socketPath, { op: "tabs", action: "list" }, B);
    const C = conv("c");
    const closed: string[] = [];
    for (let i = 0; i < MAX_TABS_PER_CONVERSATION; i++) {
      ok(await request(d.socketPath, { op: "tabs", action: "open" }, C));
      // what A had and no longer has (the list is A's request, so A's notes ride it)
      const list = ok(await request(d.socketPath, { op: "tabs", action: "list" }, A));
      const after = new Set(ownTabIds(list.text));
      const gone = [...before].filter((id) => !after.has(id));
      expect(gone).toHaveLength(1);
      closed.push(gone[0] as string);
      before = after;
      expect(list.text).toContain(tabEvicted(gone[0] as string, "no title"));
      // A's list made it active again: let it idle once more
      clock.advance(EVICT_MIN_IDLE_MS);
      await request(d.socketPath, { op: "tabs", action: "list" }, B);
    }
    // A's active tab went last; B kept all of its tabs
    expect(closed.at(-1)).toBe(aActive);
    expect(await ownTabs(d, B)).toHaveLength(MAX_TABS - MAX_TABS_PER_CONVERSATION);
  });
});

describe("popups at the device cap", () => {
  /** A owns five tabs with the popups page active, B five tabs: the device is full. */
  async function full(clock: ShiftClock): Promise<TestDaemon> {
    const d = await daemon(clock);
    while ((await ownTabs(d, A)).length < 5)
      ok(await request(d.socketPath, { op: "tabs", action: "open" }, A));
    ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/popups` }, A));
    while ((await ownTabs(d, B)).length < 5)
      ok(await request(d.socketPath, { op: "tabs", action: "open" }, B));
    return d;
  }

  it("closes the popup with a note when no tab can be evicted", async () => {
    const d = await full(new ShiftClock());
    const r = ok(await request(d.socketPath, { op: "click_at", x: 10, y: 10 }, A));
    let notes = r.text ?? "";
    await vi.waitFor(async () => {
      notes += ok(await request(d.socketPath, { op: "tabs", action: "list" }, A)).text ?? "";
      expect(notes).toContain(
        `the browser keeps at most ${MAX_TABS} tabs, so the popup was closed`,
      );
    });
    expect(await ownTabs(d, A)).toHaveLength(5);
    expect(await ownTabs(d, B)).toHaveLength(5);
  });

  it("evicts an idle owner's tab to keep the popup", async () => {
    const clock = new ShiftClock();
    const d = await full(clock);
    clock.advance(EVICT_MIN_IDLE_MS);
    ok(await request(d.socketPath, { op: "click_at", x: 10, y: 10 }, A));
    await vi.waitFor(async () => expect(await ownTabs(d, A)).toHaveLength(6));
    const b = ok(await request(d.socketPath, { op: "tabs", action: "list" }, B));
    expect(ownTabIds(b.text)).toHaveLength(4);
    expect(b.text).toContain("was closed to make room for another conversation.");
  });
});

describe("handoffs per conversation", () => {
  it("a request drops only its own conversation's pending handoff", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "handoff_notice", callId: "h1", message: "Sign in" }, A);
    await request(d.socketPath, { op: "snapshot" }, B);
    expect(d.daemon.state.handoffOf("a")?.callId).toBe("h1");
    await request(d.socketPath, { op: "snapshot" }, A);
    expect(d.daemon.state.handoffOf("a")).toBeUndefined();
  });
});

describe("the hand back note", () => {
  it("goes only to the conversations that owned a tab when the takeover began", async () => {
    const d = await daemon();
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/a` }, A);
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 }, A);
    await v.next((m) => m.t === "state");
    const taken = v.after((m) => m.t === "state" && m.control === "user");
    v.send({ t: "takeover" });
    await taken;
    const back = v.after((m) => m.t === "state" && m.control === "agent");
    v.send({ t: "handback" });
    await back;
    // B had no tab then: telling it would be false
    const b = ok(await request(d.socketPath, { op: "snapshot" }, B));
    expect(b.userControlledSince).toBeUndefined();
    const a = ok(await request(d.socketPath, { op: "snapshot" }, A));
    expect(typeof a.userControlledSince).toBe("string");
    await v.close();
  });
});

describe("idle close", () => {
  it("closes a silent conversation's tabs; a viewer, a handoff or a park keeps them", async () => {
    const clock = new ShiftClock();
    const d = await daemon(clock);
    const [X, V, H, P] = ["x", "v", "h", "p"].map((id) => conv(id));
    for (const c of [X, V, H, P])
      ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/a` }, c));
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 }, V);
    await v.next((m) => m.t === "state");
    await request(d.socketPath, { op: "handoff_notice", callId: "h1", message: "Sign in" }, H);
    d.daemon.state.park("p", "p", { kind: "long_wait", key: "w1" });
    clock.advance(CONVERSATION_IDLE_MS);
    expect(d.daemon.state.conversationIds.sort()).toEqual(["h", "p", "v"]);
    // the list is a new request of x: it finds nothing of x's left (the closes are under way)
    await vi.waitFor(async () => expect(await ownTabs(d, X)).toEqual([]));
    for (const c of [V, H, P]) expect(await ownTabs(d, c)).toHaveLength(1);
    await v.close();
    await request(d.socketPath, { op: "handoff_clear", callId: "h1" }, H);
    d.daemon.state.unpark("p", "long_wait", "w1");
    clock.advance(CONVERSATION_IDLE_MS);
    // every conversation's state is gone with its tabs
    expect(d.daemon.state.conversationIds).toEqual([]);
    await vi.waitFor(async () => {
      const r = ok(await request(d.socketPath, { op: "tabs", action: "list" }, conv("z")));
      expect(r.text).toBe("No browser tabs are open.");
    });
  });

  it("a request arriving while the idle close runs gets a new tab, not a closing one", async () => {
    const clock = new ShiftClock();
    const d = await daemon(clock);
    ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/a` }, A));
    ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/b` }, B));
    clock.advance(CONVERSATION_IDLE_MS);
    // sent in the same tick as the idle close, before its tabs finished closing
    const [nav, adopt] = await Promise.all([
      request(d.socketPath, { op: "navigate", url: `${fx.url}/c` }, A),
      request(d.socketPath, { op: "tabs", action: "adopt", tabId: "t2" }, conv("z")),
    ]);
    expect(ok(nav).page).toMatchObject({ url: `${fx.url}/c` });
    expect(ok(nav).page?.tabId).not.toBe("t1");
    expect(adopt).toMatchObject({ ok: false, message: expect.stringMatching(/^No tab "t2"/) });
  });

  it("closes a finished sub-agent's tab while the root's panel stays open", async () => {
    const clock = new ShiftClock();
    const d = await daemon(clock);
    const root = conv("root");
    const sub = conv("sub", "root");
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/a` }, root);
    await request(d.socketPath, { op: "navigate", url: `${fx.url}/b` }, sub);
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 }, root);
    await v.next((m) => m.t === "state" && m.tabs.length === 2 && m.shown === "t1");
    const gone = v.after((m) => m.t === "state" && m.tabs.length === 1);
    clock.advance(CONVERSATION_IDLE_MS);
    expect(await gone).toMatchObject({ tabs: [{ id: "t1", group: "own" }], shown: "t1" });
    expect(d.daemon.state.conversationIds).toEqual(["root"]);
    await v.close();
  });
});
