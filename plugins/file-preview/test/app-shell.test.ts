// @vitest-environment jsdom
import { EMBED_PROTOCOL } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BridgeEvent, createBridge } from "../ui-src/app/bridge.js";
import { MESSAGES, workerReason } from "../ui-src/app/frame.js";
import { startApp } from "../ui-src/app/main.js";
import { applyTheme } from "../ui-src/app/theme.js";
import type { PreviewFile, Renderer, RunInWorker } from "../ui-src/app/types.js";
import { WorkerTimeoutError } from "../ui-src/app/worker-host.js";
import { render as renderSheet } from "../ui-src/renderers/sheet.js";
import type { SheetOutput } from "../ui-src/shared/sheet.js";

const init = { protocol: EMBED_PROTOCOL, type: "init", locale: "en", theme: "dark", tokens: {} };
const fileMsg = (size = 3) => ({
  protocol: EMBED_PROTOCOL,
  type: "file",
  name: "a.txt",
  contentType: "text/plain",
  size,
  data: new ArrayBuffer(size),
});

/** Delivers a message as if the outer page (`window.parent`) sent it. */
function post(data: unknown, source: MessageEventSource | null = window.parent) {
  window.dispatchEvent(new MessageEvent("message", { data, source }));
}

let stops: Array<() => void> = [];
beforeEach(() => {
  document.head.innerHTML = '<meta name="previewer" content="code">';
  document.body.innerHTML = '<div id="root"></div>';
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  vi.useRealTimers();
});

describe("createBridge", () => {
  const listen = () => {
    const events: BridgeEvent[] = [];
    stops.push(createBridge(window, (e) => events.push(e)));
    return events;
  };

  it("ignores foreign sources, other protocols and unknown types", () => {
    const events = listen();
    const other = document.body.appendChild(document.createElement("iframe")).contentWindow;
    post(init, other);
    post(init, null);
    post({ ...init, protocol: "other/1" });
    post({ ...init, type: "token", token: "x" });
    post({ ...init, type: "navigate" });
    post("init");
    post(null);
    expect(events).toEqual([]);
    post(init);
    expect(events.map((e) => e.type)).toEqual(["init"]);
  });

  it("delivers the file only after init, and only once", () => {
    const events = listen();
    post(fileMsg());
    expect(events).toEqual([]);
    post(init);
    post(fileMsg(2));
    post(fileMsg(5));
    expect(events.map((e) => e.type)).toEqual(["init", "file"]);
    const file = events[1];
    expect(file?.type === "file" && file.file.size).toBe(2);
  });

  it("rejects malformed messages", () => {
    const events = listen();
    post({ ...init, locale: "fr" });
    post({ ...init, theme: "blue" });
    post(init);
    post({ ...fileMsg(), data: "abc" });
    post({ ...fileMsg(), size: -1 });
    expect(events.map((e) => e.type)).toEqual(["init"]);
  });

  it("stops listening when disposed", () => {
    const events: BridgeEvent[] = [];
    const stop = createBridge(window, (e) => events.push(e));
    stop();
    post(init);
    expect(events).toEqual([]);
  });
});

describe("applyTheme", () => {
  it("sets the --cap- variables and data-theme; a later call replaces them without touching nodes", () => {
    const node = document.getElementById("root");
    applyTheme(document, "dark", { "--cb-bg": "#000", "--cb-ink": "#fff" });
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--cap-background")).toBe("#000");
    expect(style.getPropertyValue("--cap-foreground")).toBe("#fff");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyTheme(document, "light", { "--cb-bg": "#fff", "--cb-accent": "red" });
    expect(style.getPropertyValue("--cap-background")).toBe("#fff");
    expect(style.getPropertyValue("--cap-foreground")).not.toBe("#fff");
    expect(style.getPropertyValue("--cap-accent")).toBe("red");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.getElementById("root")).toBe(node);
  });

  it("ignores token names that are not --cb- identifiers", () => {
    applyTheme(document, "dark", { "a;b": "1", "--cb-bg": "#123" });
    expect(document.documentElement.style.getPropertyValue("--cap-background")).toBe("#123");
    expect(document.documentElement.style.cssText).not.toContain("a;b");
  });
});

describe("the main flow", () => {
  const start = (renderer: Renderer, budgetMs?: number) => {
    const render = vi.fn(renderer);
    stops.push(
      startApp({
        loadRenderer: async () => render,
        ...(budgetMs === undefined ? {} : { budgetMs }),
      }),
    );
    return render;
  };
  const text = () => document.getElementById("root")?.textContent ?? "";
  const flush = () => vi.waitFor(() => expect(text()).not.toBe(MESSAGES.en.loading));

  it("draws scrollbars as the theme's thumb on a transparent track, inherited from :root", () => {
    start(async () => {});
    const css = [...document.head.querySelectorAll("style")].map((s) => s.textContent).join("\n");
    expect(css).toMatch(
      /:root \{[^}]*scrollbar-color: var\(--cap-scroll-thumb, [^)]+\)\) transparent;/,
    );
  });

  it("themes on init and re-themes on a theme event while the preview stays mounted", async () => {
    const mounted: HTMLElement[] = [];
    start(async (_f, ctx) => {
      ctx.root.textContent = "body";
      mounted.push(ctx.root);
    });
    post({ ...init, tokens: { "--cb-bg": "#000" } });
    post(fileMsg());
    await vi.waitFor(() => expect(text()).toBe("body"));
    post({
      protocol: EMBED_PROTOCOL,
      type: "theme",
      theme: "light",
      tokens: { "--cb-bg": "#fff" },
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--cap-background")).toBe("#fff");
    expect(mounted[0]?.isConnected).toBe(true);
    expect(text()).toBe("body");
  });

  it("a 0-byte file shows the empty state and never calls the renderer", async () => {
    const render = start(async () => {});
    post({ ...init, locale: "zh" });
    post(fileMsg(0));
    await vi.waitFor(() => expect(text()).toBe(MESSAGES.zh.empty));
    expect(render).not.toHaveBeenCalled();
  });

  it("hands the renderer the file, the locale and a live signal", async () => {
    let seen: { file: PreviewFile; locale: string; aborted: boolean } | undefined;
    start(async (file, ctx) => {
      seen = { file, locale: ctx.locale, aborted: ctx.signal.aborted };
      ctx.root.textContent = ctx.t("loading");
    });
    post(init);
    post(fileMsg());
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen?.file.name).toBe("a.txt");
    expect(seen?.locale).toBe("en");
    expect(seen?.aborted).toBe(false);
  });

  it("paints no ground before init: Canvas would flash light in the host's dark pane", () => {
    const render = vi.fn<Renderer>(async () => {});
    stops.push(startApp({ loadRenderer: async () => render }));
    const css = [...document.head.querySelectorAll("style")].map((e) => e.textContent).join("\n");
    const preInit =
      /:root:not\(\[data-theme\]\) body, :root:not\(\[data-theme\]\) \.cap-status \{([^}]*)\}/;
    expect(preInit.exec(css)?.[1]).toContain("background: transparent;");
    // init sets data-theme: the theme's ground takes over
    post(init);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("ctx.lifetime outlives the render: not aborted once it settled, aborted on teardown", async () => {
    let seen: { signal: AbortSignal; lifetime: AbortSignal } | undefined;
    const render = vi.fn<Renderer>(async (_f, ctx) => {
      seen = { signal: ctx.signal, lifetime: ctx.lifetime };
      ctx.root.textContent = "painted";
    });
    const stop = startApp({ loadRenderer: async () => render });
    post(init);
    post(fileMsg());
    await vi.waitFor(() => expect(text()).toBe("painted"));
    // the render attempt is over (`signal`), the painted preview is not (`lifetime`)
    await vi.waitFor(() => expect(seen?.signal.aborted).toBe(true));
    expect(seen?.lifetime.aborted).toBe(false);
    stop();
    expect(seen?.lifetime.aborted).toBe(true);
  });

  it("the previous file's lifetime is aborted when a new file replaces it", async () => {
    const lifetimes: AbortSignal[] = [];
    const render = vi.fn<Renderer>(async (_f, ctx) => {
      lifetimes.push(ctx.lifetime);
      ctx.root.textContent = "painted";
    });
    // the page's bridge delivers one file per embed: a fake bridge drives two through the run path
    let emit: (e: BridgeEvent) => void = () => {};
    const fileOf = (size: number): PreviewFile => ({
      name: "a.txt",
      contentType: "text/plain",
      size,
      data: new ArrayBuffer(size),
    });
    stops.push(
      startApp({
        loadRenderer: async () => render,
        createBridge: (_win, onEvent) => {
          emit = onEvent;
          return () => {};
        },
      }),
    );
    emit({ type: "file", file: fileOf(2) });
    await vi.waitFor(() => expect(lifetimes).toHaveLength(1));
    expect(lifetimes[0]?.aborted).toBe(false);
    emit({ type: "file", file: fileOf(3) });
    await vi.waitFor(() => expect(lifetimes).toHaveLength(2));
    expect(lifetimes[0]?.aborted).toBe(true);
    expect(lifetimes[1]?.aborted).toBe(false);
  });

  it("ctx.lifetime stays live when the render fails or runs out of budget", async () => {
    vi.useFakeTimers();
    let lifetime: AbortSignal | undefined;
    start((_f, ctx) => {
      lifetime = ctx.lifetime;
      return new Promise<void>(() => {});
    });
    post(init);
    post(fileMsg());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(text()).toContain(MESSAGES.en.timeout);
    expect(lifetime?.aborted).toBe(false);
  });

  it("a throwing renderer shows its message as text, never as markup", async () => {
    start(async () => {
      throw new Error("bad <img src=x onerror=alert(1)>");
    });
    post(init);
    post(fileMsg());
    await flush();
    expect(text()).toContain("bad <img src=x onerror=alert(1)>");
    expect(text()).toContain(MESSAGES.en.errorTitle);
    expect(text()).toContain(MESSAGES.en.downloadHint);
    expect(document.querySelector("#root img")).toBeNull();
  });

  it("in zh a failed parse says the reader failed, without the English error message", async () => {
    start(async () => {
      throw new Error("Unexpected end of data");
    });
    post({ ...init, locale: "zh" });
    post(fileMsg());
    await vi.waitFor(() => expect(text()).toContain(MESSAGES.zh.readerFailed));
    expect(text()).not.toContain("Unexpected end of data");
    expect(workerReason(new WorkerTimeoutError("sheet", 1), "zh")).toBe(MESSAGES.zh.timeout);
    expect(workerReason(new Error("boom"), "en")).toBe(`${MESSAGES.en.readerFailed}: boom`);
  });

  it("ctx.showError shows the inline error and keeps it after the renderer resolves", async () => {
    start(async (_f, ctx) => {
      ctx.showError("not a zip");
    });
    post(init);
    post(fileMsg());
    await vi.waitFor(() => expect(text()).toContain("not a zip"));
    expect(text()).toContain(MESSAGES.en.errorTitle);
  });

  it("a renderer that never resolves hits the 20 s budget", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    start((_f, ctx) => {
      signal = ctx.signal;
      return new Promise<void>(() => {});
    }, undefined);
    post({ ...init, locale: "zh" });
    post(fileMsg());
    await vi.advanceTimersByTimeAsync(19_999);
    expect(text()).toBe(MESSAGES.zh.loading);
    await vi.advanceTimersByTimeAsync(1);
    expect(text()).toContain(MESSAGES.zh.timeout);
    expect(signal?.aborted).toBe(true);
  });

  it("lays the content root out (not display:none) while the renderer runs", async () => {
    let display = "";
    start(async (_f, ctx) => {
      display = getComputedStyle(ctx.root).display;
      ctx.root.textContent = "body";
    });
    post(init);
    post(fileMsg());
    await vi.waitFor(() => expect(display).not.toBe(""));
    expect(display).not.toBe("none");
    expect(
      getComputedStyle(document.getElementById("root")?.lastElementChild as Element).visibility,
    ).not.toBe("hidden");
  });

  it("gives the content a definite height so the sheet's own scroller scrolls, not #root", async () => {
    // jsdom has no layout: this pins the contract the browser check found broken (F1). The content
    // area fills #root, and the chain down to the virtual table's scroller is all definite heights
    const rows = Array.from({ length: 5000 }, (_, r) => [`r${r + 1}`]);
    const output: SheetOutput = {
      sheets: [
        {
          name: "S",
          hidden: false,
          rows,
          merges: [],
          truncatedRows: false,
          truncatedCols: false,
          truncatedCells: false,
        },
      ],
    };
    stops.push(
      startApp({
        loadRenderer: async () => renderSheet,
        runInWorker: (async () => output) as unknown as RunInWorker,
      }),
    );
    post(init);
    post(fileMsg());
    await vi.waitFor(() => expect(document.querySelector(".cap-sheet-scroll")).not.toBeNull());
    const content = document.getElementById("root")?.lastElementChild as HTMLElement;
    expect(getComputedStyle(content).height).toBe("100%");
    const sheet = content.querySelector(".cap-sheet") as HTMLElement;
    expect(sheet.parentElement).toBe(content);
    expect(getComputedStyle(sheet).height).toBe("100%");
    const scroller = content.querySelector(".cap-sheet-scroll") as HTMLElement;
    expect(getComputedStyle(scroller).overflow).toBe("auto");
    for (
      let el: HTMLElement | null = scroller;
      el !== null && el !== sheet;
      el = el.parentElement
    ) {
      expect(getComputedStyle(el).minHeight, el.className).toMatch(/^0(px)?$/);
    }
  });

  it("ignores window errors and rejections once the render succeeded", async () => {
    start(async (_f, ctx) => {
      ctx.root.textContent = "painted";
    });
    post(init);
    post(fileMsg());
    await vi.waitFor(() => expect(text()).toBe("painted"));
    // the shell marks success on its status layer, like loading / empty / error
    expect((document.querySelector("#root > .cap-status") as HTMLElement).dataset.state).toBe(
      "ready",
    );
    window.dispatchEvent(new ErrorEvent("error", { message: "late" }));
    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", { value: new Error("later") });
    window.dispatchEvent(rejection);
    expect(text()).toBe("painted");
  });

  it("a second init re-themes without showing loading over the painted preview", async () => {
    start(async (_f, ctx) => {
      ctx.root.textContent = "painted";
    });
    post(init);
    post(fileMsg());
    await vi.waitFor(() => expect(text()).toBe("painted"));
    post({ ...init, theme: "light", tokens: { "--cb-bg": "#fff" } });
    expect(text()).toBe("painted");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("window errors and unhandled rejections show the error state", async () => {
    start(() => new Promise<void>(() => {}));
    post(init);
    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));
    expect(text()).toContain("boom");
    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", { value: new Error("later") });
    window.dispatchEvent(rejection);
    expect(text()).toContain("later");
  });
});
