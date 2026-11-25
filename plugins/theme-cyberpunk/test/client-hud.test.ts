// @vitest-environment jsdom

import { type FakeHost, renderWithFakeHost } from "@capybara-hq/plugin-client/testing";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/client.js";
import { RunHud, ticker } from "../src/hud.js";
import {
  button,
  description,
  FakeAudioContext,
  installRicherDesign,
  row,
  switchNamed,
} from "./fake-design.js";

// The fake host always reports the built-in theme; the theme test switches the key here.
const theme = vi.hoisted(() => ({ key: null as string | null }));
vi.mock("@capybara-hq/plugin-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capybara-hq/plugin-client")>();
  return {
    ...actual,
    useTheme: () => ({ ...actual.useTheme(), key: theme.key }),
  };
});

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
  theme.key = null;
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

  it("keeps sound off by default; the switch stores the choice and plays a confirmation", () => {
    renderHud({});
    expect(localStorage.getItem(SOUND)).toBeNull();
    const sw = () => switchNamed("Sound");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(description(sw())).toContain("Short synthesized cues");
    act(() => sw().click());
    expect(localStorage.getItem(SOUND)).toBe("on");
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(FakeAudioContext.contexts).toBe(1);
    act(() => sw().click());
    expect(localStorage.getItem(SOUND)).toBeNull();
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(FakeAudioContext.contexts).toBe(1);
  });

  it("has no sound button and keeps the hints in tooltips, not in the panel text", () => {
    renderHud({});
    expect(() => button("Sound:")).toThrow();
    const counts = "Runs, tools and approvals: seen live in this browser tab.";
    const tips = [...document.querySelectorAll("[data-tooltip]")].map((e) =>
      e.getAttribute("data-tooltip"),
    );
    expect(tips).toContain(counts);
    expect(tips.some((t) => t?.startsWith("Short synthesized cues"))).toBe(true);
    // the footnote is only in the tooltip (and the info icon's label), never shown as text
    expect(document.body.textContent).not.toContain(counts);
    // the Tools row reads as before
    expect(row("Tools")).toBe("—");
  });

  it("reads the stored switch, and stays silent under reduced motion", () => {
    localStorage.setItem(SOUND, "on");
    renderHud({ reducedMotion: true });
    const sw = () => switchNamed("Sound");
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(description(sw())).toContain("Muted while your system asks for reduced motion.");
    act(() => sw().click());
    act(() => sw().click());
    expect(FakeAudioContext.contexts).toBe(0);
  });

  it("shows no Reconnect while the view has not failed", () => {
    renderHud({});
    expect(() => button("Reconnect")).toThrow();
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

  it("ticks while running on a timer it clears when the run stops and on unmount", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const cleared = vi.spyOn(window, "clearInterval");
      const tick = () => document.querySelector(".cx-theme-cyberpunk-hud-ticker")?.textContent;
      const h = renderHud({});
      expect(vi.getTimerCount()).toBe(0);
      h.setRunState("running");
      expect(vi.getTimerCount()).toBe(1);
      act(() => vi.advanceTimersByTime(1_500));
      expect(tick()).toBe("T+00:01.5");
      h.setRunState("idle");
      expect(cleared).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      act(() => vi.advanceTimersByTime(5_000));
      expect(tick()).toBe("T+00:01.5"); // frozen at the last value
      h.setRunState("running");
      expect(vi.getTimerCount()).toBe(1);
      host?.unmount();
      host = undefined;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ticks the elapsed time of the run", () => {
    expect(ticker(0)).toBe("T+00:00.0");
    expect(ticker(12_345)).toBe("T+00:12.3");
    expect(ticker(125_000)).toBe("T+02:05.0");
  });

  it("shows no ticker before this panel has seen a run", () => {
    const h = renderHud({});
    expect(document.querySelector(".cx-theme-cyberpunk-hud-ticker")).toBeNull();
    h.setRunState("running");
    expect(document.querySelector(".cx-theme-cyberpunk-hud-ticker")?.textContent).toMatch(/^T\+/);
  });

  it("draws the dot and the meter only under the cyberpunk theme", () => {
    const decoration = () => [
      document.querySelector(".cx-theme-cyberpunk-hud-dot"),
      document.querySelector(".cx-theme-cyberpunk-hud-meter"),
    ];
    renderHud({});
    expect(decoration()).toEqual([null, null]);
    host?.unmount();
    theme.key = "theme-cyberpunk/cyberpunk";
    renderHud({});
    expect(decoration().every((el) => el !== null)).toBe(true);
  });
});
