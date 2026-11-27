import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clipCodePoints,
  encodeFrame,
  type ViewerIn,
  type ViewerOut,
  type ViewerTab,
} from "../../daemon/protocol.js";
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
  /** A binary frame message, as the daemon sends it. */
  pushFrame(seq: number): void {
    const bytes = encodeFrame({ seq, width: 1280, height: 800, jpeg: new Uint8Array([1, 2, 3]) });
    this.onmessage?.({ data: bytes.buffer });
  }
  drop(code: number): void {
    this.onclose?.({ code });
  }
}

type StateMsg = Extract<ViewerOut, { t: "state" }>;
/** A tab of the state message; its group defaults to the viewer's own conversation. */
type TabIn = Omit<ViewerTab, "group"> & { group?: string };

const state = (over: Partial<Omit<StateMsg, "tabs">> & { tabs?: TabIn[] } = {}): ViewerOut => {
  const tabs = (
    over.tabs ?? [{ id: "t1", title: "Example", url: "https://example.com/", active: true }]
  ).map((x) => ({ ...x, group: x.group ?? "own" }));
  const shown = tabs.find((x) => x.active)?.id;
  return {
    t: "state",
    otherTabs: [],
    handoffs: [],
    loading: false,
    secure: true,
    control: "agent",
    ...(shown === undefined ? {} : { shown }),
    ...over,
    tabs,
  };
};

interface Setup {
  dom: JSDOM;
  fetchCalls: { url: string; body: unknown }[];
  host: unknown[];
  sock: () => FakeSocket;
  /** Gives the stage a new size and fires the panel's ResizeObserver, as a layout change does. */
  resizeStage: (width: number, height: number) => void;
}

function setup(
  opts: {
    locale?: "zh" | "en";
    width?: number;
    /** The device's screen width (default a desktop's). */
    screen?: number;
    dpr?: number;
    ticket?: () => Response;
    answer?: () => Response | Promise<Response>;
    hosts?: () => Response;
    /** Storage throws, as in the opaque-origin sandboxed iframe. */
    noStorage?: boolean;
    /** The iframe's viewport height (the stage is 400 px of it). */
    innerHeight?: number;
  } = {},
): Setup {
  FakeSocket.all = [];
  const dom = new JSDOM(PANEL_HTML, { url: "https://app.test/plugin-ui/browser/browser" });
  const win = dom.window as unknown as Window & typeof globalThis;
  Object.defineProperty(win, "innerWidth", { value: opts.width ?? 800, configurable: true });
  // the device's screen: a phone (below 600) only watches
  Object.defineProperty(win, "screen", {
    value: { width: opts.screen ?? 1440, height: 900 },
    configurable: true,
  });
  Object.defineProperty(win, "devicePixelRatio", { value: opts.dpr ?? 1, configurable: true });
  Object.defineProperty(win, "innerHeight", { value: opts.innerHeight ?? 480, configurable: true });
  const observers: (() => void)[] = [];
  (win as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private cb: () => void) {}
    observe(): void {
      observers.push(this.cb);
    }
  };
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
  // the area the picture is fitted into: the stage minus its 12 px ground on each side
  let stageRect = { width: 480, height: 400 };
  stage.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: stageRect.width + 24, height: stageRect.height + 24 }) as DOMRect;
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
    resizeStage: (width, height) => {
      stageRect = { width, height };
      for (const cb of observers) cb();
    },
  };
}

const resizes = (s: Setup) =>
  s.host.filter((m) => (m as { type?: string }).type === "resize") as { height: number }[];
const modes = (s: Setup) => s.host.filter((m) => (m as { type?: string }).type === "panel-mode");
/** The host tells the panel the mode it draws it in (the embed bridge's `panel-mode`). */
const hostMode = (s: Setup, full: boolean) =>
  s.dom.window.dispatchEvent(
    new s.dom.window.MessageEvent("message", {
      source: s.dom.window,
      data: { protocol: "capybara-embed/1", type: "panel-mode", full },
    }),
  );

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
    sock.pushFrame(7);
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
    expect(modes(s)).toEqual([{ protocol: "capybara-embed/1", type: "panel-mode", full: true }]);
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
    expect(modes(s).at(-1)).toEqual({
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
    expect($(s, "status").textContent).toBe(
      `${t("en", "statusUser")} · ${t("en", "statusUserDetail")}`,
    );
    const view = $(s, "view");
    view.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 300 }) as DOMRect;
    $(s, "input-sink").dispatchEvent(
      new s.dom.window.KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true }),
    );
    expect(sock.sent).toContainEqual({ t: "key", kind: "down", key: "a", code: "KeyA" });
    view.dispatchEvent(
      new s.dom.window.MouseEvent("mousemove", { clientX: 240, clientY: 150, bubbles: true }),
    );
    expect(sock.sent).toContainEqual({ t: "mouse", kind: "move", x: 640, y: 400 });
    s.dom.window.document.dispatchEvent(
      new s.dom.window.KeyboardEvent("keydown", { key: "Escape" }),
    );
    expect(sock.sent).toContainEqual({ t: "handback" });
    expect(modes(s).at(-1)).toEqual({
      protocol: "capybara-embed/1",
      type: "panel-mode",
      full: false,
    });
  });

  it("sizes frames to the CSS box with the pixel ratio capped, up to the full viewport in control", async () => {
    const s = setup({ dpr: 2 });
    // a 480 px wide box at 2x asks 1.25x of it, not 960
    const sock = await live(s);
    expect(sock.sent[0]).toEqual({ t: "hello", maxWidth: 600, maxHeight: 375 });
    // a wide box: the side view stays within its budget
    s.resizeStage(1000, 700);
    expect(sock.sent.at(-1)).toEqual({ t: "resize", maxWidth: 640, maxHeight: 400 });
    // in control the full viewport is the cap
    sock.push(state({ control: "user" }));
    expect(sock.sent.at(-1)).toEqual({ t: "resize", maxWidth: 1250, maxHeight: 781 });
    sock.push(state({ control: "agent" }));
    expect(sock.sent.at(-1)).toEqual({ t: "resize", maxWidth: 640, maxHeight: 400 });
  });

  it("a fresh mount mid-takeover asks for the full-viewport cap on the first state", async () => {
    const s = setup({ dpr: 2 });
    s.resizeStage(800, 500);
    const sock = await live(s, state({ control: "user" }));
    expect(sock.sent[0]).toEqual({ t: "hello", maxWidth: 640, maxHeight: 400 });
    expect(sock.sent).toContainEqual({ t: "resize", maxWidth: 1000, maxHeight: 625 });
    // a reconnect (new socket, no state yet) does the same
    sock.drop(1012);
    await vi.waitFor(() => expect(FakeSocket.all.length).toBe(2));
    const sock2 = s.sock();
    sock2.open();
    sock2.push(state({ control: "user" }));
    // the last size this connection asked for is the full-viewport one (hello or resize)
    const sized = sock2.sent.filter((m) => m.t === "hello" || m.t === "resize").at(-1);
    expect(sized).toMatchObject({ maxWidth: 1000, maxHeight: 625 });
  });

  it("is read-only while the agent holds control: no input of any kind leaves the panel", async () => {
    const s = setup();
    const sock = await live(s);
    const w = s.dom.window;
    const view = $(s, "view");
    view.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 300 }) as DOMRect;
    const sink = $(s, "input-sink");
    view.dispatchEvent(new w.MouseEvent("mousedown", { clientX: 10, clientY: 10, bubbles: true }));
    w.dispatchEvent(new w.MouseEvent("mouseup", { clientX: 10, clientY: 10 }));
    view.dispatchEvent(new w.MouseEvent("mousemove", { clientX: 1, clientY: 1, bubbles: true }));
    view.dispatchEvent(new w.WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
    sink.dispatchEvent(new w.KeyboardEvent("keydown", { key: "a", bubbles: true }));
    sink.dispatchEvent(new w.CompositionEvent("compositionend", { data: "你好" }));
    const url = $(s, "url") as HTMLInputElement;
    url.value = "https://news.test/";
    url.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter" }));
    $(s, "back").click();
    for (const b of Array.from(w.document.querySelectorAll("#tabs button")))
      (b as HTMLButtonElement).click();
    sock.push({ t: "blocked", host: "cdn.test", url: "https://cdn.test/page" });
    $(s, "allow").click();
    await vi.waitFor(() => expect(s.fetchCalls.some((c) => c.url === "network-hosts")).toBe(true));
    const input = sock.sent.filter((m) => !["hello", "resize", "frame-ack", "pong"].includes(m.t));
    expect(input).toEqual([]);
    expect(($(s, "back") as HTMLButtonElement).disabled).toBe(true);
    expect(url.readOnly).toBe(true);
    // a cursor message changes nothing in the watch state
    sock.push({ t: "cursor", cursor: "pointer" });
    expect(view.style.cursor).toBe("default");
  });

  it("answers a ping at once", async () => {
    const s = setup();
    const sock = await live(s);
    sock.push({ t: "ping", id: 42 });
    expect(sock.sent.at(-1)).toEqual({ t: "pong", id: 42 });
  });

  it("sends the newest pointer position at most every 33 ms while it moves", async () => {
    vi.useFakeTimers();
    const s = setup();
    await vi.advanceTimersByTimeAsync(0);
    const sock = s.sock();
    sock.open();
    sock.push(state({ control: "user" }));
    const w = s.dom.window;
    const view = $(s, "view");
    view.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 400 }) as DOMRect;
    const moves = () => sock.sent.filter((m) => m.t === "mouse" && m.kind === "move");
    for (let i = 1; i <= 5; i++)
      view.dispatchEvent(
        new w.MouseEvent("mousemove", { clientX: i * 10, clientY: 10, bubbles: true }),
      );
    // the first at once, the rest wait for the interval and only the newest goes
    expect(moves()).toEqual([{ t: "mouse", kind: "move", x: 20, y: 20 }]);
    await vi.advanceTimersByTimeAsync(33);
    expect(moves()).toEqual([
      { t: "mouse", kind: "move", x: 20, y: 20 },
      { t: "mouse", kind: "move", x: 100, y: 20 },
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(moves()).toHaveLength(2);
  });

  it("shows the page's cursor on the picture while driving, and the default after hand back", async () => {
    const s = setup();
    const sock = await live(s, state({ control: "user" }));
    const view = $(s, "view");
    sock.push({ t: "cursor", cursor: "pointer" });
    expect(view.style.cursor).toBe("pointer");
    sock.push({ t: "cursor", cursor: "text" });
    expect(view.style.cursor).toBe("text");
    // anything unknown (an image cursor, a forged value) is the arrow
    sock.push({ t: "cursor", cursor: "url(evil.png), auto" } as never);
    expect(view.style.cursor).toBe("default");
    sock.push({ t: "cursor", cursor: "grab" });
    sock.push(state({ control: "agent" }));
    expect(view.style.cursor).toBe("default");
  });

  it("shows a press indicator at mousedown, before any frame, until the frame after release", async () => {
    vi.useFakeTimers();
    const s = setup();
    await vi.advanceTimersByTimeAsync(0);
    const sock = s.sock();
    sock.open();
    sock.push(state({ control: "user" }));
    const w = s.dom.window;
    const view = $(s, "view");
    view.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 300 }) as DOMRect;
    const press = $(s, "press");
    expect(press.hidden).toBe(true);
    view.dispatchEvent(new w.MouseEvent("mousedown", { clientX: 40, clientY: 30, bubbles: true }));
    expect(press.hidden).toBe(false);
    expect([press.style.left, press.style.top]).toEqual(["40px", "30px"]);
    // a frame while the button is still down keeps it
    sock.pushFrame(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(press.hidden).toBe(false);
    w.dispatchEvent(new w.MouseEvent("mouseup", { clientX: 40, clientY: 30 }));
    expect(press.hidden).toBe(false);
    sock.pushFrame(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(press.hidden).toBe(true);
    // no frame comes back: it goes after a second
    view.dispatchEvent(new w.MouseEvent("mousedown", { clientX: 40, clientY: 30, bubbles: true }));
    w.dispatchEvent(new w.MouseEvent("mouseup", { clientX: 40, clientY: 30 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(press.hidden).toBe(true);
  });

  it("a drag released outside the picture still sends the button up", async () => {
    const s = setup();
    const sock = await live(s, state({ control: "user" }));
    const w = s.dom.window;
    const view = $(s, "view");
    view.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 300 }) as DOMRect;
    view.dispatchEvent(new w.MouseEvent("mousedown", { clientX: 10, clientY: 10, bubbles: true }));
    w.document.body.dispatchEvent(
      new w.MouseEvent("mousemove", { clientX: 900, clientY: 10, bubbles: true }),
    );
    w.dispatchEvent(new w.MouseEvent("mouseup", { clientX: 900, clientY: 10 }));
    expect(sock.sent).toContainEqual({ t: "mouse", kind: "move", x: 1280, y: 27 });
    expect(sock.sent.at(-1)).toEqual({ t: "mouse", kind: "up", x: 1280, y: 27, button: "left" });
  });

  it("takeover moves the focus to the input sink; IME text goes once, at compositionend", async () => {
    const s = setup();
    const sock = await live(s);
    const w = s.dom.window;
    $(s, "takeover").click();
    sock.push(state({ control: "user" }));
    const sink = $(s, "input-sink") as HTMLTextAreaElement;
    expect(w.document.activeElement).toBe(sink);
    // keys the IME takes are not sent as keys
    sink.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Process", bubbles: true }));
    sink.dispatchEvent(
      new w.KeyboardEvent("keydown", { key: "n", isComposing: true, bubbles: true }),
    );
    sink.value = "ni";
    sink.dispatchEvent(
      new w.InputEvent("input", { isComposing: true, inputType: "insertCompositionText" }),
    );
    sink.value = "你";
    sink.dispatchEvent(new w.CompositionEvent("compositionend", { data: "你" }));
    sink.dispatchEvent(new w.InputEvent("input", { inputType: "insertText" }));
    const keys = sock.sent.filter((m) => m.t === "key");
    expect(keys).toEqual([{ t: "key", kind: "char", key: "你", text: "你" }]);
    expect(sink.value).toBe("");
    // a printable key outside a composition goes as a key (it types its character)
    sink.dispatchEvent(new w.KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true }));
    expect(sock.sent.at(-1)).toEqual({ t: "key", kind: "down", key: "a", code: "KeyA" });
  });

  it("releases held keys and the held button when the window loses the focus", async () => {
    const s = setup();
    const sock = await live(s, state({ control: "user" }));
    const w = s.dom.window;
    const view = $(s, "view");
    view.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 300 }) as DOMRect;
    const sink = $(s, "input-sink");
    sink.dispatchEvent(
      new w.KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", bubbles: true }),
    );
    view.dispatchEvent(
      new w.MouseEvent("mousedown", { clientX: 240, clientY: 150, bubbles: true }),
    );
    w.dispatchEvent(new w.Event("blur"));
    expect(sock.sent.slice(-2)).toEqual([
      { t: "key", kind: "up", key: "Shift", code: "ShiftLeft" },
      { t: "mouse", kind: "up", x: 640, y: 400, button: "left" },
    ]);
    // nothing is released twice
    w.dispatchEvent(new w.Event("blur"));
    expect(sock.sent.filter((m) => m.t === "key" && m.kind === "up")).toHaveLength(1);
  });

  it("the input sink gives up the focus when control returns to the agent", async () => {
    const s = setup();
    const sock = await live(s);
    $(s, "takeover").click();
    sock.push(state({ control: "user" }));
    const sink = $(s, "input-sink");
    expect(s.dom.window.document.activeElement).toBe(sink);
    sock.push(state({ control: "agent" }));
    expect(s.dom.window.document.activeElement).not.toBe(sink);
  });

  it("a hand back cancels an allow's pending reopen: a reconnect does not take over again", async () => {
    vi.useFakeTimers();
    const s = setup();
    await vi.advanceTimersByTimeAsync(0);
    const sock = s.sock();
    sock.open();
    sock.push(state({ control: "user" }));
    sock.push({ t: "blocked", host: "cdn.test", url: "https://cdn.test/page" });
    $(s, "allow").click();
    await vi.advanceTimersByTimeAsync(0);
    $(s, "handback").click();
    sock.drop(1012);
    await vi.advanceTimersByTimeAsync(0);
    const sock2 = s.sock();
    expect(sock2).not.toBe(sock);
    sock2.open();
    sock2.push(state({ tabs: [{ id: "t1", title: "", url: "about:blank", active: true }] }));
    expect(sock2.sent.some((m) => m.t === "takeover" || m.t === "nav")).toBe(false);
  });

  it("clips pasted text by code points, never half of a surrogate pair", () => {
    expect(clipCodePoints("ab😀c", 3)).toBe("ab😀");
    expect(clipCodePoints("ab", 3)).toBe("ab");
    expect(Array.from(clipCodePoints("😀".repeat(5), 4))).toHaveLength(4);
  });

  it("paste sends the clipboard text, not the Cmd+V keys", async () => {
    const s = setup();
    const sock = await live(s, state({ control: "user" }));
    const w = s.dom.window;
    const sink = $(s, "input-sink");
    sink.dispatchEvent(new w.KeyboardEvent("keydown", { key: "v", metaKey: true, bubbles: true }));
    sink.dispatchEvent(new w.KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }));
    const paste = new w.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? "粘贴 text" : "") },
    });
    sink.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(sock.sent.filter((m) => m.t === "key")).toEqual([
      { t: "key", kind: "char", key: "粘贴 text", text: "粘贴 text" },
    ]);
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
    const sock = await live(s, state({ control: "user" }));
    const url = $(s, "url") as HTMLInputElement;
    url.value = "https://news.test/";
    url.dispatchEvent(new s.dom.window.KeyboardEvent("keydown", { key: "Enter" }));
    expect(sock.sent).toContainEqual({ t: "nav", url: "https://news.test/" });
  });

  it("back, forward and reload send nav actions", async () => {
    const s = setup();
    const sock = await live(s, state({ control: "user" }));
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
    const sock = await live(s, state({ control: "user" }));
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
    sock.push(state({ control: "user" }));
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
    // the restarted daemon starts with the agent in control: the panel takes over again first
    sock3.push(state({ tabs: [{ id: "t1", title: "", url: "about:blank", active: true }] }));
    const takeover = sock3.sent.findIndex((m) => m.t === "takeover");
    const nav = sock3.sent.findIndex((m) => m.t === "nav" && m.url === "https://cdn.test/page");
    expect(takeover).toBeGreaterThanOrEqual(0);
    expect(nav).toBeGreaterThan(takeover);
  });

  it("a 4404 before any live view is the empty state at once, not a reconnect loop", async () => {
    vi.useFakeTimers();
    const s = setup({ locale: "zh" });
    await vi.advanceTimersByTimeAsync(0);
    s.sock().drop(4404);
    expect(($(s, "empty") as HTMLElement).hidden).toBe(false);
    expect($(s, "empty-title").textContent).toBe("浏览器尚未运行");
    expect($(s, "status").textContent).toBe("");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("the empty state looks again quietly and shows the browser once it runs", async () => {
    vi.useFakeTimers();
    const s = setup();
    await vi.advanceTimersByTimeAsync(0);
    s.sock().drop(4404);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.all).toHaveLength(2);
    // the look keeps the empty state up (no "Connecting…" with a blank frame)
    expect(($(s, "empty") as HTMLElement).hidden).toBe(false);
    expect($(s, "status").textContent).toBe("");
    s.sock().drop(4404);
    expect(($(s, "empty") as HTMLElement).hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.all).toHaveLength(3);
    const sock = s.sock();
    sock.open();
    sock.push(state());
    // one switch: the idle state holds until the browser's first frame, no skeleton between
    expect(($(s, "empty") as HTMLElement).hidden).toBe(false);
    expect(($(s, "skeleton") as HTMLElement).hidden).toBe(true);
    sock.pushFrame(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(($(s, "empty") as HTMLElement).hidden).toBe(true);
    expect($(s, "app").hasAttribute("data-idle")).toBe(false);
    expect(($(s, "takeover") as HTMLElement).hidden).toBe(false);
  });

  it("the idle states (not running, offline, error) are the idle layer alone", async () => {
    for (const [code, title] of [
      [4404, "emptyTitle"],
      [4409, "offlineTitle"],
      [1009, "errorTitle"],
    ] as const) {
      const s = setup();
      await vi.waitFor(() => expect(FakeSocket.all.length).toBe(1));
      s.sock().drop(code);
      expect(($(s, "empty") as HTMLElement).hidden).toBe(false);
      expect($(s, "empty-title").textContent).toBe(t("en", title));
      // no tab strip, toolbar or status line beside it: the live layer is hidden as a whole
      expect($(s, "app").hasAttribute("data-idle")).toBe(true);
      expect(($(s, "skeleton") as HTMLElement).hidden).toBe(true);
      expect($(s, "empty").closest("#app")).toBeNull();
    }
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

  it("a quiet look that hangs does not end the looking", async () => {
    vi.useFakeTimers();
    const s = setup();
    await vi.advanceTimersByTimeAsync(0);
    s.sock().drop(4404);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.all).toHaveLength(2);
    // the second socket never opens nor closes; the next look replaces it
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.all).toHaveLength(3);
    expect((FakeSocket.all[1] as FakeSocket).closed).toBe(true);
    expect(($(s, "empty") as HTMLElement).hidden).toBe(false);
  });

  it("a quiet look retries a 4401 with a new ticket and shows a 4409 as offline", async () => {
    vi.useFakeTimers();
    const s = setup();
    await vi.advanceTimersByTimeAsync(0);
    s.sock().drop(4404);
    await vi.advanceTimersByTimeAsync(10_000);
    s.sock().drop(4401);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.all).toHaveLength(3);
    expect(($(s, "empty") as HTMLElement).hidden).toBe(false);
    expect($(s, "status").textContent).toBe("");
    s.sock().drop(4409);
    expect($(s, "empty-title").textContent).toBe(t("en", "offlineTitle"));
  });

  it("coming back from a hidden tab in the empty state looks quietly", async () => {
    vi.useFakeTimers();
    const s = setup();
    await vi.advanceTimersByTimeAsync(0);
    s.sock().drop(4404);
    const doc = s.dom.window.document;
    let vis = "hidden";
    Object.defineProperty(doc, "visibilityState", { get: () => vis, configurable: true });
    doc.dispatchEvent(new s.dom.window.Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(61_000);
    vis = "visible";
    doc.dispatchEvent(new s.dom.window.Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.all).toHaveLength(2);
    expect(($(s, "empty") as HTMLElement).hidden).toBe(false);
    expect($(s, "status").textContent).toBe("");
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

  it("a phone (the host's compact size class) is watch-only", async () => {
    const s = setup({ width: 390, screen: 390 });
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

describe("panel size", () => {
  it("never posts resize: the host fills the panel and the picture is contained in it", async () => {
    const s = setup({ dpr: 1 });
    const sock = await live(s);
    s.resizeStage(320, 400);
    s.resizeStage(1000, 300);
    expect(resizes(s)).toHaveLength(0);
    // contained: 1000x300 fits a 480x300 picture, centred by the stage
    expect($(s, "view").style.width).toBe("480px");
    expect($(s, "view").style.height).toBe("300px");
    expect(sock.sent.at(-1)).toEqual({ t: "resize", maxWidth: 480, maxHeight: 300 });
  });

  it("the viewer size follows the shown size in full mode, and the side cap after it", async () => {
    const s = setup({ dpr: 1 });
    const sock = await live(s);
    $(s, "takeover").click();
    sock.push(state({ control: "user" }));
    hostMode(s, true);
    // the host fills the page: 1000x700 letterboxes to 1000x625, the viewer size follows it
    s.resizeStage(1000, 700);
    expect(sock.sent.at(-1)).toEqual({ t: "resize", maxWidth: 1000, maxHeight: 625 });
    expect($(s, "view").style.width).toBe("1000px");
    $(s, "handback").click();
    sock.push(state({ control: "agent" }));
    hostMode(s, false);
    expect(sock.sent.at(-1)).toEqual({ t: "resize", maxWidth: 640, maxHeight: 400 });
  });

  it("follows the host leaving full mode on its own (its Esc or close), asking nothing back", async () => {
    const s = setup({ dpr: 1 });
    const sock = await live(s);
    $(s, "takeover").click();
    sock.push(state({ control: "user" }));
    hostMode(s, true);
    const asks = modes(s).length;
    hostMode(s, false);
    expect(modes(s)).toHaveLength(asks);
    expect(($(s, "handback") as HTMLElement).hidden).toBe(false);
  });

  it("leaves full mode when the take over ends elsewhere", async () => {
    const s = setup();
    const sock = await live(s);
    $(s, "takeover").click();
    sock.push(state({ control: "user" }));
    hostMode(s, true);
    // another panel handed back: control returns to the agent without this panel's hand back
    sock.push(state({ control: "agent" }));
    expect(modes(s).at(-1)).toEqual({
      protocol: "capybara-embed/1",
      type: "panel-mode",
      full: false,
    });
    hostMode(s, false);
    // a state of the agent before the take over lands does not leave full mode
    $(s, "takeover").click();
    sock.push(state({ control: "agent" }));
    expect(modes(s).at(-1)).toMatchObject({ full: true });
  });
});

describe("design states", () => {
  it("is one skeleton until the state and the first frame are there, then switches once", async () => {
    const s = setup();
    expect(($(s, "skeleton") as HTMLElement).hidden).toBe(false);
    expect($(s, "app").hasAttribute("data-loading")).toBe(true);
    const sock = await live(s);
    // the state alone is not enough: still the skeleton
    expect(($(s, "skeleton") as HTMLElement).hidden).toBe(false);
    sock.pushFrame(1);
    await vi.waitFor(() => expect(($(s, "skeleton") as HTMLElement).hidden).toBe(true));
    expect($(s, "app").hasAttribute("data-loading")).toBe(false);
    expect(s.dom.window.document.body.hasAttribute("data-ready")).toBe(true);
  });

  it("not running shows at once, without the skeleton", async () => {
    const s = setup({
      ticket: () => new Response(JSON.stringify({ code: "service_not_running" }), { status: 409 }),
    });
    await vi.waitFor(() => expect(($(s, "empty") as HTMLElement).hidden).toBe(false));
    expect(($(s, "skeleton") as HTMLElement).hidden).toBe(true);
  });

  it("the takeover slot is reserved before the view is live and at any width", async () => {
    const s = setup({ width: 320 });
    expect($(s, "takeover").hasAttribute("data-gone")).toBe(false);
    await live(s);
    expect(($(s, "takeover") as HTMLElement).hidden).toBe(false);
  });

  it("a narrow panel merges tabs and address into one button with the tab count", async () => {
    const s = setup({ width: 360 });
    // the tabs menu is for the person in control (the watch state is read-only)
    await live(
      s,
      state({
        control: "user",
        tabs: [
          { id: "t1", title: "News", url: "https://news.example.com/world", active: true },
          { id: "t2", title: "Search", url: "https://search.example.com/", active: false },
        ],
      }),
    );
    expect($(s, "tabsbtn-name").textContent).toBe("news.example.com");
    expect($(s, "tabsbtn-count").textContent).toBe("2");
    $(s, "tabsbtn").click();
    const items = Array.from($(s, "menu").querySelectorAll("button")).map((b) => b.textContent);
    expect(items).toEqual(["News", "Search", t("en", "newTab")]);
    $(s, "more").click();
    const more = Array.from($(s, "menu").querySelectorAll("button")).map((b) => b.textContent);
    expect(more).toEqual([t("en", "forward"), t("en", "reload")]);
  });

  it("the status line: the agent at work, and the person in control with the frame's accent ring", async () => {
    const s = setup();
    const sock = await live(s, state({ loading: true }));
    expect($(s, "status").getAttribute("data-tone")).toBe("agent");
    expect($(s, "status").textContent).toBe(
      `${t("en", "statusAgent")} · ${t("en", "statusLoading")}`,
    );
    sock.push(state({ control: "user" }));
    expect($(s, "status").getAttribute("data-tone")).toBe("user");
    expect($(s, "stage").getAttribute("data-control")).toBe("user");
  });

  it("the status line shows a parked long wait: what the agent waits for and until when", async () => {
    const s = setup();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await live(s, state({ waiting: { label: 'text "Paid"', until } }));
    const time = new Date(until).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
    expect($(s, "status").textContent).toBe(
      `${t("en", "statusWaiting")} · text "Paid" (${t("en", "statusWaitingUntil")} ${time})`,
    );
  });

  it("a page that asks for a human check shows the verify strip; 去验证 takes over", async () => {
    const s = setup();
    const url = "https://search.example.com/verify";
    const sock = await live(
      s,
      state({
        tabs: [
          { id: "t1", title: "Check", url, active: true, blocker: { kind: "verification", url } },
          { id: "t2", title: "Other", url: "https://other.example.com/", active: false },
        ],
      }),
    );
    expect(($(s, "verify") as HTMLElement).hidden).toBe(false);
    expect(($(s, "status") as HTMLElement).hidden).toBe(true);
    // one primary: take over steps back while verification waits
    expect($(s, "takeover").className).toBe("secondary");
    $(s, "verify-go").click();
    expect(sock.sent).toContainEqual({ t: "takeover" });
  });

  it("a blank tab is labelled as a new tab, not about:blank", async () => {
    const s = setup();
    await live(
      s,
      state({
        tabs: [
          { id: "t1", title: "", url: "about:blank", active: true },
          { id: "t2", title: "", url: "https://b.example/x", active: false },
        ],
      }),
    );
    const labels = Array.from($(s, "tabs").querySelectorAll(".tab .label")).map(
      (l) => l.textContent,
    );
    expect(labels).toEqual(["New tab", "https://b.example/x"]);
  });

  it("tabs show the site's icon, and the globe glyph without a usable one", async () => {
    const s = setup();
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    await live(
      s,
      state({
        tabs: [
          { id: "t1", title: "A", url: "https://a.example/", active: true, favicon: png },
          { id: "t2", title: "B", url: "https://b.example/", active: false },
          {
            id: "t3",
            title: "C",
            url: "https://c.example/",
            active: false,
            favicon: "javascript:alert(1)",
          },
        ],
      }),
    );
    const favs = Array.from($(s, "tabs").querySelectorAll(".tab .fav"));
    expect(favs.map((f) => f.tagName)).toEqual(["IMG", "SPAN", "SPAN"]);
    expect((favs[0] as HTMLImageElement).getAttribute("src")).toBe(png);
    // never an empty square: the globe glyph in the slot
    expect(favs.slice(1).map((f) => f.getAttribute("data-glyph"))).toEqual(["site", "site"]);
    expect(favs.slice(1).every((f) => f.querySelector("svg") !== null)).toBe(true);
    // the narrow tabs button shows the active tab's icon too
    expect($(s, "tabsbtn").querySelector("img.fav")?.getAttribute("src")).toBe(png);
  });

  it("a loading tab spins in its icon slot; its icon replaces the glyph in the same slot", async () => {
    const s = setup();
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const tab = { id: "t1", title: "Baidu", url: "https://www.baidu.com/", active: true };
    const sock = await live(s, state({ tabs: [{ ...tab, loading: true }] }));
    const slot = () => $(s, "tabs").querySelector(".tab .fav") as HTMLElement;
    expect(slot().getAttribute("data-glyph")).toBe("loading");
    expect($(s, "tabsbtn").querySelector(".fav")?.getAttribute("data-glyph")).toBe("loading");
    // loaded, no icon yet: the globe
    sock.push(state({ tabs: [tab] }));
    expect(slot().getAttribute("data-glyph")).toBe("site");
    // the icon arrives: an <img> of the same slot class (no layout shift)
    sock.push(state({ tabs: [{ ...tab, favicon: png }] }));
    expect(slot().tagName).toBe("IMG");
    expect(slot().className).toBe("fav");
  });

  it("only the active tab's blocker shows the verify strip", async () => {
    const s = setup();
    const url = "https://search.example.com/verify";
    await live(
      s,
      state({
        tabs: [
          { id: "t1", title: "News", url: "https://news.example.com/", active: true },
          { id: "t2", title: "Check", url, active: false, blocker: { kind: "verification", url } },
        ],
      }),
    );
    expect(($(s, "verify") as HTMLElement).hidden).toBe(true);
    expect(($(s, "status") as HTMLElement).hidden).toBe(false);
  });
});

describe("handoff banner", () => {
  const handoff = { callId: "call-1", conversationId: "c1", message: "Log in", tabIds: ["t1"] };

  it("shows the banner from state.handoff and hides it when absent", async () => {
    const s = setup();
    const sock = await live(s, state({ handoffs: [handoff] }));
    expect(($(s, "handoff") as HTMLElement).hidden).toBe(false);
    expect($(s, "handoff-message").textContent).toBe("Log in");
    sock.push(state());
    expect(($(s, "handoff") as HTMLElement).hidden).toBe(true);
  });

  it("done and cancel post handoff-answer", async () => {
    const s = setup();
    await live(s, state({ handoffs: [handoff] }));
    $(s, "handoff-done").click();
    await vi.waitFor(() =>
      expect(s.fetchCalls.find((c) => c.url === "handoff-answer")?.body).toEqual({
        callId: "call-1",
        done: true,
        handoffConversationId: "c1",
      }),
    );
    $(s, "handoff-cancel").click();
    await vi.waitFor(() =>
      expect(s.fetchCalls.filter((c) => c.url === "handoff-answer")[1]?.body).toEqual({
        callId: "call-1",
        done: false,
        handoffConversationId: "c1",
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
    const sock = await live(s, state({ handoffs: [handoff] }));
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
    await live(s, state({ handoffs: [handoff] }));
    $(s, "handoff-done").click();
    await vi.waitFor(() => expect(($(s, "notice") as HTMLElement).hidden).toBe(false));
    expect($(s, "notice").textContent).toContain(t("en", "answerFailed"));
    expect($(s, "notice").textContent).toContain("The device is gone.");
    expect(($(s, "handoff") as HTMLElement).hidden).toBe(false);
  });

  it("handing back with a pending handoff answers it Done", async () => {
    const s = setup();
    const sock = await live(s, state({ control: "user", handoffs: [handoff] }));
    $(s, "handback").click();
    expect(sock.sent).toContainEqual({ t: "handback" });
    await vi.waitFor(() =>
      expect(s.fetchCalls.find((c) => c.url === "handoff-answer")?.body).toEqual({
        callId: "call-1",
        done: true,
        handoffConversationId: "c1",
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
    const s = setup({ width: 390, screen: 390 });
    await live(s, state({ handoffs: [handoff] }));
    expect(($(s, "handoff") as HTMLElement).hidden).toBe(false);
    $(s, "handoff-done").click();
    await vi.waitFor(() => expect(s.fetchCalls.some((c) => c.url === "handoff-answer")).toBe(true));
  });
});

describe("tab ownership", () => {
  const tree: TabIn[] = [
    { id: "t1", title: "Docs", url: "https://docs.example/", active: true },
    { id: "t2", title: "Mail", url: "https://mail.example/", active: false },
    { id: "t3", title: "Shop", url: "https://shop.example/", active: false, group: "sub1" },
    { id: "t4", title: "Maps", url: "https://maps.example/", active: false, group: "sub2" },
  ];
  const others = [
    { id: "t7", title: "Portal", url: "https://portal.example/login" },
    { id: "t8", title: "", url: "about:blank" },
  ];
  const stripItems = (s: Setup) =>
    Array.from($(s, "tablist").children).map((el) =>
      el.classList.contains("group")
        ? `[${el.textContent}]`
        : el.classList.contains("tab")
          ? `${el.querySelector(".label")?.textContent}${el.getAttribute("data-active") === "true" ? "*" : ""}`
          : (el.getAttribute("aria-label") ?? ""),
    );
  const menuItems = (s: Setup) =>
    Array.from($(s, "menu").children).map((el) =>
      el.classList.contains("heading")
        ? `[${el.textContent}]`
        : `${el.querySelector(".name")?.textContent}${el.querySelector(".hint") ? ` > ${el.querySelector(".hint")?.textContent}` : ""}`,
    );
  const sentOf = (sock: FakeSocket) =>
    sock.sent.filter((m) => !["hello", "resize", "frame-ack", "pong"].includes(m.t));

  it("the strip shows the own tabs, then one labelled group per sub-task", async () => {
    const s = setup();
    await live(s, state({ tabs: tree }));
    expect(stripItems(s)).toEqual([
      "Docs*",
      "Mail",
      "[Sub-task 1]",
      "Shop",
      "[Sub-task 2]",
      "Maps",
    ]);
    // one sub-task needs no number
    const one = setup({ locale: "zh" });
    await live(one, state({ tabs: tree.slice(0, 3) }));
    expect(stripItems(one)).toEqual(["Docs*", "Mail", "[子任务]", "Shop"]);
    // a group keeps its number when an earlier one closes
    const later = setup();
    await live(
      later,
      state({
        tabs: [
          ...tree.slice(0, 2),
          tree[3] as TabIn,
          { id: "t5", title: "Pay", url: "https://pay.example/", active: false, group: "sub3" },
        ],
      }),
    );
    expect(stripItems(later)).toEqual([
      "Docs*",
      "Mail",
      "[Sub-task 2]",
      "Maps",
      "[Sub-task 3]",
      "Pay",
    ]);
  });

  it("while only watching, a click on a tab of the tree shows it (show, never switch)", async () => {
    const s = setup();
    const sock = await live(s, state({ tabs: tree }));
    const label = (name: string) =>
      Array.from($(s, "tablist").querySelectorAll(".tab .label")).find(
        (l) => l.textContent === name,
      ) as HTMLButtonElement;
    label("Shop").click();
    // the shown tab already is shown: nothing to send
    label("Docs").click();
    expect(sentOf(sock)).toEqual([{ t: "show", tabId: "t3" }]);
    // the daemon's next state marks it, and the address follows
    sock.push(state({ tabs: tree.map((x) => ({ ...x, active: x.id === "t3" })), shown: "t3" }));
    expect(stripItems(s)).toContain("Shop*");
    expect(($(s, "url") as HTMLInputElement).value).toBe("https://shop.example/");
  });

  it("the other conversations' menu entries carry the globe glyph (they have no icons)", async () => {
    const s = setup();
    await live(s, state({ tabs: tree, otherTabs: others }));
    $(s, "others").click();
    const entries = Array.from($(s, "menu").querySelectorAll("button"));
    expect(entries.length).toBe(others.length);
    expect(entries.every((b) => b.querySelector('.fav[data-glyph="site"] svg') !== null)).toBe(
      true,
    );
  });

  it("a watching panel never sends tab open, close or switch", async () => {
    const s = setup();
    const sock = await live(s, state({ tabs: tree, otherTabs: others }));
    // no close or new-tab buttons while only watching
    expect($(s, "tablist").querySelector(".x")).toBeNull();
    expect($(s, "tablist").querySelector(".add")).toBeNull();
    for (const l of Array.from($(s, "tablist").querySelectorAll(".tab .label")))
      (l as HTMLButtonElement).click();
    // the narrow tabs menu offers no new tab while watching either
    $(s, "tabsbtn").click();
    const items = Array.from($(s, "menu").querySelectorAll("button"));
    expect(items.map((b) => b.textContent)).not.toContain("New tab");
    for (const b of items) b.click();
    const tabMsgs = sentOf(sock).filter((m) => m.t === "tab");
    expect(tabMsgs.every((m) => (m as { action?: string }).action === "adopt")).toBe(true);
    expect(sentOf(sock).filter((m) => m.t !== "tab" && m.t !== "show")).toEqual([]);
  });

  it("a 404 hides the banner only when it still shows that handoff (callIds repeat across sub-agents)", async () => {
    let release: (r: Response) => void = () => {};
    const s = setup({
      answer: () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    });
    const sub = { callId: "call-1", conversationId: "c2", message: "Pay", tabIds: ["t3"] };
    const own = { callId: "call-1", conversationId: "c1", message: "Sign in", tabIds: ["t1"] };
    const sock = await live(s, state({ tabs: tree, handoffs: [own, sub] }));
    $(s, "handoff-done").click();
    await vi.waitFor(() => expect(s.fetchCalls.some((c) => c.url === "handoff-answer")).toBe(true));
    // meanwhile the sub-agent's handoff ended and the root's own (same callId) is the newest
    sock.push(state({ tabs: tree, handoffs: [own] }));
    release(
      new Response(JSON.stringify({ error: { code: "question.not_found", message: "x" } }), {
        status: 404,
      }),
    );
    // let the answer's continuation run (one macrotask turn, no timed wait)
    await new Promise((r) => setTimeout(r, 0));
    expect(($(s, "handoff") as HTMLElement).hidden).toBe(false);
    expect($(s, "handoff-message").textContent).toBe("Sign in");
  });

  it("in control, a click on a tab switches to it", async () => {
    const s = setup();
    const sock = await live(s, state({ tabs: tree, control: "user" }));
    (
      Array.from($(s, "tablist").querySelectorAll(".tab .label")).find(
        (l) => l.textContent === "Shop",
      ) as HTMLButtonElement
    ).click();
    expect(sentOf(sock)).toEqual([{ t: "tab", action: "switch", tabId: "t3" }]);
  });

  it("other conversations' tabs are a menu; Move here adopts one, also while only watching", async () => {
    const s = setup();
    const sock = await live(s, state({ tabs: tree, otherTabs: others }));
    expect(($(s, "others") as HTMLElement).hidden).toBe(false);
    expect($(s, "others").textContent).toBe("Other conversations (2)");
    $(s, "others").click();
    expect(menuItems(s)).toEqual([
      "[Other conversations (2)]",
      "Portal > Move here",
      "New tab > Move here",
    ]);
    ($(s, "menu").querySelector("button") as HTMLButtonElement).click();
    expect(sentOf(sock)).toEqual([{ t: "tab", action: "adopt", tabId: "t7" }]);
    expect(($(s, "menu") as HTMLElement).hidden).toBe(true);
    // no other conversations: no menu button
    sock.push(state({ tabs: tree }));
    expect(($(s, "others") as HTMLElement).hidden).toBe(true);
  });

  it("the zh menu says 其他对话 and 移到此对话", async () => {
    const s = setup({ locale: "zh" });
    await live(s, state({ tabs: tree, otherTabs: others.slice(0, 1) }));
    expect($(s, "others").textContent).toBe("其他对话 (1)");
    $(s, "others").click();
    expect(menuItems(s)).toEqual(["[其他对话 (1)]", "Portal > 移到此对话"]);
  });

  it("a narrow panel's tabs menu groups the tree, shows on a pick while watching, and lists the others", async () => {
    const s = setup({ width: 360 });
    const sock = await live(s, state({ tabs: tree.slice(0, 3), otherTabs: others.slice(0, 1) }));
    $(s, "tabsbtn").click();
    // no new tab while only watching
    expect(menuItems(s)).toEqual([
      "Docs",
      "Mail",
      "[Sub-task]",
      "Shop",
      "[Other conversations (1)]",
      "Portal > Move here",
    ]);
    (
      Array.from($(s, "menu").querySelectorAll("button")).find(
        (b) => b.textContent === "Shop",
      ) as HTMLButtonElement
    ).click();
    expect(sentOf(sock)).toEqual([{ t: "show", tabId: "t3" }]);
  });

  it("the shown tab follows a new handoff, and the banner shows the newest", async () => {
    const s = setup();
    const sock = await live(s, state({ tabs: tree }));
    const older = { callId: "call-1", conversationId: "c1", message: "Sign in", tabIds: ["t1"] };
    const newer = { callId: "call-1", conversationId: "c2", message: "Pay", tabIds: ["t3"] };
    // the daemon moves the viewer's shown tab to the asking sub-agent's active tab
    sock.push(
      state({
        tabs: tree.map((x) => ({ ...x, active: x.id === "t3" })),
        shown: "t3",
        handoffs: [older, newer],
      }),
    );
    expect(stripItems(s)).toContain("Shop*");
    expect($(s, "handoff-message").textContent).toBe("Pay");
  });

  it("Done on a sub-agent's handoff echoes its conversation", async () => {
    const s = setup();
    await live(
      s,
      state({
        tabs: tree,
        handoffs: [
          { callId: "call-1", conversationId: "c1", message: "Sign in", tabIds: ["t1"] },
          { callId: "call-1", conversationId: "c2", message: "Pay", tabIds: ["t3"] },
        ],
      }),
    );
    $(s, "handoff-done").click();
    await vi.waitFor(() =>
      expect(s.fetchCalls.find((c) => c.url === "handoff-answer")?.body).toEqual({
        callId: "call-1",
        done: true,
        handoffConversationId: "c2",
      }),
    );
  });

  it("a refused Move here shows a short notice that goes away by itself", async () => {
    vi.useFakeTimers();
    const s = setup();
    await vi.advanceTimersByTimeAsync(0);
    const sock = s.sock();
    sock.open();
    sock.push(state({ tabs: tree, otherTabs: others }));
    sock.push({ t: "notice", code: "tab_in_use" });
    expect(($(s, "notice") as HTMLElement).hidden).toBe(false);
    expect($(s, "notice").textContent).toBe(
      "Another conversation is using this tab; try again shortly",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(($(s, "notice") as HTMLElement).hidden).toBe(true);
    sock.push({ t: "notice", code: "tab_cap" });
    expect($(s, "notice").textContent).toBe(
      "This conversation has the most tabs it can keep; close one first",
    );
  });

  it("the tree's empty state: no page of another tree, its tabs to move here", async () => {
    const s = setup();
    const sock = await live(s, state({ tabs: [], otherTabs: others.slice(0, 1) }));
    sock.pushFrame(1);
    await vi.waitFor(() => expect(sock.sent.some((m) => m.t === "frame-ack")).toBe(true));
    expect(($(s, "empty") as HTMLElement).hidden).toBe(false);
    expect($(s, "app").hasAttribute("data-idle")).toBe(true);
    expect($(s, "empty-title").textContent).toBe(
      "The agent has not opened a page in this conversation yet",
    );
    expect(($(s, "reconnect") as HTMLElement).hidden).toBe(true);
    expect(($(s, "empty-others") as HTMLElement).hidden).toBe(false);
    expect($(s, "empty-others").textContent).toBe("Other conversations (1)");
    $(s, "empty-others").click();
    expect(menuItems(s)).toEqual(["[Other conversations (1)]", "Portal > Move here"]);
    ($(s, "menu").querySelector("button") as HTMLButtonElement).click();
    expect(sentOf(sock)).toEqual([{ t: "tab", action: "adopt", tabId: "t7" }]);
    // the moved tab arrives: the empty state holds until its first frame, then the live panel
    sock.push(
      state({
        tabs: [{ id: "t7", title: "Portal", url: "https://portal.example/", active: true }],
      }),
    );
    expect(($(s, "empty") as HTMLElement).hidden).toBe(false);
    sock.pushFrame(2);
    await vi.waitFor(() => expect(($(s, "empty") as HTMLElement).hidden).toBe(true));
    expect($(s, "app").hasAttribute("data-idle")).toBe(false);
  });

  it("the tree's empty state without other conversations offers no menu (zh)", async () => {
    const s = setup({ locale: "zh" });
    await live(s, state({ tabs: [] }));
    expect($(s, "empty-title").textContent).toBe("智能体尚未在此对话中打开网页");
    expect(($(s, "empty-others") as HTMLElement).hidden).toBe(true);
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
        // page data: the address, the tabs (and the narrow tabs button), the blocked host
        if (
          el.id === "url" ||
          el.closest("#tabs, #tabsbtn, #urltext") !== null ||
          el.id === "blocked-host"
        )
          continue;
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
      for (const text of texts) {
        // the status detail is an i18n string after a separator
        const bare = text.replace(/^· /, "");
        expect(known.has(bare), `${locale}: ${text}`).toBe(true);
      }
      if (locale === "zh") expect(texts.join(" ")).not.toMatch(/agent|企业/i);
    }
  });
});
