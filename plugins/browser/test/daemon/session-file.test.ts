import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserSession, TabOwner } from "../../daemon/actions.js";
import { SessionFile, withoutTree } from "../../daemon/session-file.js";
import { DaemonState, systemClock } from "../../daemon/state.js";
import { removeDir } from "./helpers.js";

const dirs: string[] = [];
const states: DaemonState[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
  for (const s of states.splice(0)) s.dispose();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "cbd-sf-"));
  dirs.push(dir);
  return dir;
}

function newState(): DaemonState {
  const s = new DaemonState({ onIdle: () => undefined });
  states.push(s);
  return s;
}

/** A session with fixed tabs; `restored` records the tabs restoreTabs opens, `actives` setActive. */
function fakeSession(tabs: ReturnType<BrowserSession["tabs"]> = []) {
  const restored: { owner: TabOwner; url: string }[] = [];
  const actives: [string, string][] = [];
  let next = 1;
  const session = {
    tabs: () => tabs,
    restoreTab: async (owner: TabOwner, url: string) => {
      restored.push({ owner, url });
      return `t${next++}`;
    },
    setActive: (conv: string, id: string) => actives.push([conv, id]),
  };
  return { session: session as unknown as BrowserSession, restored, actives };
}

const tick = () => new Promise((r) => queueMicrotask(() => r(undefined)));

describe("daemon session file", () => {
  it("saves the tabs with their owners and each conversation's active tab and handoff", async () => {
    const dir = tmp();
    const f = new SessionFile(dir, systemClock);
    const state = newState();
    const { session } = fakeSession([
      { id: "t1", title: "A", url: "https://a.test/", active: false, owner: "c1", root: "c1" },
      { id: "t2", title: "B", url: "https://b.test/", active: true, owner: "c1", root: "c1" },
      { id: "t3", title: "S", url: "https://s.test/", active: true, owner: "sub", root: "c1" },
      // an unowned tab and a non-http one are not kept
      { id: "t4", title: "", url: "https://x.test/", active: false },
      { id: "t5", title: "", url: "about:blank", active: true, owner: "c2", root: "c2" },
    ]);
    f.save(session, state);
    // read when the queued write runs
    state.noticeHandoff("sub", "c1", "h", "Sign in");
    state.park("c2", "c2", { kind: "long_wait", key: "w1", persist: true });
    state.park("c2", "c2", { kind: "dialog", key: "d1", tabId: "t5", persist: true });
    await tick();
    const saved = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
    expect(saved.version).toBe(2);
    expect(saved.tabs).toEqual([
      { url: "https://a.test/", owner: "c1", root: "c1" },
      { url: "https://b.test/", owner: "c1", root: "c1" },
      { url: "https://s.test/", owner: "sub", root: "c1" },
    ]);
    expect(saved.conversations).toEqual([
      { id: "c1", root: "c1", active: 1 },
      { id: "sub", root: "c1", active: 2, handoff: { callId: "h", message: "Sign in" } },
      { id: "c2", root: "c2", parks: [{ kind: "long_wait", key: "w1" }] },
    ]);
    // a round trip: read gives back what was saved
    const back = f.read();
    expect(back?.tabs).toEqual(saved.tabs);
    expect(back?.conversations).toEqual(saved.conversations);
    // and the state gets its handoffs and persistent parks back
    const restored = newState();
    f.restoreState(restored, back ?? (undefined as never));
    expect(restored.handoffOf("sub")).toEqual({ callId: "h", message: "Sign in" });
    expect(restored.parksOf("c2").map((p) => p.kind)).toEqual(["long_wait"]);
  });

  it("restores each tab for its owner and the conversations' active tabs", async () => {
    const f = new SessionFile(tmp(), systemClock);
    const { session, restored, actives } = fakeSession();
    await f.restoreTabs(session, {
      version: 2,
      savedAt: Date.now(),
      tabs: [
        { url: "https://a.test/", owner: "c1", root: "c1" },
        { url: "https://b.test/", owner: "c1", root: "c1" },
        { url: "https://s.test/", owner: "sub", root: "c1" },
      ],
      conversations: [
        { id: "c1", root: "c1", active: 0 },
        { id: "sub", root: "c1", active: 2 },
      ],
    });
    expect(restored).toEqual([
      { owner: { owner: "c1", root: "c1" }, url: "https://a.test/" },
      { owner: { owner: "c1", root: "c1" }, url: "https://b.test/" },
      { owner: { owner: "sub", root: "c1" }, url: "https://s.test/" },
    ]);
    expect(actives).toEqual([
      ["c1", "t1"],
      ["sub", "t3"],
    ]);
  });

  it("does not read a file of the older format", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "session.json"),
      JSON.stringify({ savedAt: Date.now(), tabs: ["https://a.test/"], active: 0 }),
    );
    expect(new SessionFile(dir, systemClock).read()).toBeUndefined();
  });
});

describe("a deleted conversation in the session file", () => {
  const saved = {
    version: 2 as const,
    savedAt: 1234,
    tabs: [
      { url: "https://a.test/", owner: "r", root: "r" },
      { url: "https://x.test/", owner: "x", root: "x" },
      { url: "https://s.test/", owner: "s", root: "r" },
      { url: "https://y.test/", owner: "x", root: "x" },
    ],
    conversations: [
      { id: "r", root: "r", active: 0 },
      { id: "s", root: "r", handoff: { callId: "h", message: "m" } },
      { id: "x", root: "x", active: 3 },
    ],
  };

  it("drops the tree's tabs and conversations and re-points the kept active tabs", () => {
    expect(withoutTree(saved, "r")).toEqual({
      ...saved,
      tabs: [
        { url: "https://x.test/", owner: "x", root: "x" },
        { url: "https://y.test/", owner: "x", root: "x" },
      ],
      conversations: [{ id: "x", root: "x", active: 1 }],
    });
    // nothing of the tree: the same object
    expect(withoutTree(saved, "zz")).toBe(saved);
  });

  it("rewrites the file keeping its save time, and leaves an unreadable one alone", () => {
    const dir = tmp();
    const file = join(dir, "session.json");
    writeFileSync(file, JSON.stringify(saved));
    const f = new SessionFile(dir, systemClock);
    f.dropTree("r");
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.savedAt).toBe(1234);
    expect(after.conversations).toEqual([{ id: "x", root: "x", active: 1 }]);
    writeFileSync(file, "not json");
    f.dropTree("x");
    expect(readFileSync(file, "utf8")).toBe("not json");
  });
});
