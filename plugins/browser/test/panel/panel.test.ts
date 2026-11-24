import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewerIn, ViewerOut } from "../../daemon/protocol.js";
import { STRINGS, t } from "../../ui-src/panel/i18n.js";
import { PANEL_HTML } from "../../ui-src/panel/page.js";
import { letterbox, mapPoint, mountPanel } from "../../ui-src/panel/panel.js";

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
  opts: {
    locale?: "zh" | "en";
    width?: number;
    dpr?: number;
    ticket?: () => Response;
    answer?: () => Response;
    hosts?: () => Response;
    /** Storage throws, as in the opaque-origin sandboxed iframe. */
    noStorage?: boolean;
  } = {},
): Setup {
  FakeSocket.all = [];
  const dom = new JSDOM(PANEL_HTML, { url: "https://app.test/plugin-ui/browser/browser" });
  const win = dom.window as unknown as Window & typeof globalThis;
  Object.defineProperty(win, "innerWidth", { value: opts.width ?? 800, configurable: true });
  Object.defineProperty(win, "devicePixelRatio", { value: opts.dpr ?? 1, configurable: true });
  if (opts.noStorage)
    for (const name of ["sessionStorage", "localStorage"])
      Object.defineProperty(win, name, {
        configurable: true,
        get: () => {
          throw new dom.window.DOMException("The document is sandboxed", "SecurityError");
        },
      });
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
    if (url === "handoff-answer" && opts.answer) return opts.answer();
    if (url === "network-hosts" && opts.hosts) return opts.hosts();
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
      source: dom.window,
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

  it("a remounted panel with storage throwing is interactive while the person holds control", async () => {
    const s = setup({ noStorage: true });
    const sock = await live(s, state({ control: "user" }));
    // no takeover click in this panel: a remount (expand / collapse) mid-takeover
    expect(($(s, "handback") as HTMLElement).hidden).toBe(false);
    expect($(s, "status").textContent).toBe(t("en", "takeoverHint"));
    const view = $(s, "view");
    view.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 300 }) as DOMRect;
    view.dispatchEvent(new s.dom.window.KeyboardEvent("keydown", { key: "a", code: "KeyA" }));
    expect(sock.sent).toContainEqual({ t: "key", kind: "down", key: "a", code: "KeyA" });
    view.dispatchEvent(
      new s.dom.window.MouseEvent("mousemove", { clientX: 240, clientY: 150, bubbles: true }),
    );
    expect(sock.sent).toContainEqual({ t: "mouse", kind: "move", x: 640, y: 400 });
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

  it("asks for full-viewport frames whenever the person holds control", async () => {
    const s = setup({ dpr: 2 });
    const sock = await live(s);
    expect(sock.sent[0]).toEqual({ t: "hello", maxWidth: 640, maxHeight: 400 });
    sock.push(state({ control: "user" }));
    expect(sock.sent.at(-1)).toEqual({ t: "resize", maxWidth: 960, maxHeight: 600 });
    sock.push(state({ control: "agent" }));
    expect(sock.sent.at(-1)).toEqual({ t: "resize", maxWidth: 640, maxHeight: 400 });
  });

  it("a fresh mount mid-takeover asks for the full-viewport cap on the first state", async () => {
    const s = setup({ dpr: 2 });
    const sock = await live(s, state({ control: "user" }));
    expect(sock.sent[0]).toEqual({ t: "hello", maxWidth: 640, maxHeight: 400 });
    expect(sock.sent).toContainEqual({ t: "resize", maxWidth: 960, maxHeight: 600 });
    // a reconnect (new socket, no state yet) does the same
    sock.drop(1012);
    await vi.waitFor(() => expect(FakeSocket.all.length).toBe(2));
    const sock2 = s.sock();
    sock2.open();
    sock2.push(state({ control: "user" }));
    // the last size this connection asked for is the full-viewport one (hello or resize)
    const sized = sock2.sent.filter((m) => m.t === "hello" || m.t === "resize").at(-1);
    expect(sized).toMatchObject({ maxWidth: 960, maxHeight: 600 });
  });

  it("does not drive the page while the agent holds control", async () => {
    const s = setup();
    const sock = await live(s);
    const view = $(s, "view");
    view.dispatchEvent(new s.dom.window.KeyboardEvent("keydown", { key: "a" }));
    view.dispatchEvent(new s.dom.window.MouseEvent("mousemove", { clientX: 1, clientY: 1 }));
    expect(sock.sent.some((m) => m.t === "key" || (m.t === "mouse" && m.kind === "move"))).toBe(
      false,
    );
  });

  it("offers takeover only in the live view", async () => {
    const s = setup();
    await vi.waitFor(() => expect(FakeSocket.all.length).toBe(1));
    expect(($(s, "takeover") as HTMLElement).hidden).toBe(true);
    const sock = s.sock();
    sock.open();
    sock.push(state());
    expect(($(s, "takeover") as HTMLElement).hidden).toBe(false);
    sock.drop(4409);
    expect(($(s, "takeover") as HTMLElement).hidden).toBe(true);
  });

  it("ignores messages that do not come from the host page", async () => {
    FakeSocket.all = [];
    const dom = new JSDOM(PANEL_HTML, { url: "https://app.test/plugin-ui/browser/browser" });
    const win = dom.window as unknown as Window & typeof globalThis;
    const calls: string[] = [];
    mountPanel({
      window: win,
      fetch: (async (u: string) => {
        calls.push(u);
        return new Response("{}");
      }) as never,
      WebSocket: FakeSocket as never,
      post: () => undefined,
    });
    win.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: null,
        data: { protocol: "capybara-embed/1", type: "init", token: "x", locale: "en" },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
  });

  it("shows a lock for a secure page", async () => {
    const s = setup();
    const sock = await live(s, state({ secure: true }));
    expect(($(s, "lock") as HTMLElement).hidden).toBe(false);
    expect($(s, "lock").getAttribute("aria-label")).toBe(t("en", "secure"));
    sock.push(state({ secure: false }));
    expect(($(s, "lock") as HTMLElement).hidden).toBe(true);
  });

  it("flashes only clicks newer than the ones it has seen", async () => {
    const s = setup();
    const sock = await live(s, state({ lastClick: { x: 1, y: 1, seq: 3 } }));
    const flash = $(s, "flash") as HTMLElement;
    expect(flash.hidden).toBe(true);
    sock.push(state({ lastClick: { x: 1, y: 1, seq: 3 } }));
    expect(flash.hidden).toBe(true);
    sock.push(state({ lastClick: { x: 2, y: 2, seq: 4 } }));
    expect(flash.hidden).toBe(false);
  });

  it("a dialog strip hides after 10 s or when the page changes; a file chooser has fixed text", async () => {
    vi.useFakeTimers();
    const s = setup();
    await vi.advanceTimersByTimeAsync(0);
    const sock = s.sock();
    sock.open();
    sock.push(state());
    sock.push({ t: "dialog", kind: "alert", message: "hi" });
    expect(($(s, "dialog") as HTMLElement).hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(($(s, "dialog") as HTMLElement).hidden).toBe(true);
    sock.push({ t: "dialog", kind: "file", message: "" });
    expect($(s, "dialog-text").textContent).toBe(t("en", "fileDialog"));
    // a state of the same page (the reply that follows the dialog) keeps it readable
    sock.push(state());
    expect(($(s, "dialog") as HTMLElement).hidden).toBe(false);
    // the next page's state hides it
    sock.push(
      state({ tabs: [{ id: "t1", title: "Next", url: "https://example.com/next", active: true }] }),
    );
    expect(($(s, "dialog") as HTMLElement).hidden).toBe(true);
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

  it("allow button adds the host and opens the blocked page", async () => {
    const s = setup();
    const sock = await live(s);
    sock.push({ t: "blocked", host: "cdn.test", url: "https://cdn.test/page" });
    expect(($(s, "blocked") as HTMLElement).hidden).toBe(false);
    expect($(s, "blocked").textContent).toContain("cdn.test");
    $(s, "allow").click();
    await vi.waitFor(() =>
      expect(sock.sent).toContainEqual({ t: "nav", url: "https://cdn.test/page" }),
    );
    expect(sock.sent).not.toContainEqual({ t: "nav", action: "reload" });
    expect(s.fetchCalls.find((c) => c.url === "network-hosts")?.body).toEqual({
      hosts: ["cdn.test"],
    });
    expect(($(s, "blocked") as HTMLElement).hidden).toBe(true);
  });

  it("an allow that restarts the daemon: the 4404 is retried and the page opened again", async () => {
    vi.useFakeTimers();
    const s = setup();
    await vi.advanceTimersByTimeAsync(0);
    const sock = s.sock();
    sock.open();
    sock.push(state());
    sock.push({ t: "blocked", host: "cdn.test", url: "https://cdn.test/page" });
    $(s, "allow").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sock.sent).toContainEqual({ t: "nav", url: "https://cdn.test/page" });
    // the service restarts with the new network: the viewer is closed, the restart not done yet
    sock.drop(4404);
    expect(($(s, "empty") as HTMLElement).hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    const sock2 = s.sock();
    sock2.drop(4404);
    expect(($(s, "empty") as HTMLElement).hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(FakeSocket.all).toHaveLength(3);
    const sock3 = s.sock();
    sock3.open();
    sock3.push(state({ tabs: [{ id: "t1", title: "", url: "about:blank", active: true }] }));
    expect(sock3.sent).toContainEqual({ t: "nav", url: "https://cdn.test/page" });
  });

  it("a 4404 is retried twice before the empty state", async () => {
    vi.useFakeTimers();
    const s = setup();
    await vi.advanceTimersByTimeAsync(0);
    s.sock().drop(4404);
    await vi.advanceTimersByTimeAsync(1_000);
    s.sock().drop(4404);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(FakeSocket.all).toHaveLength(3);
    s.sock().drop(4404);
    expect(($(s, "empty") as HTMLElement).hidden).toBe(false);
  });

  it("the empty state looks for the browser every 10 s while visible, for 30 min at most", async () => {
    vi.useFakeTimers();
    const s = setup({
      ticket: () => new Response(JSON.stringify({ code: "service_not_running" }), { status: 409 }),
    });
    await vi.advanceTimersByTimeAsync(0);
    const tickets = () => s.fetchCalls.filter((c) => c.url === "stream-ticket").length;
    expect(tickets()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tickets()).toBe(2);
    const doc = s.dom.window.document;
    let vis = "hidden";
    Object.defineProperty(doc, "visibilityState", { get: () => vis, configurable: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tickets()).toBe(2);
    vis = "visible";
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    const atEnd = tickets();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tickets()).toBe(atEnd);
    expect(atEnd).toBeLessThanOrEqual(2 + (30 * 60) / 10);
  });

  it("shows why an allow was refused", async () => {
    const s = setup({
      hosts: () =>
        new Response(
          JSON.stringify({ error: { code: "not_owner", message: "Only the owner can allow." } }),
          { status: 403 },
        ),
    });
    const sock = await live(s);
    sock.push({ t: "blocked", host: "cdn.test", url: "https://cdn.test/" });
    $(s, "allow").click();
    await vi.waitFor(() => expect(($(s, "notice") as HTMLElement).hidden).toBe(false));
    expect($(s, "notice").textContent).toContain(t("en", "allowFailed"));
    expect($(s, "notice").textContent).toContain("Only the owner can allow.");
    expect(($(s, "blocked") as HTMLElement).hidden).toBe(false);
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

describe("handoff banner", () => {
  const handoff = { callId: "call-1", message: "Log in" };

  it("shows the banner from state.handoff and hides it when absent", async () => {
    const s = setup();
    const sock = await live(s, state({ handoff }));
    expect(($(s, "handoff") as HTMLElement).hidden).toBe(false);
    expect($(s, "handoff-message").textContent).toBe("Log in");
    sock.push(state());
    expect(($(s, "handoff") as HTMLElement).hidden).toBe(true);
  });

  it("done and cancel post handoff-answer", async () => {
    const s = setup();
    await live(s, state({ handoff }));
    $(s, "handoff-done").click();
    await vi.waitFor(() =>
      expect(s.fetchCalls.find((c) => c.url === "handoff-answer")?.body).toEqual({
        callId: "call-1",
        done: true,
      }),
    );
    $(s, "handoff-cancel").click();
    await vi.waitFor(() =>
      expect(s.fetchCalls.filter((c) => c.url === "handoff-answer")[1]?.body).toEqual({
        callId: "call-1",
        done: false,
      }),
    );
  });

  it("hides the banner when the question is gone (404) and shows nothing else", async () => {
    const s = setup({
      answer: () =>
        new Response(JSON.stringify({ error: { code: "question.not_found", message: "x" } }), {
          status: 404,
        }),
    });
    const sock = await live(s, state({ handoff }));
    $(s, "handoff-done").click();
    await vi.waitFor(() => expect(($(s, "handoff") as HTMLElement).hidden).toBe(true));
    expect(($(s, "empty") as HTMLElement).hidden).toBe(true);
    expect(sock.sent.some((m) => m.t === "handback")).toBe(false);
  });

  it("keeps the banner and shows why when the answer fails otherwise", async () => {
    const s = setup({
      answer: () =>
        new Response(JSON.stringify({ error: { code: "x", message: "The device is gone." } }), {
          status: 500,
        }),
    });
    await live(s, state({ handoff }));
    $(s, "handoff-done").click();
    await vi.waitFor(() => expect(($(s, "notice") as HTMLElement).hidden).toBe(false));
    expect($(s, "notice").textContent).toContain(t("en", "answerFailed"));
    expect($(s, "notice").textContent).toContain("The device is gone.");
    expect(($(s, "handoff") as HTMLElement).hidden).toBe(false);
  });

  it("handing back with a pending handoff answers it Done", async () => {
    const s = setup();
    const sock = await live(s, state({ control: "user", handoff }));
    $(s, "handback").click();
    expect(sock.sent).toContainEqual({ t: "handback" });
    await vi.waitFor(() =>
      expect(s.fetchCalls.find((c) => c.url === "handoff-answer")?.body).toEqual({
        callId: "call-1",
        done: true,
      }),
    );
  });

  it("handing back without a handoff answers nothing", async () => {
    const s = setup();
    const sock = await live(s, state({ control: "user" }));
    $(s, "handback").click();
    expect(sock.sent).toContainEqual({ t: "handback" });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.fetchCalls.some((c) => c.url === "handoff-answer")).toBe(false);
  });

  it("works in the compact size class", async () => {
    const s = setup({ width: 500 });
    await live(s, state({ handoff }));
    expect(($(s, "handoff") as HTMLElement).hidden).toBe(false);
    $(s, "handoff-done").click();
    await vi.waitFor(() => expect(s.fetchCalls.some((c) => c.url === "handoff-answer")).toBe(true));
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
      const known = new Set<string>(Object.values(STRINGS[locale]));
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
