import { describe, expect, it } from "vitest";
import {
  CONVERSATION_IDLE_MS,
  HANDOFF_KEEPALIVE_MS,
  IDLE_STOP_MS,
  TAKEOVER_GRACE_MS,
} from "../../daemon/protocol.js";
import { type Clock, DaemonState } from "../../daemon/state.js";

class FakeClock implements Clock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  now(): number {
    return this.t;
  }
  schedule(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  cancel(h: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }
}

function make() {
  const clock = new FakeClock();
  let idle = 0;
  const closed: string[] = [];
  const state = new DaemonState({
    clock,
    onIdle: () => idle++,
    onConversationIdle: (c) => closed.push(c),
  });
  return { clock, state, idle: () => idle, closed };
}

describe("daemon state", () => {
  it("takeover ends 60 s after the last viewer closes", () => {
    const { clock, state } = make();
    state.viewerOpened();
    state.viewerOpened();
    state.takeover(["a"]);
    expect(state.control).toBe("user");
    state.viewerClosed();
    clock.advance(TAKEOVER_GRACE_MS * 2);
    expect(state.control).toBe("user"); // one viewer is still open
    state.viewerClosed();
    clock.advance(TAKEOVER_GRACE_MS - 1);
    expect(state.control).toBe("user");
    clock.advance(1);
    expect(state.control).toBe("agent");
    expect(state.takeHandbackNote("a")).toBe(new Date(0).toISOString());
    expect(state.takeHandbackNote("a")).toBeUndefined();
  });

  it("takeover survives a viewer reconnect within the grace", () => {
    const { clock, state } = make();
    state.viewerOpened();
    state.takeover();
    state.viewerClosed();
    clock.advance(TAKEOVER_GRACE_MS - 1000);
    state.viewerOpened();
    clock.advance(TAKEOVER_GRACE_MS * 2);
    expect(state.control).toBe("user");
    expect(state.userControlledSince).toBe(new Date(0).toISOString());
  });

  it("stops after 15 min without requests or viewers", () => {
    const { clock, state, idle } = make();
    state.requestStarted();
    clock.advance(IDLE_STOP_MS * 2);
    expect(idle()).toBe(0); // a request is in flight
    state.requestEnded();
    clock.advance(IDLE_STOP_MS - 1);
    state.viewerOpened();
    clock.advance(IDLE_STOP_MS * 2);
    expect(idle()).toBe(0); // a viewer is open
    state.viewerClosed();
    clock.advance(IDLE_STOP_MS - 1);
    expect(idle()).toBe(0);
    clock.advance(1);
    expect(idle()).toBe(1);
  });

  it("handback clears the takeover and notifies", () => {
    const { state } = make();
    let changes = 0;
    state.onChange(() => changes++);
    state.viewerOpened();
    state.takeover();
    state.handback();
    expect(state.control).toBe("agent");
    expect(state.userControlledSince).toBeUndefined();
    expect(changes).toBe(2);
  });
});

describe("daemon state: a pending handoff", () => {
  it("keeps the daemon alive, at most 24 h", () => {
    const { clock, state, idle } = make();
    state.noticeHandoff("a", "a", "c1", "Sign in");
    clock.advance(IDLE_STOP_MS * 4);
    expect(idle()).toBe(0);
    clock.advance(HANDOFF_KEEPALIVE_MS - IDLE_STOP_MS * 4 - 1);
    expect(idle()).toBe(0);
    clock.advance(1);
    expect(idle()).toBe(1);
  });

  it("idles as usual once the handoff is cleared", () => {
    const { clock, state, idle } = make();
    state.noticeHandoff("a", "a", "c1", "Sign in");
    clock.advance(IDLE_STOP_MS * 2);
    state.clearHandoff("a", "c1");
    clock.advance(IDLE_STOP_MS - 1);
    expect(idle()).toBe(0);
    clock.advance(1);
    expect(idle()).toBe(1);
  });
});

describe("daemon state: handoffs per conversation", () => {
  it("keeps one per conversation; a request drops only its own conversation's", () => {
    const { state } = make();
    state.noticeHandoff("sub", "root", "c1", "Sign in");
    state.noticeHandoff("root", "root", "c1", "Pick one");
    state.noticeHandoff("other", "other", "c9", "Solve it");
    expect(state.handoffs("root").map((h) => [h.conversationId, h.callId])).toEqual([
      ["sub", "c1"],
      ["root", "c1"],
    ]);
    state.dropHandoff("root");
    expect(state.handoffs().map((h) => h.conversationId)).toEqual(["sub", "other"]);
    // a clear names its conversation: the same callId elsewhere is not cleared
    state.clearHandoff("root", "c1");
    expect(state.handoffOf("sub")?.callId).toBe("c1");
    state.clearHandoff("sub", "c1");
    expect(state.handoffs().map((h) => h.conversationId)).toEqual(["other"]);
  });

  it("the keepalive counts from the oldest pending notice", () => {
    const { clock, state, idle } = make();
    state.noticeHandoff("a", "a", "c1", "Sign in");
    clock.advance(HANDOFF_KEEPALIVE_MS / 2);
    state.noticeHandoff("b", "b", "c2", "Sign in");
    // the newer notice of the same conversation keeps the first one's start
    state.noticeHandoff("a", "a", "c3", "Again");
    clock.advance(HANDOFF_KEEPALIVE_MS / 2 - 1);
    expect(idle()).toBe(0);
    clock.advance(1);
    expect(idle()).toBe(1);
  });
});

describe("daemon state: the hand back note", () => {
  it("goes only to the conversations the takeover concerned, once each", () => {
    const { clock, state } = make();
    clock.advance(1000);
    state.viewerOpened();
    state.takeover(["owner"]);
    state.concern("used");
    state.handback();
    // a conversation that started later (or had no tab) is not told
    state.concern("late");
    expect(state.takeHandbackNote("late")).toBeUndefined();
    expect(state.takeHandbackNote("bystander")).toBeUndefined();
    expect(state.takeHandbackNote("owner")).toBe(new Date(1000).toISOString());
    expect(state.takeHandbackNote("used")).toBe(new Date(1000).toISOString());
    expect(state.takeHandbackNote("owner")).toBeUndefined();
  });
});

describe("daemon state: the idle close per conversation", () => {
  it("closes a conversation 15 min after its last request and deletes its state", () => {
    const { clock, state, closed } = make();
    state.requestArrived("a", "a");
    clock.advance(CONVERSATION_IDLE_MS * 2);
    expect(closed).toEqual([]); // in flight
    state.requestFinished("a");
    clock.advance(CONVERSATION_IDLE_MS - 1);
    expect(closed).toEqual([]);
    clock.advance(1);
    expect(closed).toEqual(["a"]);
    expect(state.conversationIds).toEqual([]);
  });

  it("a viewer pin, a handoff or a conversation park keeps it; a tab park pins only its tab", () => {
    const { clock, state, closed } = make();
    state.requestArrived("v", "v");
    state.requestFinished("v");
    state.pin("v", "v");
    state.noticeHandoff("h", "h", "c1", "Sign in");
    state.park("p", "p", { kind: "long_wait", key: "w1" });
    state.park("t", "t", { kind: "dialog", key: "d1", tabId: "t7" });
    clock.advance(CONVERSATION_IDLE_MS * 3);
    // the tab park's conversation idles (its other tabs close) but stays known for its park
    expect(closed).toEqual(["t"]);
    expect(state.tabParked("t7")).toBe(true);
    expect(state.busy("t")).toBe(false);
    expect(state.busy("p")).toBe(true);
    expect(state.busy("h")).toBe(true);
    expect(state.busy("v")).toBe(false);
    expect(state.pinned("v")).toBe(true);
    state.unpin("v");
    state.unpark("p", "long_wait", "w1");
    state.clearHandoff("h", "c1");
    state.tabClosed("t7");
    clock.advance(CONVERSATION_IDLE_MS);
    expect(closed.slice(1).sort()).toEqual(["h", "p", "t", "v"]);
    expect(state.conversationIds).toEqual([]);
  });

  it("a hand back note not yet told goes with the idle close", () => {
    const { clock, state } = make();
    state.requestArrived("a", "a");
    state.requestFinished("a");
    state.viewerOpened();
    state.takeover(["a"]);
    state.handback();
    clock.advance(CONVERSATION_IDLE_MS);
    expect(state.takeHandbackNote("a")).toBeUndefined();
  });
});
