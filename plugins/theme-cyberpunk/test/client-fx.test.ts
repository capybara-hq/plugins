// @vitest-environment jsdom

import { type FakeHost, renderWithFakeHost } from "@capybara-hq/plugin-client/testing";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FxLayer, measureFx, RunFx } from "../src/fx.js";

let host: FakeHost | undefined;
afterEach(() => {
  host?.unmount();
  host = undefined;
  document.body.replaceChildren();
});

/** An element carrying a part, at a fixed rect. */
function partAt(
  name: string,
  rect: { x: number; y: number; w: number; h: number },
  parent = document.body,
) {
  const el = document.createElement("div");
  el.setAttribute("data-cap-part", name);
  el.getBoundingClientRect = () =>
    ({
      left: rect.x,
      top: rect.y,
      width: rect.w,
      height: rect.h,
      right: rect.x + rect.w,
      bottom: rect.y + rect.h,
    }) as DOMRect;
  parent.appendChild(el);
  return el;
}

describe("run effects", () => {
  it("measure the newest reply, clipped between the title bar and the composer, and the composer", () => {
    partAt("title-bar", { x: 260, y: 0, w: 800, h: 48 });
    const thread = partAt("thread", { x: 300, y: -400, w: 720, h: 1200 });
    partAt("message.assistant", { x: 300, y: -300, w: 720, h: 200 }, thread);
    partAt("message.assistant", { x: 300, y: 500, w: 720, h: 400 }, thread);
    partAt("composer", { x: 300, y: 780, w: 720, h: 80 });
    const fx = measureFx(document, 900);
    expect(fx.reply).toEqual({ x: 300, y: 500, w: 720, h: 280, edge: false });
    expect(fx.composer).toEqual({ x: 300, y: 780, w: 720, h: 80 });
  });

  it("mark the write head when the reply's bottom edge is in view", () => {
    const thread = partAt("thread", { x: 0, y: 0, w: 700, h: 900 });
    partAt("message.assistant", { x: 0, y: 100, w: 700, h: 300 }, thread);
    partAt("composer", { x: 0, y: 800, w: 700, h: 80 });
    expect(measureFx(document, 900).reply?.edge).toBe(true);
  });

  it("draw a beam, a write head and a travelling light while running; a ring while waiting", () => {
    const layout = {
      reply: { x: 1, y: 2, w: 3, h: 40, edge: true },
      composer: { x: 0, y: 0, w: 10, h: 10 },
    };
    host = renderWithFakeHost(createElement(FxLayer, { state: "running", layout }), {
      slot: "shell.overlay",
    });
    const root = document.querySelector(".cx-theme-cyberpunk-fx");
    expect(root?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelectorAll(".cx-theme-cyberpunk-fx-beam")).toHaveLength(1);
    expect(document.querySelectorAll(".cx-theme-cyberpunk-fx-edge")).toHaveLength(1);
    expect(document.querySelectorAll(".cx-theme-cyberpunk-fx-comet")).toHaveLength(2);
    host.unmount();
    host = renderWithFakeHost(createElement(FxLayer, { state: "waiting", layout }), {
      slot: "shell.overlay",
    });
    expect(document.querySelectorAll(".cx-theme-cyberpunk-fx-beam")).toHaveLength(0);
    expect(document.querySelectorAll(".cx-theme-cyberpunk-fx-ring")).toHaveLength(1);
  });

  it("draw nothing when idle, and nothing under reduced motion", () => {
    partAt("composer", { x: 0, y: 800, w: 700, h: 80 });
    host = renderWithFakeHost(createElement(RunFx), { slot: "shell.overlay", runState: "idle" });
    expect(document.querySelector(".cx-theme-cyberpunk-fx")).toBeNull();
    host.unmount();
    host = renderWithFakeHost(createElement(RunFx), {
      slot: "shell.overlay",
      runState: "running",
      reducedMotion: true,
    });
    expect(document.querySelector(".cx-theme-cyberpunk-fx")).toBeNull();
    host.unmount();
    host = renderWithFakeHost(createElement(RunFx), { slot: "shell.overlay", runState: "running" });
    expect(document.querySelector('.cx-theme-cyberpunk-fx [data-fx="composer"]')).not.toBeNull();
  });
});
