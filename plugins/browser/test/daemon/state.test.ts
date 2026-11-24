import { describe, expect, it } from "vitest";
import { HANDOFF_KEEPALIVE_MS, IDLE_STOP_MS, TAKEOVER_GRACE_MS } from "../../daemon/protocol.js";
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
  const state = new DaemonState({ clock, onIdle: () => idle++ });
  return { clock, state, idle: () => idle };
}

describe("daemon state", () => {
  it("takeover ends 60 s after the last viewer closes", () => {
    const { clock, state } = make();
    state.viewerOpened();
    state.viewerOpened();
    state.takeover();
    expect(state.control).toBe("user");
    state.viewerClosed();
    clock.advance(TAKEOVER_GRACE_MS * 2);
    expect(state.control).toBe("user"); // one viewer is still open
    state.viewerClosed();
    clock.advance(TAKEOVER_GRACE_MS - 1);
    expect(state.control).toBe("user");
    clock.advance(1);
    expect(state.control).toBe("agent");
    expect(state.takeHandbackNote()).toBe(new Date(0).toISOString());
    expect(state.takeHandbackNote()).toBeUndefined();
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
    state.noticeHandoff("c1", "Sign in");
    clock.advance(IDLE_STOP_MS * 4);
    expect(idle()).toBe(0);
    clock.advance(HANDOFF_KEEPALIVE_MS - IDLE_STOP_MS * 4 - 1);
    expect(idle()).toBe(0);
    clock.advance(1);
    expect(idle()).toBe(1);
  });

  it("idles as usual once the handoff is cleared", () => {
    const { clock, state, idle } = make();
    state.noticeHandoff("c1", "Sign in");
    clock.advance(IDLE_STOP_MS * 2);
    state.clearHandoff("c1");
    clock.advance(IDLE_STOP_MS - 1);
    expect(idle()).toBe(0);
    clock.advance(1);
    expect(idle()).toBe(1);
  });
});
