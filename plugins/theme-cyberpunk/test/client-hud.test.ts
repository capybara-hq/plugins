// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// = @capybara-hq/plugin-client/testing, through package.json "imports" (see README, Tests)
import { type FakeHost, renderWithFakeHost } from "#client-testing";
import extension from "../src/client.js";
import { RunHud, ticker } from "../src/hud.js";
import { button, FakeAudioContext, installRicherDesign, row } from "./fake-design.js";

const conversationId = "conv_0001abcdef";
const SLOT = "conversation.properties.section";
const SOUND = "cap-ext:theme-cyberpunk:sound";
const at = "2026-11-10T08:00:00.000Z";

let host: FakeHost | undefined;

function renderHud(options: {
  view?: { blocks: []; data?: unknown };
  reducedMotion?: boolean;
  withListeners?: boolean;
}) {
  const h = renderWithFakeHost(
    createElement(RunHud, {
      plugin: "theme-cyberpunk",
      contribution: "run-hud",
      slot: SLOT,
      conversationId,
    }),
    {
      slot: SLOT,
      plugin: "theme-cyberpunk",
      contribution: "run-hud",
      args: { conversationId },
      role: "admin",
      ...(options.view === undefined ? {} : { view: options.view as never }),
      ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
      ...(options.withListeners === true ? { events: extension.events } : {}),
    },
  );
  installRicherDesign();
  h.rerender();
  host = h;
  return h;
}

const state = () => document.querySelector(".cx-theme-cyberpunk-hud-state")?.textContent;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  FakeAudioContext.reset();
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
  host?.unmount();
  host = undefined;
  vi.unstubAllGlobals();
});

describe("run HUD", () => {
  it("shows the run state and follows it", () => {
    const h = renderHud({});
    expect(state()).toBe("STANDBY");
    h.setRunState("running");
    expect(state()).toBe("RUNNING");
    h.setRunState("waiting");
    expect(state()).toBe("AWAITING INPUT");
    h.setRunState("failed");
    expect(state()).toBe("FAULT");
  });

  it("shows the server view data, and a placeholder while it loads", () => {
    renderHud({});
    expect(row("Operator")).toBe("syncing…");
    host?.unmount();
    renderHud({ view: { blocks: [], data: { operator: "admin", uplink: at } } });
    expect(row("Node")).toBe("#ABCDEF");
    expect(row("Operator")).toBe("ADMIN");
    expect(row("Uplink")).toMatch(/^\d\d:\d\d:\d\d$/);
  });

  it("counts runs, tool results and approvals of its own conversation", () => {
    const h = renderHud({});
    const base = { conversationId, at };
    h.emit({ type: "run.started", seq: 1, ...base });
    h.emit({ type: "tool.finished", seq: 2, callId: "c1", tool: "Bash", isError: false, ...base });
    h.emit({ type: "tool.finished", seq: 3, callId: "c2", tool: "Bash", isError: true, ...base });
    h.emit({ type: "approval.requested", seq: 4, callId: "c3", ...base });
    // another conversation's events are not counted
    h.emit({ type: "run.started", seq: 9, conversationId: "conv_other", at });
    expect(row("Runs")).toBe("1");
    expect(row("Tools")).toBe("1 ok / 1 err");
    expect(row("Approvals")).toBe("1");
  });

  it("shows what the extension's listener counted before the panel opened (session storage)", () => {
    // the page is open, the properties panel is not: only the listeners run
    const page = renderWithFakeHost(createElement("div"), {
      slot: "shell.overlay",
      plugin: "theme-cyberpunk",
      events: extension.events,
    });
    const base = { conversationId, at };
    page.emit({ type: "run.started", seq: 1, ...base });
    page.emit({
      type: "tool.finished",
      seq: 2,
      callId: "c1",
      tool: "Bash",
      isError: false,
      ...base,
    });
    page.emit({ type: "run.finished", seq: 3, reason: "end_turn", ...base });
    page.unmount();
    renderHud({});
    expect(row("Runs")).toBe("1");
    expect(row("Tools")).toBe("1 ok / 0 err");
  });

  it("counts an event once when both the listener and the HUD see it", () => {
    const h = renderHud({ withListeners: true });
    const base = { conversationId, at };
    h.emit({ type: "run.started", seq: 1, ...base });
    h.emit({ type: "approval.requested", seq: 2, callId: "c1", ...base });
    expect(row("Runs")).toBe("1");
    expect(row("Approvals")).toBe("1");
  });

  it("keeps sound off by default; the toggle stores the choice and plays a confirmation", () => {
    renderHud({});
    expect(localStorage.getItem(SOUND)).toBeNull();
    act(() => button("Sound: off").click());
    expect(localStorage.getItem(SOUND)).toBe("on");
    expect(button("Sound: on")).toBeDefined();
    expect(FakeAudioContext.contexts).toBe(1);
    act(() => button("Sound: on").click());
    expect(localStorage.getItem(SOUND)).toBeNull();
    expect(button("Sound: off")).toBeDefined();
    expect(FakeAudioContext.contexts).toBe(1);
  });

  it("reads the stored toggle, and stays silent under reduced motion", () => {
    localStorage.setItem(SOUND, "on");
    renderHud({ reducedMotion: true });
    expect(button("Sound: on")).toBeDefined();
    expect(document.body.textContent).toContain("Muted while your system asks for reduced motion.");
    act(() => button("Sound: on").click());
    act(() => button("Sound: off").click());
    expect(FakeAudioContext.contexts).toBe(0);
  });

  it("uses the viewer's language, the role included", () => {
    const h = renderWithFakeHost(
      createElement(RunHud, {
        plugin: "theme-cyberpunk",
        contribution: "run-hud",
        slot: SLOT,
        conversationId,
      }),
      {
        slot: SLOT,
        plugin: "theme-cyberpunk",
        args: { conversationId },
        locale: "zh",
        runState: "running",
        view: { blocks: [], data: { operator: "owner", uplink: at } },
      },
    );
    host = h;
    installRicherDesign();
    h.rerender();
    expect(state()).toBe("运行中");
    expect(row("操作员")).toBe("所有者");
  });

  it("shows a dash, not zero, for counts it has seen nothing of", () => {
    renderHud({});
    expect(row("Runs")).toBe("—");
    expect(row("Tools")).toBe("—");
    expect(row("Approvals")).toBe("—");
  });

  it("ticks the elapsed time of the run", () => {
    expect(ticker(0)).toBe("T+00:00.0");
    expect(ticker(12_345)).toBe("T+00:12.3");
    expect(ticker(125_000)).toBe("T+02:05.0");
    renderHud({});
    expect(document.querySelector(".cx-theme-cyberpunk-hud-ticker")?.textContent).toBe("T+--:--.-");
  });
});
