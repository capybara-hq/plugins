// @vitest-environment jsdom

import { type FakeHost, renderWithFakeHost } from "@capybara-hq/plugin-client/testing";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/client.js";
import { playCue } from "../src/sound.js";
import { FakeAudioContext } from "./fake-design.js";

const SOUND = "cap-ext:theme-cyberpunk:sound";
const base = { conversationId: "conv_1", at: "2026-11-10T08:00:00.000Z" };

let host: FakeHost | undefined;
/** The mocked performance.now() (ms); each test starts far past the previous test's cues. */
let clock = 0;

/**
 * A fake host with the extension's listeners, emitting the five events that play cues, `gapMs`
 * apart (0 = a burst, like a revisit's catch-up).
 */
function emitAll(reducedMotion: boolean, gapMs: number): void {
  host = renderWithFakeHost(createElement("div"), {
    slot: "shell.overlay",
    plugin: "theme-cyberpunk",
    events: extension.events,
    reducedMotion,
  });
  const events = [
    { type: "run.started", seq: 1, ...base },
    { type: "tool.finished", seq: 2, callId: "c1", tool: "Bash", isError: false, ...base },
    { type: "approval.requested", seq: 3, callId: "c2", ...base },
    { type: "run.finished", seq: 4, reason: "end_turn", ...base },
    { type: "run.failed", seq: 5, code: "model_error", ...base },
  ] as const;
  for (const e of events) {
    host.emit(e);
    clock += gapMs;
  }
}

/** Sets `navigator.userActivation` (undefined removes it: a browser without the API). */
function activation(hasBeenActive: boolean | undefined): void {
  Object.defineProperty(navigator, "userActivation", {
    value: hasBeenActive === undefined ? undefined : { hasBeenActive },
    configurable: true,
  });
}

beforeEach(() => {
  localStorage.clear();
  FakeAudioContext.reset();
  vi.stubGlobal("AudioContext", FakeAudioContext);
  clock += 10_000_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  activation(true);
});

afterEach(() => {
  host?.unmount();
  host = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  activation(undefined);
});

describe("sound listeners", () => {
  it("listen to run.started, run.finished, run.failed, approval.requested and tool.finished", () => {
    expect(Object.keys(extension.events ?? {}).sort()).toEqual([
      "approval.requested",
      "run.failed",
      "run.finished",
      "run.started",
      "tool.finished",
    ]);
  });

  it("play nothing by default (sound is off until the viewer turns it on)", () => {
    emitAll(false, 1000);
    expect(FakeAudioContext.contexts).toBe(0);
  });

  it("play one cue per event once the toggle is on", () => {
    localStorage.setItem(SOUND, "on");
    emitAll(false, 1000);
    expect(FakeAudioContext.contexts).toBe(5);
    expect(FakeAudioContext.tones).toBeGreaterThan(5);
  });

  it("play one cue for a burst of events (cues never overlap or queue up)", () => {
    localStorage.setItem(SOUND, "on");
    emitAll(false, 0);
    expect(FakeAudioContext.contexts).toBe(1);
  });

  it("play nothing under reduced motion, even with the toggle on", () => {
    localStorage.setItem(SOUND, "on");
    emitAll(true, 1000);
    expect(FakeAudioContext.contexts).toBe(0);
  });

  it("play nothing before the page's first user gesture (no context waits to burst later)", () => {
    localStorage.setItem(SOUND, "on");
    activation(false);
    emitAll(false, 1000);
    expect(FakeAudioContext.contexts).toBe(0);
    // a browser without navigator.userActivation plays
    activation(undefined);
    expect(playCue("tick")).toBe(true);
  });

  it("close a context the browser keeps suspended, and free the slot for the next cue", async () => {
    FakeAudioContext.startState = "suspended";
    expect(playCue("done")).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(FakeAudioContext.closed).toBe(1);
    expect(playCue("done")).toBe(true);
    expect(FakeAudioContext.contexts).toBe(2);
  });

  it("play nothing (and do not throw) where the browser has no Web Audio", () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(playCue("done")).toBe(false);
    localStorage.setItem(SOUND, "on");
    expect(() => emitAll(false, 1000)).not.toThrow();
  });
});
