// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// = @capybara-hq/plugin-client/testing, through package.json "imports" (see README, Tests)
import { type FakeHost, renderWithFakeHost } from "#client-testing";
import extension from "../src/client.js";
import { playCue } from "../src/sound.js";
import { FakeAudioContext } from "./fake-design.js";

const SOUND = "cap-ext:theme-cyberpunk:sound";
const base = { conversationId: "conv_1", at: "2026-11-10T08:00:00.000Z" };

let host: FakeHost | undefined;

/** A fake host with the extension's listeners, emitting the four events that play cues. */
function emitAll(reducedMotion: boolean): void {
  host = renderWithFakeHost(createElement("div"), {
    slot: "shell.overlay",
    plugin: "theme-cyberpunk",
    events: extension.events,
    reducedMotion,
  });
  host.emit({ type: "run.started", seq: 1, ...base });
  host.emit({ type: "tool.finished", seq: 2, callId: "c1", tool: "Bash", isError: false, ...base });
  host.emit({ type: "approval.requested", seq: 3, callId: "c2", ...base });
  host.emit({ type: "run.finished", seq: 4, reason: "end_turn", ...base });
}

beforeEach(() => {
  localStorage.clear();
  FakeAudioContext.reset();
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
  host?.unmount();
  host = undefined;
  vi.unstubAllGlobals();
});

describe("sound listeners", () => {
  it("listen to run.started, run.finished, approval.requested and tool.finished", () => {
    expect(Object.keys(extension.events ?? {}).sort()).toEqual([
      "approval.requested",
      "run.finished",
      "run.started",
      "tool.finished",
    ]);
  });

  it("play nothing by default (sound is off until the viewer turns it on)", () => {
    emitAll(false);
    expect(FakeAudioContext.contexts).toBe(0);
  });

  it("play one cue per event once the toggle is on", () => {
    localStorage.setItem(SOUND, "on");
    emitAll(false);
    expect(FakeAudioContext.contexts).toBe(4);
    expect(FakeAudioContext.tones).toBeGreaterThan(4);
  });

  it("play nothing under reduced motion, even with the toggle on", () => {
    localStorage.setItem(SOUND, "on");
    emitAll(true);
    expect(FakeAudioContext.contexts).toBe(0);
  });

  it("play nothing (and do not throw) where the browser has no Web Audio", () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(playCue("done")).toBe(false);
    localStorage.setItem(SOUND, "on");
    expect(() => emitAll(false)).not.toThrow();
  });
});
