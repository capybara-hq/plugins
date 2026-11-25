import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_TABS_PER_CONVERSATION,
  type ToolReply,
  type ViewerOut,
} from "../../daemon/protocol.js";
import {
  conv,
  openViewer,
  ownTabIds,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
  type TestViewer,
  type ViewerMsg,
} from "./helpers.js";

type State = Extract<ViewerOut, { t: "state" }>;
const isState = (m: ViewerMsg): m is State => m.t === "state";

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
const daemons: TestDaemon[] = [];
const viewers: TestViewer[] = [];

beforeAll(async () => {
  fx = await startFixtureServer({
    "/r": "<!doctype html><title>R</title>",
    "/s1": "<!doctype html><title>S1</title>",
    "/s2": "<!doctype html><title>S2</title>",
    "/o": "<!doctype html><title>O</title>",
    "/clicks": `<!doctype html><title>Clicks</title><style>body{margin:0}</style>
<button style="width:300px;height:100px" onclick="location.hash='clicked'">Press</button>`,
  });
});

afterAll(async () => {
  await fx?.close();
});

afterEach(async () => {
  for (const v of viewers.splice(0)) await v.close();
  for (const d of daemons.splice(0)) {
    await d.stop();
    removeDir(d.stateDir);
  }
});

const ROOT = conv("root");
const SUB = conv("sub", "root");
const OTHER = conv("other");

function ok(r: ToolReply): Extract<ToolReply, { ok: true }> {
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r;
}

/** A daemon where root owns t1 (/r), its sub-agent t2 (/s1) and another tree t3 (/o). */
async function tree(): Promise<TestDaemon> {
  const d = await startTestDaemon();
  daemons.push(d);
  ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/r` }, ROOT));
  ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/s1` }, SUB));
  ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/o` }, OTHER));
  return d;
}

async function viewer(d: TestDaemon, of = ROOT): Promise<TestViewer> {
  const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 }, of);
  viewers.push(v);
  return v;
}

async function takeOver(v: TestViewer): Promise<void> {
  const taken = v.after((m) => isState(m) && m.control === "user");
  v.send({ t: "takeover" });
  await taken;
}

async function handBack(v: TestViewer): Promise<void> {
  const back = v.after((m) => isState(m) && m.control === "agent");
  v.send({ t: "handback" });
  await back;
}

describe("the viewer context", () => {
  it("a stream whose first message is not the viewer context is closed", async () => {
    const d = await startTestDaemon();
    daemons.push(d);
    const v = await openViewer(d.socketPath, { maxWidth: 320, maxHeight: 200 }, null);
    await v.closed;
    expect(v.messages).toEqual([]);
    expect(d.daemon.state.viewerCount).toBe(0);
  });

  it("a later viewer message from the panel changes nothing", async () => {
    const d = await tree();
    const v = await viewer(d, ROOT);
    await v.next((m) => isState(m) && m.tabs.length === 2);
    // the panel claims another conversation: ignored, the stream keeps the kernel's context
    v.send({ kind: "viewer", conversationId: "other", rootConversationId: "other" } as never);
    v.send({ t: "show", tabId: "t3" });
    v.send({ t: "show", tabId: "t2" });
    const st = (await v.after((m) => isState(m) && m.shown === "t2")) as State;
    expect(st.tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(st.otherTabs.map((t) => t.id)).toEqual(["t3"]);
  });
});

describe("what a viewer sees", () => {
  it("its tree's tabs grouped, other trees' tabs without detail, its shown tab", async () => {
    const d = await tree();
    const v = await viewer(d, ROOT);
    const st = (await v.next((m) => isState(m) && m.tabs.length === 2)) as State;
    expect(st.tabs).toMatchObject([
      { id: "t1", title: "R", group: "own", active: true },
      { id: "t2", title: "S1", group: "sub1", active: false },
    ]);
    expect(st.otherTabs).toEqual([{ id: "t3", title: "O", url: `${fx.url}/o` }]);
    expect(st.shown).toBe("t1");
    expect(st.handoffs).toEqual([]);
  });

  it("a fresh browser's blank start tab is nobody's: no other-conversations entry", async () => {
    const d = await startTestDaemon();
    daemons.push(d);
    const v = await viewer(d, ROOT);
    const st = (await v.next(isState)) as State;
    expect(st).toMatchObject({ tabs: [], otherTabs: [] });
    expect(st.shown).toBeUndefined();
    // the person's first tab is that blank tab, claimed like the tool's first open
    await takeOver(v);
    const opened = v.after((m) => isState(m) && m.tabs.length === 1);
    v.send({ t: "tab", action: "open" });
    expect(await opened).toMatchObject({ tabs: [{ id: "t1", group: "own" }], otherTabs: [] });
    await handBack(v);
  });

  it("the empty state when the tree owns no tab: no other tree's page is shown", async () => {
    const d = await tree();
    const v = await viewer(d, conv("fresh"));
    const st = (await v.next(isState)) as State;
    expect(st.tabs).toEqual([]);
    expect(st.shown).toBeUndefined();
    expect(st.otherTabs.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    // and the viewer opened no tab
    expect(
      ownTabIds(
        ok(await request(d.socketPath, { op: "tabs", action: "list" }, conv("fresh"))).text,
      ),
    ).toEqual([]);
  });

  it("a sub-agent's handoff reaches the root's viewer and shows its tab", async () => {
    const d = await tree();
    const v = await viewer(d, ROOT);
    await v.next((m) => isState(m) && m.shown === "t1");
    const shown = v.after((m) => isState(m) && m.handoffs.length === 1);
    await request(d.socketPath, { op: "handoff_notice", callId: "c1", message: "Sign in" }, SUB);
    expect(await shown).toMatchObject({
      shown: "t2",
      handoffs: [{ callId: "c1", conversationId: "sub", message: "Sign in", tabIds: ["t2"] }],
    });
    // another tree's viewer does not see it
    const vo = await viewer(d, OTHER);
    expect(((await vo.next(isState)) as State).handoffs).toEqual([]);
  });

  it("a watching viewer may choose its shown tab among its tree's tabs only", async () => {
    const d = await tree();
    const v = await viewer(d, ROOT);
    await v.next((m) => isState(m) && m.shown === "t1");
    const sub = v.after((m) => isState(m) && m.shown === "t2");
    v.send({ t: "show", tabId: "t2" });
    expect(await sub).toMatchObject({ control: "agent" });
    // the frames follow the shown tab (not brought to the front: no agent's or viewer's page moves)
    await v.after((m) => m.t === "frame");
    v.send({ t: "show", tabId: "t3" });
    v.send({ t: "show", tabId: "t1" });
    const back = (await v.after((m) => isState(m) && m.shown !== "t2")) as State;
    expect(back.shown).toBe("t1");
    // the sub-agent's active tab did not move
    expect(ok(await request(d.socketPath, { op: "snapshot" }, SUB)).page?.tabId).toBe("t2");
  });
});

describe("what a viewer does", () => {
  it("a watching viewer adopts another tree's tab; its switch is dropped", async () => {
    const d = await tree();
    // the root's second tab, t4, is its active one
    ok(await request(d.socketPath, { op: "tabs", action: "open", url: `${fx.url}/s2` }, ROOT));
    const v = await viewer(d, ROOT);
    await v.next((m) => isState(m) && m.shown === "t4");
    // applied, this switch would make t1 the root's active (and shown) tab
    v.send({ t: "tab", action: "switch", tabId: "t1" });
    // a viewer adopt of a tab of its own tree is ignored
    v.send({ t: "tab", action: "adopt", tabId: "t2" });
    // a state sent after both (another conversation's request ends with one)
    const after = v.after(isState);
    ok(await request(d.socketPath, { op: "tabs", action: "list" }, OTHER));
    expect(await after).toMatchObject({ shown: "t4" });
    expect(ok(await request(d.socketPath, { op: "tabs", action: "list" }, ROOT)).page?.tabId).toBe(
      "t4",
    );
    const moved = v.after((m) => isState(m) && m.tabs.some((t) => t.id === "t3"));
    v.send({ t: "tab", action: "adopt", tabId: "t3" });
    const st = (await moved) as State;
    expect(st.tabs).toMatchObject([
      { id: "t1", group: "own" },
      { id: "t3", group: "own", active: true },
      { id: "t4", group: "own" },
      { id: "t2", group: "sub1" },
    ]);
    expect(st.otherTabs).toEqual([]);
    expect(ok(await request(d.socketPath, { op: "snapshot" }, SUB)).page?.tabId).toBe("t2");
    const other = ok(await request(d.socketPath, { op: "tabs", action: "list" }, OTHER));
    expect(other.text).toContain("Tab t3 (O) was moved to another conversation.");
  });

  it("a viewer adopt at its conversation's tab cap answers the tab_cap notice", async () => {
    const d = await tree();
    while (
      ownTabIds(ok(await request(d.socketPath, { op: "tabs", action: "list" }, ROOT)).text).length <
      MAX_TABS_PER_CONVERSATION
    )
      ok(await request(d.socketPath, { op: "tabs", action: "open" }, ROOT));
    const v = await viewer(d, ROOT);
    await v.next(isState);
    const notice = v.after((m) => m.t === "notice");
    v.send({ t: "tab", action: "adopt", tabId: "t3" });
    expect(await notice).toEqual({ t: "notice", code: "tab_cap" });
  });

  it("the person's use of a tab tells a conversation that had none when the takeover began", async () => {
    const d = await tree();
    const FRESH = conv("fresh");
    const v = await viewer(d, ROOT);
    await v.next(isState);
    await takeOver(v);
    // another panel moves the other tree's tab to a fresh conversation, and the person types there
    const vf = await viewer(d, FRESH);
    const moved = vf.after((m) => isState(m) && m.shown === "t3");
    vf.send({ t: "tab", action: "adopt", tabId: "t3" });
    await moved;
    const navigated = vf.after(
      (m) => isState(m) && m.tabs.some((t) => t.id === "t3" && t.url === `${fx.url}/r`),
    );
    vf.send({ t: "nav", url: `${fx.url}/r` });
    await navigated;
    await handBack(v);
    const fresh = ok(await request(d.socketPath, { op: "snapshot" }, FRESH));
    expect(typeof fresh.userControlledSince).toBe("string");
    // a conversation with no tab then and no tab used is not told
    const bystander = ok(
      await request(d.socketPath, { op: "tabs", action: "list" }, conv("bystander")),
    );
    expect(bystander.userControlledSince).toBeUndefined();
  });

  it("a refused adopt answers the tab_in_use notice", async () => {
    const d = await tree();
    d.daemon.state.park("other", "other", { kind: "long_wait", key: "w1" });
    const v = await viewer(d, ROOT);
    await v.next(isState);
    const notice = v.after((m) => m.t === "notice");
    v.send({ t: "tab", action: "adopt", tabId: "t3" });
    expect(await notice).toEqual({ t: "notice", code: "tab_in_use" });
    expect(ok(await request(d.socketPath, { op: "tabs", action: "list" }, OTHER)).page?.tabId).toBe(
      "t3",
    );
  });

  it("in control, a switch to a sub-agent's tab shows it but leaves the sub-agent's active tab", async () => {
    const d = await tree();
    // the sub-agent has two tabs; t4 is its active one
    ok(await request(d.socketPath, { op: "tabs", action: "open", url: `${fx.url}/clicks` }, SUB));
    const v = await viewer(d, ROOT);
    await v.next((m) => isState(m) && m.tabs.length === 3);
    await takeOver(v);
    const shown = v.after((m) => isState(m) && m.shown === "t2");
    v.send({ t: "tab", action: "switch", tabId: "t2" });
    await shown;
    await handBack(v);
    const sub = ok(await request(d.socketPath, { op: "snapshot" }, SUB));
    expect(sub.page?.tabId).toBe("t4");
    // it owned tabs when the takeover began: told
    expect(typeof sub.userControlledSince).toBe("string");
  });

  it("in control, a switch to its own conversation's tab makes it that conversation's active tab", async () => {
    const d = await tree();
    ok(await request(d.socketPath, { op: "tabs", action: "open", url: `${fx.url}/s2` }, ROOT));
    const v = await viewer(d, ROOT);
    await v.next((m) => isState(m) && m.shown === "t4");
    await takeOver(v);
    const shown = v.after((m) => isState(m) && m.shown === "t1");
    v.send({ t: "tab", action: "switch", tabId: "t1" });
    await shown;
    await handBack(v);
    expect(ok(await request(d.socketPath, { op: "snapshot" }, ROOT)).page?.tabId).toBe("t1");
  });

  it("input goes to the shown tab, a tab the person opens is its conversation's", async () => {
    const d = await tree();
    ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/clicks` }, SUB));
    const v = await viewer(d, ROOT);
    await v.next((m) => isState(m) && m.tabs.length === 2);
    await takeOver(v);
    const sub = v.after((m) => isState(m) && m.shown === "t2");
    v.send({ t: "show", tabId: "t2" });
    await sub;
    const clicked = v.after(
      (m) => isState(m) && m.tabs.some((t) => t.id === "t2" && t.url.endsWith("#clicked")),
    );
    v.send({ t: "mouse", kind: "down", x: 50, y: 50, button: "left" });
    v.send({ t: "mouse", kind: "up", x: 50, y: 50, button: "left" });
    await clicked;
    const opened = v.after((m) => isState(m) && m.tabs.length === 3);
    v.send({ t: "tab", action: "open" });
    const st = (await opened) as State;
    const fresh = st.tabs.find((t) => !["t1", "t2"].includes(t.id));
    expect(fresh).toMatchObject({ group: "own", active: true });
    await handBack(v);
    const root = ok(await request(d.socketPath, { op: "tabs", action: "list" }, ROOT));
    expect(ownTabIds(root.text)).toEqual(["t1", fresh?.id]);
    expect(root.page?.tabId).toBe(fresh?.id);
  });
});
