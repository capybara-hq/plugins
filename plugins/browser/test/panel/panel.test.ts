import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewerIn, ViewerOut } from "../../daemon/protocol.js";
import { STRINGS, t } from "../../src/panel/i18n.js";
import { PANEL_HTML } from "../../src/panel/page.js";
import { letterbox, mapPoint, mountPanel } from "../../src/panel/panel.js";

class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = "";
  sent: ViewerIn[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: unknown): void {
    this.sent.push(JSON.parse(new TextDecoder().decode(data as Uint8Array)) as ViewerIn);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  push(msg: ViewerOut): void {
    this.onmessage?.({ data: new TextEncoder().encode(JSON.stringify(msg)).buffer });
  }
  drop(code: number): void {
    this.onclose?.({ code });
  }
}

const state = (over: Partial<Extract<ViewerOut, { t: "state" }>> = {}): ViewerOut => ({
  t: "state",
  tabs: [{ id: "t1", title: "Example", url: "https://example.com/", active: true }],
  loading: false,
  secure: true,
  control: "agent",
  ...over,
});

interface Setup {
  dom: JSDOM;
  fetchCalls: { url: string; body: unknown }[];
  host: unknown[];
  sock: () => FakeSocket;
}

function setup(
  opts: { locale?: "zh" | "en"; width?: number; ticket?: () => Response } = {},
): Setup {
  FakeSocket.all = [];
  const dom = new JSDOM(PANEL_HTML, { url: "https://app.test/plugin-ui/browser/browser" });
  const win = dom.window as unknown as Window & typeof globalThis;
  Object.defineProperty(win, "innerWidth", { value: opts.width ?? 800, configurable: true });
  const fetchCalls: { url: string; body: unknown }[] = [];
  const host: unknown[] = [];
  const fetchImpl = async (url: string, init?: { body?: string }): Promise<Response> => {
    fetchCalls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    if (url === "stream-ticket") {
      return (
        opts.ticket?.() ??
        new Response(JSON.stringify({ url: "wss://app.test/ws?t=1" }), { status: 200 })
      );
    }
    return new Response("{}", { status: 200 });
  };
  const stage = dom.window.document.getElementById("stage") as HTMLElement;
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 400 }) as DOMRect;
  mountPanel({
    window: win,
    fetch: fetchImpl as never,
    WebSocket: FakeSocket as never,
    post: (m) => host.push(m),
    decode: async () => ({ width: 1280, height: 800 }) as never,
  });
  win.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: {
        protocol: "capybara-embed/1",
        type: "init",
        token: "tok",
        locale: opts.locale ?? "en",
        theme: "dark",
        tokens: {},
        context: { orgId: "o", conversationId: "c1" },
      },
    }),
  );
  return {
    dom,
    fetchCalls,
    host,
    sock: () => FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket,
  };
}

async function live(s: Setup, st: ViewerOut = state()): Promise<FakeSocket> {
  await vi.waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  const sock = s.sock();
  sock.open();
  sock.push(st);
  return sock;
}

const $ = (s: Setup, id: string) => s.dom.window.document.getElementById(id) as HTMLElement;

afterEach(() => {
  vi.useRealTimers();
  FakeSocket.all = [];
});

describe("geometry", () => {
  it("maps a click at canvas (240,150) in a 480x300 view to page (640,400)", () => {
    const r = letterbox(480, 300);
    expect(mapPoint(240, 150, r)).toEqual({ x: 640, y: 400 });
  });
  it("letterboxes a 16:10 frame inside a 480x400 panel", () => {
    expect(letterbox(480, 400)).toEqual({ x: 0, y: 50, w: 480, h: 300 });
    expect(letterbox(1000, 300)).toEqual({ x: 260, y: 0, w: 480, h: 300 });
  });
});

describe("panel", () => {
  it("sends hello with a capped size and acks frames", async () => {
    const s = setup();
    const sock = await live(s);
    expect(sock.binaryType).toBe("arraybuffer");
    expect(sock.sent[0]).toEqual({ t: "hello", maxWidth: 480, maxHeight: 300 });
    sock.push({ t: "frame", seq: 7, jpeg: "AAAA", width: 1280, height: 800 });
    await vi.waitFor(() => expect(sock.sent).toContainEqual({ t: "frame-ack", seq: 7 }));
  });

  it("forwards a click in the canvas mapped to page coordinates", async () => {
    const s = setup();
    const sock = await live(s, state({ control: "user" }));
    $(s, "takeover").click();
    const view = $(s, "view");
    view.getBoundingClientRect = () => ({ left: 0, top: 50, width: 480, height: 300 }) as DOMRect;
    const ev = new s.dom.window.MouseEvent("mousedown", { clientX: 240, clientY: 200, button: 0 });
    view.dispatchEvent(ev);
    expect(sock.sent).toContainEqual({ t: "mouse", kind: "down", x: 640, y: 400, button: "left" });
  });

  it("takeover sends takeover and asks the host for panel-mode full", async () => {
    const s = setup();
    const sock = await live(s);
    $(s, "takeover").click();
    expect(sock.sent).toContainEqual({ t: "takeover" });
    expect(s.host).toContainEqual({ protocol: "capybara-embed/1", type: "panel-mode", full: true });
    expect(s.host).toHaveLength(1);
  });

  it("Esc sends handback and panel-mode full=false", async () => {
    const s = setup();
    const sock = await live(s);
    $(s, "takeover").click();
    sock.push(state({ control: "user" }));
    s.dom.window.document.dispatchEvent(
      new s.dom.window.KeyboardEvent("keydown", { key: "Escape" }),
    );
    expect(sock.sent).toContainEqual({ t: "handback" });
    expect(s.host.at(-1)).toEqual({
      protocol: "capybara-embed/1",
      type: "panel-mode",
      full: false,
    });
  });

  it("restores the takeover UI after a remount from sessionStorage and the first state", async () => {
    const s = setup();
    const sock = await live(s);
    $(s, "takeover").click();
    sock.push(state({ control: "user" }));
    const key =
      (s.dom.window.sessionStorage.length > 0 && s.dom.window.sessionStorage.key(0)) || "";
    expect(key).toContain("c1");
    // A second panel on the same storage (a remount).
    const win = s.dom.window as unknown as Window & typeof globalThis;
    const host2: unknown[] = [];
    mountPanel({
      window: win,
      fetch: (async () => new Response(JSON.stringify({ url: "wss://x" }))) as never,
      WebSocket: FakeSocket as never,
      post: (m) => host2.push(m),
      decode: async () => ({ width: 1, height: 1 }) as never,
    });
    win.dispatchEvent(
      new s.dom.window.MessageEvent("message", {
        data: {
          protocol: "capybara-embed/1",
          type: "init",
          token: "t",
          locale: "en",
          context: { orgId: "o", conversationId: "c1" },
        },
      }),
    );
    await vi.waitFor(() => expect(FakeSocket.all.length).toBe(2));
    const sock2 = FakeSocket.all[1] as FakeSocket;
    sock2.open();
    sock2.push(state({ control: "user" }));
    expect(host2).toEqual([]);
    expect(($(s, "handback") as HTMLElement).hidden).toBe(false);
  });

  it("typing in the address bar and Enter sends nav with the url", async () => {
    const s = setup();
    const sock = await live(s);
    const url = $(s, "url") as HTMLInputElement;
    url.value = "https://news.test/";
    url.dispatchEvent(new s.dom.window.KeyboardEvent("keydown", { key: "Enter" }));
    expect(sock.sent).toContainEqual({ t: "nav", url: "https://news.test/" });
  });

  it("back, forward and reload send nav actions", async () => {
    const s = setup();
    const sock = await live(s);
    $(s, "back").click();
    $(s, "forward").click();
    $(s, "reload").click();
    expect(sock.sent.filter((m) => m.t === "nav")).toEqual([
      { t: "nav", action: "back" },
      { t: "nav", action: "forward" },
      { t: "nav", action: "reload" },
    ]);
  });

  it("allow button adds the host and reloads", async () => {
    const s = setup();
    const sock = await live(s);
    sock.push({ t: "blocked", host: "cdn.test", url: "https://cdn.test/a.js" });
    expect(($(s, "blocked") as HTMLElement).hidden).toBe(false);
    expect($(s, "blocked").textContent).toContain("cdn.test");
    $(s, "allow").click();
    await vi.waitFor(() => expect(sock.sent).toContainEqual({ t: "nav", action: "reload" }));
    expect(s.fetchCalls.find((c) => c.url === "network-hosts")?.body).toEqual({
      hosts: ["cdn.test"],
    });
    expect(($(s, "blocked") as HTMLElement).hidden).toBe(true);
  });

  it("panel shows reconnect after device-offline close and fetches a new ticket on click", async () => {
    const s = setup();
    const sock = await live(s);
    sock.drop(4409);
    expect(($(s, "reconnect") as HTMLElement).hidden).toBe(false);
    $(s, "reconnect").click();
    await vi.waitFor(() => expect(FakeSocket.all.length).toBe(2));
    expect(s.fetchCalls.filter((c) => c.url === "stream-ticket")).toHaveLength(2);
  });

  it("retries once with a new ticket on 4401", async () => {
    const s = setup();
    const sock = await live(s);
    sock.drop(4401);
    await vi.waitFor(() => expect(FakeSocket.all.length).toBe(2));
    (FakeSocket.all[1] as FakeSocket).drop(4401);
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeSocket.all.length).toBe(2);
    expect(($(s, "reconnect") as HTMLElement).hidden).toBe(false);
  });

  it("reconnects automatically on 1012", async () => {
    const s = setup();
    const sock = await live(s);
    sock.drop(1012);
    await vi.waitFor(() => expect(FakeSocket.all.length).toBe(2));
  });

  it("empty state when the ticket route answers service_not_running", async () => {
    const s = setup({
      ticket: () => new Response(JSON.stringify({ code: "service_not_running" }), { status: 409 }),
    });
    await vi.waitFor(() => expect(($(s, "empty") as HTMLElement).hidden).toBe(false));
    expect(FakeSocket.all).toHaveLength(0);
    expect($(s, "empty").textContent).toContain(t("en", "emptyTitle"));
  });

  it("compact size class is watch-only", async () => {
    const s = setup({ width: 500 });
    const sock = await live(s);
    expect(($(s, "takeover") as HTMLElement).hidden).toBe(true);
    expect(sock.sent[0]).toMatchObject({ t: "hello" });
  });

  it("closes the stream after 60 s hidden and reconnects when visible", async () => {
    vi.useFakeTimers();
    const s = setup();
    await vi.advanceTimersByTimeAsync(0);
    const sock = s.sock();
    sock.open();
    sock.push(state());
    const doc = s.dom.window.document;
    let vis = "hidden";
    Object.defineProperty(doc, "visibilityState", { get: () => vis, configurable: true });
    doc.dispatchEvent(new s.dom.window.Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(sock.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sock.closed).toBe(true);
    vis = "visible";
    doc.dispatchEvent(new s.dom.window.Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.all.length).toBe(2);
  });
});

describe("i18n", () => {
  it("zh and en have the same keys; zh has no 企业 or Latin agent", () => {
    expect(Object.keys(STRINGS.zh).sort()).toEqual(Object.keys(STRINGS.en).sort());
    for (const v of Object.values(STRINGS.zh)) {
      expect(v).not.toContain("企业");
      expect(v).not.toMatch(/agent/i);
    }
    for (const v of [...Object.values(STRINGS.zh), ...Object.values(STRINGS.en)])
      expect(v.length).toBeGreaterThan(0);
  });

  it("all visible strings come from i18n in zh and en", async () => {
    for (const locale of ["zh", "en"] as const) {
      const s = setup({ locale });
      await live(s);
      const doc = s.dom.window.document;
      const known = new Set(Object.values(STRINGS[locale]));
      const texts: string[] = [];
      for (const el of Array.from(
        doc.querySelectorAll("button, label, p, span, [aria-label], [title], input"),
      )) {
        if (el.closest("[hidden]") !== null) continue;
        if (el.id === "url" || el.closest("#tabs") !== null || el.id === "blocked-host") continue;
        const own = Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => (n.textContent ?? "").trim())
          .filter(Boolean);
        texts.push(...own);
        for (const a of ["aria-label", "title", "placeholder"]) {
          const v = el.getAttribute(a);
          if (v) texts.push(v);
        }
      }
      for (const text of texts)
        expect(known.has(text) || /^[<>↻×+]$/.test(text), `${locale}: ${text}`).toBe(true);
      if (locale === "zh") expect(texts.join(" ")).not.toMatch(/agent|企业/i);
    }
  });
});
